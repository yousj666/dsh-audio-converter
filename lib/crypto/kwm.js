// 酷我音乐 .kwm 解密器
//
// 格式（老版）
//   0      1024  头部（未加密）
//   1024   余    音频：与一段 **32 字节循环密钥**逐字节异或
//
// 密钥怎么来的
//   明文音频开头往往是一段全零的静音，异或之后密文就等于密钥本身。
//   所以扫描 32 字节块，找出**相邻两块完全相同**的那个，就是密钥。
//   但"看起来像"不够 —— 必须**用它解出可识别的音频容器头**才算数，
//   否则可能撞上恰好重复的数据块，解出一堆垃圾还当成功。
//   所以这里用「解出来是不是 fLaC / ID3 / OggS / RIFF」来判定。
//
// 参考：HRuiCcc/music-geshizhuanhuan 的 kwm.py（MIT）
//
// @module dsh-audio-converter/crypto/kwm
'use strict'

import { sniffAudioFormat } from './ncm.js'

/** 头部长度 */
const HEADER_LEN = 1024
/** 循环密钥长度 */
const KEY_LEN = 32
/** 密钥恢复时最多扫描多少个 32 字节块 */
const MAX_SCAN_CHUNKS = 2048

/** 这个文件像不像 KWM。 */
export function isKwm(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN + KEY_LEN * 2) return false
  // KWM 没有公认的 magic，靠「头部之后能恢复出密钥并解出合法容器」来判定，
  // 那个判断在 decryptKwm 里做。这里只做长度下限。
  return true
}

/**
 * 用候选密钥试解一小段，看能不能解出已知的音频容器。
 * @param {Buffer} data 整个文件
 * @param {Buffer} key 32 字节候选密钥
 * @returns {string|null} 识别出的格式，认不出返回 null
 */
function tryKey(data, key) {
  const start = HEADER_LEN
  const end = Math.min(data.length, start + 4096)
  const probe = Buffer.allocUnsafe(end - start)
  for (let i = 0; i < probe.length; i++) {
    probe[i] = data[start + i] ^ key[i & (KEY_LEN - 1)]
  }
  // 明文可能以静音（0x00）开头，嗅探前先跳过前导零
  let p = 0
  while (p < probe.length && probe[p] === 0) p++
  return sniffAudioFormat(probe.subarray(p, p + 64))
}

/**
 * 把某个偏移处的密钥旋转一半（老工具的回退方案）。
 * @param {Buffer} key 32 字节
 * @returns {Buffer}
 */
function rotate(key) {
  const half = KEY_LEN / 2
  return Buffer.concat([key.subarray(half), key.subarray(0, half)])
}

/**
 * 解密一个 KWM 文件。
 * @param {Buffer} buf 完整文件内容
 * @returns {{audio: Buffer, format: string|null, keyOffset: number|null, keySource: string}}
 */
export function decryptKwm(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN + KEY_LEN) {
    throw new Error('KWM 文件过短')
  }
  const body = buf.subarray(HEADER_LEN)
  if (body.length < KEY_LEN * 2) throw new Error('KWM 音频段过短')

  // ── 找候选密钥：相邻两个相同的 32 字节块 ──
  const candidates = []
  const seen = new Set()
  const add = (key, source, offset) => {
    const hex = key.toString('hex')
    if (seen.has(hex)) return
    seen.add(hex)
    candidates.push({ key, source, offset })
  }

  const chunks = Math.min(MAX_SCAN_CHUNKS, Math.floor(body.length / KEY_LEN))
  let prev = Buffer.from(body.subarray(0, KEY_LEN))
  for (let i = 1; i < chunks; i++) {
    const cur = Buffer.from(body.subarray(i * KEY_LEN, (i + 1) * KEY_LEN))
    if (cur.equals(prev)) add(cur, '相邻同块', i * KEY_LEN)
    prev = cur
  }
  // 回退方案：最后一块前后半交换
  add(rotate(prev), '半旋转', (chunks - 1) * KEY_LEN)

  // ── 用容器嗅探挑出真正能用的密钥 ──
  let chosen = null
  for (const c of candidates) {
    const fmt = tryKey(buf, c.key)
    if (fmt) { chosen = { ...c, format: fmt }; break }
  }

  // 还不行就把前 64 块全当候选试一遍（有些文件开头不是静音）
  if (!chosen) {
    for (let i = 0; i < Math.min(64, chunks); i++) {
      const key = Buffer.from(body.subarray(i * KEY_LEN, (i + 1) * KEY_LEN))
      const fmt = tryKey(buf, key)
      if (fmt) { chosen = { key, source: '暴力扫描', offset: i * KEY_LEN, format: fmt }; break }
    }
  }

  if (!chosen) {
    throw new Error('无法恢复 KWM 密钥：试过相邻同块、半旋转、以及前 64 块暴力扫描，都解不出可识别的音频头')
  }

  // ── 全量解密 ──
  const audio = Buffer.allocUnsafe(body.length)
  for (let i = 0; i < body.length; i++) {
    audio[i] = body[i] ^ chosen.key[i & (KEY_LEN - 1)]
  }
  // 嗅探前跳过前导静音
  let p = 0
  while (p < Math.min(audio.length, 4096) && audio[p] === 0) p++
  const format = sniffAudioFormat(audio.subarray(p, p + 64)) ?? chosen.format

  return {
    audio,
    format,
    leadSilence: p,
    keyOffset: chosen.offset,
    keySource: chosen.source,
  }
}

export const KWM_CONSTANTS = { HEADER_LEN, KEY_LEN, MAX_SCAN_CHUNKS }
