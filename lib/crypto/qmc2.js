// QQ 音乐 QMC v2 解密器（.mflac / .mgg / .qmcflac / .qmc0 …）
//
// v2 和 v1 的根本区别：**密钥不再硬编码，而是跟着文件走**
//   文件尾部有一个「尾包」，里面要么直接带 EKey（base64），要么只有资源元数据。
//
// 尾包四种形态
//   QTag        安卓端，尾包内嵌 EKey                    → ✅ 能离线解
//   PcV1Legacy  PC 端老格式，小端长度 + base64 EKey      → ✅ 能离线解
//   STag        安卓端，**只有资源元数据、没有 EKey**    → ❌ 需要外部密钥
//   MusicEx     PC 新版，**没有 EKey**                   → ❌ 需要外部密钥
//
// EKey → 主密钥
//   1. 若以 base64("QQMusic EncV2,Key:") 开头：
//        base64 解码剩余部分 → TEA 解密（KEY1）→ TEA 解密（KEY2）→ 截到 NUL → 走第 2 步
//   2. 否则：base64 解码 → 前 8 字节是 header，其余是密文
//        tea_key = 交错(simple_key_8, header)  →  TEA 解密密文
//        主密钥 = header + 明文
//
// 主密钥 → 流密码
//   长度 ≤ 300  → MapStream：把长密钥压成 128 字节，再用 v1 那套变换
//   长度 >  300 → Rc4Stream：分段 RC4，段内偏移跳过若干字节
//
// 参考：HRuiCcc/music-geshizhuanhuan 的 qmc.py / ciphers.py（MIT）
//
// @module dsh-audio-converter/crypto/qmc2
'use strict'

import { sniffAudioFormat } from './ncm.js'
import { qmc1Transform, V1_STATIC_KEY, QMC_CONSTANTS } from './qmc.js'

/* ------------------------------------------------------------------ *
 * 浮点与 TEA
 * ------------------------------------------------------------------ */

/** 模拟 float32 往返（Python 里是靠 struct.pack/unpack 做的） */
const f32 = (x) => Math.fround(x)

const TEA_DELTA = 0x9e3779b9
const TEA_ROUNDS = 16
const TEA_SALT_LEN = 2
const TEA_ZERO_LEN = 7
const MASK32 = 0xffffffff

/**
 * EKey v1 用的 8 字节固定表。
 *
 * 注意这里**必须处处 fround** —— Python 参考实现是靠 float32 往返算出来的，
 * 直接用双精度算会得到不同的字节，整条密钥链就断了。
 * @returns {Uint8Array} 8 字节
 */
export function simpleKey8() {
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    const inner = f32(106.0 + f32(i * f32(0.1)))
    const value = Math.abs(Math.tan(f32(inner)))
    const scaled = f32(f32(value) * 100.0)
    out[i] = Math.max(0, Math.min(Math.trunc(scaled), 255))
  }
  return out
}

/**
 * TEA 的一轮混合函数（纯 32 位）。
 * @param {number} value
 * @param {number} s
 * @param {number} k1
 * @param {number} k2
 * @returns {number}
 */
function teaMix(value, s, k1, k2) {
  const left = (((value << 4) >>> 0) + k1) >>> 0
  const right = ((value >>> 5) + k2) >>> 0
  const mid = (s + value) >>> 0
  return (left ^ mid ^ right) >>> 0
}

/**
 * 解密一个 64 位大端块。
 * @param {bigint} block 64 位块
 * @param {number[]} keyWords 4 个 32 位密钥字
 * @returns {bigint} 64 位结果
 */
export function teaDecryptBlock(block, keyWords) {
  let hi = Number((block >> 32n) & 0xffffffffn)
  let lo = Number(block & 0xffffffffn)
  let s = (TEA_DELTA * TEA_ROUNDS) >>> 0
  for (let r = 0; r < TEA_ROUNDS; r++) {
    lo = (lo - teaMix(hi, s, keyWords[2], keyWords[3])) >>> 0
    hi = (hi - teaMix(lo, s, keyWords[0], keyWords[1])) >>> 0
    s = (s - TEA_DELTA) >>> 0
  }
  return (BigInt(hi) << 32n) | BigInt(lo)
}

/**
 * Tencent TEA 变种 CBC 解密，剥掉头尾填充。
 * @param {Buffer} ciphertext 密文，长度须为 8 的倍数且 ≥ 10
 * @param {Buffer} key16 16 字节密钥
 * @returns {Buffer} 明文
 */
export function teaCbcDecrypt(ciphertext, key16) {
  if (ciphertext.length % 8 !== 0 || ciphertext.length < 10) {
    throw new Error(`TEA: 非法密文长度 ${ciphertext.length}`)
  }
  const words = []
  for (let i = 0; i < 16; i += 4) words.push(key16.readUInt32BE(i))

  const plain = Buffer.allocUnsafe(ciphertext.length)
  let ivPrev = 0n
  let ivCur = 0n
  for (let i = 0; i < ciphertext.length; i += 8) {
    const block = ciphertext.readBigUInt64BE(i)
    const mixed = block ^ ivCur
    const nextIv = teaDecryptBlock(mixed, words)
    const chunk = nextIv ^ ivPrev
    plain.writeBigUInt64BE(chunk, i)
    ivPrev = block
    ivCur = nextIv
  }

  const pad = plain[0] & 0b111
  const bodyStart = 1 + pad + TEA_SALT_LEN
  const bodyEnd = ciphertext.length - TEA_ZERO_LEN
  for (let i = bodyEnd; i < plain.length; i++) {
    if (plain[i] !== 0) throw new Error('TEA: 尾部校验失败（密钥不对或数据损坏）')
  }
  if (bodyStart > bodyEnd) throw new Error('TEA: 填充长度非法')
  return plain.subarray(bodyStart, bodyEnd)
}

/* ------------------------------------------------------------------ *
 * EKey → 主密钥
 * ------------------------------------------------------------------ */

/** EKey v2 的前缀（文件里存的是它的 base64 形式） */
export const EKEY_V2_PREFIX = Buffer.from('QQMusic EncV2,Key:').toString('base64')
export const EKEY_V2_KEY1 = Buffer.from([0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40, 0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28])
export const EKEY_V2_KEY2 = Buffer.from([0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54])

const SIMPLE_KEY = simpleKey8()

/**
 * EKey v1 派生：base64 → 前 8 字节 header + 交错密钥 → TEA。
 * @param {Buffer|string} ekey EKey（base64 文本）
 * @returns {Buffer} 主密钥
 */
export function ekeyV1(ekey) {
  const text = Buffer.isBuffer(ekey) ? ekey.toString('latin1') : String(ekey)
  const decoded = Buffer.from(text, 'base64')
  if (decoded.length < 8) throw new Error('EKey v1: 解码后不足 8 字节')
  const header = decoded.subarray(0, 8)
  const cipher = decoded.subarray(8)

  const teaKey = Buffer.allocUnsafe(16)
  for (let i = 0; i < 8; i++) {
    teaKey[i * 2] = SIMPLE_KEY[i]
    teaKey[i * 2 + 1] = header[i]
  }
  return Buffer.concat([header, teaCbcDecrypt(cipher, teaKey)])
}

/**
 * 从 EKey 派生主密钥（自动识别 v2 双段格式）。
 * @param {Buffer|string} ekey EKey
 * @returns {Buffer} 主密钥
 */
export function deriveMasterKey(ekey) {
  const text = Buffer.isBuffer(ekey) ? ekey.toString('latin1') : String(ekey)
  if (text.startsWith(EKEY_V2_PREFIX)) {
    let payload = Buffer.from(text.slice(EKEY_V2_PREFIX.length), 'base64')
    payload = teaCbcDecrypt(payload, EKEY_V2_KEY1)
    payload = teaCbcDecrypt(payload, EKEY_V2_KEY2)
    const zero = payload.indexOf(0)
    return ekeyV1(zero === -1 ? payload : payload.subarray(0, zero))
  }
  return ekeyV1(text)
}

/* ------------------------------------------------------------------ *
 * 流密码
 * ------------------------------------------------------------------ */

const MAP_LEN = 128
const MAP_MAGIC = 71214
const RC4_FIRST_SEGMENT = 0x80
const RC4_SEGMENT = 0x1400
const RC4_STREAM_CACHE = RC4_SEGMENT + 512

/**
 * 把长密钥压成 128 字节的 Map 密钥。
 * @param {Uint8Array|Buffer} longKey 主密钥
 * @returns {Uint8Array} 128 字节
 */
export function compressKey(longKey) {
  const n = longKey.length
  if (n === 0) throw new Error('Map 密钥为空')
  const out = new Uint8Array(MAP_LEN)
  for (let i = 0; i < MAP_LEN; i++) {
    const idx = (i * i + MAP_MAGIC) % n
    const shift = (idx + 4) % 8
    const v = longKey[idx]
    out[i] = (((v << shift) | (v >>> shift)) & 0xff)
  }
  return out
}

/**
 * 长密钥散列（32 位饱和乘法）。
 * @param {Uint8Array|Buffer} key
 * @returns {bigint} 散列值
 */
export function qmc2Hash(key) {
  let h = 1n
  for (let i = 0; i < key.length; i++) {
    const v = key[i]
    if (v === 0) continue
    const nxt = (h * BigInt(v)) & 0xffffffffn
    if (nxt === 0n || nxt <= h) break
    h = nxt
  }
  return h
}

/**
 * RC4 分段密钥推导。
 * @param {number} segId 段号
 * @param {number} seed 种子
 * @param {bigint} h 密钥散列
 * @returns {number}
 */
export function segmentKey(segId, seed, h) {
  if (seed === 0) return 0
  const denom = (BigInt(segId + 1) * BigInt(seed)) & 0xffffffffffffffffn
  if (denom === 0n) return 0
  return Math.trunc((Number(h) / Number(denom)) * 100.0)
}

/** MapStream：短主密钥（≤300 字节）—— 压缩成 128 字节后走 v1 变换。 */
class MapStream {
  constructor(masterKey) {
    this.key = compressKey(masterKey)
  }
  decrypt(data, offset = 0) {
    return qmc1Transform(data, this.key, offset)
  }
}

/** Rc4Stream：长主密钥（>300 字节）—— 分段 RC4。 */
class Rc4Stream {
  constructor(masterKey) {
    this.key = Buffer.from(masterKey)
    const n = this.key.length
    const state = new Array(n)
    for (let i = 0; i < n; i++) state[i] = i & 0xff
    let j = 0
    for (let i = 0; i < n; i++) {
      j = (j + state[i] + this.key[i % n]) % n
      const tmp = state[i]; state[i] = state[j]; state[j] = tmp
    }
    this.state = state
    this.n = n
    this.i = 0
    this.j = 0
    this.hash = qmc2Hash(this.key)
    // 预生成一段密钥流，分段时按偏移切片
    this.keyStream = Buffer.allocUnsafe(RC4_STREAM_CACHE)
    for (let k = 0; k < RC4_STREAM_CACHE; k++) this.keyStream[k] = this.nextByte()
  }

  nextByte() {
    const n = this.n
    this.i = (this.i + 1) % n
    this.j = (this.j + this.state[this.i]) % n
    const tmp = this.state[this.i]; this.state[this.i] = this.state[this.j]; this.state[this.j] = tmp
    return this.state[(this.state[this.i] + this.state[this.j]) % n]
  }

  decrypt(data, offset = 0) {
    const out = Buffer.from(data)
    const n = this.key.length
    const total = out.length
    let pos = offset
    let start = 0

    // 首段：offset < 0x80 时逐字节用段密钥打表
    if (pos < RC4_FIRST_SEGMENT) {
      const take = Math.min(RC4_FIRST_SEGMENT - pos, total)
      for (let k = 0; k < take; k++) {
        const p = pos + k
        out[k] ^= this.key[segmentKey(p, this.key[p % n], this.hash) % n]
      }
      start += take
      pos += take
    }

    // 其余按 0x1400 分段，用预生成密钥流的切片
    while (start < total) {
      const segId = Math.floor(pos / RC4_SEGMENT)
      const blockOff = pos % RC4_SEGMENT
      const seed = this.key[segId % n]
      const skip = segmentKey(segId, seed, this.hash) & 0x1ff
      const take = Math.min(RC4_SEGMENT - blockOff, total - start)
      for (let k = 0; k < take; k++) {
        out[start + k] ^= this.keyStream[skip + blockOff + k]
      }
      start += take
      pos += take
    }
    void n
    return out
  }
}

/**
 * 按主密钥长度选择流密码。
 * @param {Uint8Array|Buffer} masterKey 主密钥
 * @returns {MapStream|Rc4Stream}
 */
export function makeQmc2Stream(masterKey) {
  if (!masterKey || masterKey.length === 0) throw new Error('主密钥为空')
  return masterKey.length <= 300 ? new MapStream(masterKey) : new Rc4Stream(masterKey)
}

/* ------------------------------------------------------------------ *
 * 尾包解析
 * ------------------------------------------------------------------ */

const MAX_EKEY_LEN = 0x500
const MUSICEX_BLOCK = 0xc0

/** 判断一段字节是不是纯 base64 文本 */
function isBase64Text(buf) {
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    const ok = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) ||
      c === 0x2b || c === 0x2f || c === 0x3d
    if (!ok) return false
  }
  return buf.length > 0
}

/** ASCII 范围内的 UTF-16LE 读取（遇非 ASCII 或 NUL 停止） */
function readUtf16le(data) {
  let out = ''
  for (let i = 0; i + 1 < data.length; i += 2) {
    const lo = data[i]
    const hi = data[i + 1]
    if (lo === 0 && hi === 0) break
    if (hi === 0 && lo > 0 && lo < 128) out += String.fromCharCode(lo)
    else break
  }
  return out
}

/** 尾部是否以某段字节结尾 */
function endsWith(buf, suffix) {
  if (buf.length < suffix.length) return false
  return buf.subarray(buf.length - suffix.length).equals(suffix)
}

/**
 * 解析文件尾包（取最后 1024 字节）。
 *
 * @param {Buffer} tail 文件末尾片段
 * @returns {{size:number, ekey:string|null, kind:string, mid?:string, mediaFilename?:string, resourceId?:number}|null}
 */
export function parseFooter(tail) {
  if (tail.length < 8) return null

  // Android STag：只有资源元数据，没有 EKey
  if (endsWith(tail, Buffer.from('STag'))) {
    const body = tail.subarray(0, tail.length - 4)
    const payload = body.subarray(0, body.length - 4)
    const payloadLen = body.readUInt32BE(body.length - 4)
    if (payload.length < payloadLen) throw new Error('STag 长度不一致')
    const csv = payload.subarray(payload.length - payloadLen).toString('utf8')
    const parts = csv.split(',')
    if (parts.length !== 3 || parts[1] !== '2' || !/^\d+$/.test(parts[0])) throw new Error('STag 内容非法')
    return { size: payloadLen + 8, ekey: null, kind: 'STag', resourceId: Number(parts[0]), mid: parts[2] }
  }

  // Android QTag：内嵌 EKey
  if (endsWith(tail, Buffer.from('QTag'))) {
    const body = tail.subarray(0, tail.length - 4)
    const payload = body.subarray(0, body.length - 4)
    const payloadLen = body.readUInt32BE(body.length - 4)
    if (payload.length < payloadLen) throw new Error('QTag 长度不一致')
    const csv = payload.subarray(payload.length - payloadLen).toString('utf8')
    const parts = csv.split(',')
    if (parts.length !== 3 || parts[2] !== '2' || !/^\d+$/.test(parts[1])) throw new Error('QTag 内容非法')
    if (!isBase64Text(Buffer.from(parts[0], 'latin1'))) throw new Error('QTag EKey 非法')
    return { size: payloadLen + 8, ekey: parts[0], kind: 'QTag', resourceId: Number(parts[1]) }
  }

  // PC 新版 MusicEx：没有 EKey
  if (endsWith(tail, Buffer.from('musicex\x00', 'latin1'))) {
    const payload = tail.subarray(0, tail.length - 8)
    if (payload.length < 4) throw new Error('MusicEx 过短')
    const data = payload.subarray(0, payload.length - 4)
    const version = payload.readUInt32LE(payload.length - 4)
    if (version !== 1) return null
    if (data.length < 4) throw new Error('MusicEx 过短')
    const innerSrc = data.subarray(0, data.length - 4)
    const payloadLen = data.readUInt32LE(data.length - 4)
    if (payloadLen !== MUSICEX_BLOCK) throw new Error(`MusicEx 长度非法 0x${payloadLen.toString(16)}`)
    const inner = innerSrc.subarray(innerSrc.length - (payloadLen - 0x10))
    return {
      size: MUSICEX_BLOCK + 12,
      ekey: null,
      kind: 'MusicEx',
      mid: readUtf16le(inner.subarray(12, 72)),
      mediaFilename: readUtf16le(inner.subarray(72, 172)),
    }
  }

  // PC 经典：小端长度 + base64 EKey
  const body = tail.subarray(0, tail.length - 4)
  const payloadLen = tail.readUInt32LE(tail.length - 4)
  if (payloadLen > MAX_EKEY_LEN || payloadLen === 0) return null
  if (body.length < payloadLen) throw new Error('PcV1Legacy 长度不一致')
  let ekeyBytes = body.subarray(body.length - payloadLen)
  const zero = ekeyBytes.indexOf(0)
  if (zero !== -1) ekeyBytes = ekeyBytes.subarray(0, zero)
  if (!isBase64Text(ekeyBytes)) throw new Error('PcV1Legacy EKey 非法')
  return { size: payloadLen + 4, ekey: ekeyBytes.toString('latin1'), kind: 'PcV1Legacy' }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/** 取文件后缀 */
function extOf(name) {
  const m = /\.[^.]+$/.exec(name ?? '')
  return m ? m[0].toLowerCase() : ''
}

/**
 * 解密一个 QMC 文件（自动区分 v1 / v2）。
 *
 * @param {Buffer} buf 文件内容
 * @param {{filename?: string, ekey?: string, verify?: boolean}} [opts]
 * @returns {{audio: Buffer, format: string|null, generation: string, footerKind?: string, embeddedEkey?: boolean}}
 */
export function decryptQmc(buf, opts = {}) {
  const ext = extOf(opts.filename ?? '')
  const verify = opts.verify !== false

  // ── v1：后缀在 v1 名单里，直接用静态密钥 ──
  if (QMC_CONSTANTS.V1_EXTS.has(ext)) {
    const audio = qmc1Transform(buf, V1_STATIC_KEY, 0)
    const format = sniffAudioFormat(audio.subarray(0, 64))
    if (!format && verify) throw new Error('QMC v1 解密后认不出音频容器')
    return { audio, format, generation: 'v1' }
  }

  // ── v2：先解析尾包 ──
  let footer = null
  try {
    footer = parseFooter(buf.subarray(Math.max(0, buf.length - 1024)))
  } catch { footer = null }

  if (!footer) {
    // 尾包都没有 → 可能是被改名的 v1，用静态密钥试一下前 64 字节
    const head = qmc1Transform(buf.subarray(0, 64), V1_STATIC_KEY, 0)
    if (sniffAudioFormat(head)) {
      const audio = qmc1Transform(buf, V1_STATIC_KEY, 0)
      return { audio, format: sniffAudioFormat(audio.subarray(0, 64)), generation: 'v1' }
    }
    throw new Error('找不到 QMC 尾包，静态密钥也解不出音频头 —— 可能不是 QMC 文件')
  }

  // ── 取 EKey ──
  let ekey = footer.ekey ?? opts.ekey ?? null
  if (!ekey) {
    throw new Error(
      `这是 ${footer.kind} 类型的 QMC v2 文件，尾包里**没有内嵌密钥**。\n` +
      '可行的办法：\n' +
      '  · 用 QQ 音乐客户端（19.51 及以下）重新下载，那个版本的密钥是内嵌在文件里的\n' +
      '  · 或者从安卓端的 player_process_db 里取出对应 EKey 后用 --ekey 指定\n' +
      '（密钥存在客户端本地数据库里，文件本身不含 —— 所以纯靠文件解不了）')
  }

  // ── 派生主密钥并解密 ──
  const master = deriveMasterKey(ekey)
  const stream = makeQmc2Stream(master)
  const audio = stream.decrypt(buf.subarray(0, buf.length - footer.size))
  const format = sniffAudioFormat(audio.subarray(0, 64))
  if (!format && verify) {
    throw new Error(`QMC v2（${footer.kind}）解密后认不出音频容器 —— EKey 可能不对或文件损坏`)
  }
  return {
    audio,
    format,
    generation: 'v2',
    footerKind: footer.kind,
    embeddedEkey: !!footer.ekey,
  }
}

/**
 * 判定一个文件的 QMC 世代与尾包情况。
 *
 * **用尾包解析结果判定，不用标记嗅探** —— STag 和 QTag 都是 v2，
 * 区别只在**尾包里有没有内嵌密钥**，跟「第几代」无关。
 * 早先按标记判定会把 STag 误判成「新版无解」，其实它只是缺密钥、格式本身可解。
 *
 * @param {Buffer} buf 文件内容
 * @param {string} [filename] 原始文件名（看后缀）
 * @returns {{isQmc:boolean, gen:string|null, hasEkey:boolean|null, footerKind?:string, reason:string}}
 */
export function detectQmc(buf, filename = '') {
  const ext = extOf(filename)
  if (QMC_CONSTANTS.V1_EXTS.has(ext)) {
    return { isQmc: true, gen: 'v1', hasEkey: false, reason: '后缀属于 v1（128 字节公开静态密钥）' }
  }
  let footer = null
  try { footer = parseFooter(buf.subarray(Math.max(0, buf.length - 1024))) } catch { footer = null }
  if (footer) {
    const hasEkey = !!footer.ekey
    return {
      isQmc: true,
      gen: 'v2',
      hasEkey,
      footerKind: footer.kind,
      reason: footer.kind + ' 尾包' + (hasEkey ? '（含内嵌 EKey）' : '（不含 EKey，需要外部密钥）'),
    }
  }
  if (QMC_CONSTANTS.V2_EXTS.has(ext)) {
    return { isQmc: true, gen: 'v2', hasEkey: null, reason: '后缀属于 v2 家族，但没解析出尾包' }
  }
  return { isQmc: false, gen: null, hasEkey: null, reason: '看不出是 QMC' }
}

export const QMC2_CONSTANTS = {
  MAP_LEN, MAP_MAGIC, RC4_FIRST_SEGMENT, RC4_SEGMENT, RC4_STREAM_CACHE,
  MAX_EKEY_LEN, MUSICEX_BLOCK, EKEY_V2_PREFIX,
}
export { MapStream, Rc4Stream }