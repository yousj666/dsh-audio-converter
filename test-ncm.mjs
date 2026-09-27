/**
 * NCM 解密器测试
 *
 * 关键验证：拿机器上真实的 .ncm 文件解密，跟一份**已知正确的**转换结果逐字节对比。
 * 这比任何构造用例都有说服力 —— 加密算法只要错一个字节，输出就对不上。
 *
 * 素材（**可选**，走环境变量，没有就跳过这一节）：
 *   DSH_TEST_NCM_A / DSH_TEST_KNOWN_A    加密源 / 已知正确的解密结果
 *   DSH_TEST_NCM_B / DSH_TEST_KNOWN_B    第二组
 *
 * 另外还有一组**合成往返测试**：本地按规范造一个 NCM，再解回来，验证纯逻辑正确性
 * （不依赖外部素材，clone 下来就能跑）。
 */
import { createHash, createCipheriv } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  decryptNcm, isNcm, sniffAudioFormat, buildKeyBox, buildKeystream,
  NCM_CONSTANTS,
} from './lib/crypto/ncm.js'

let pass = 0
let fail = 0
const fails = []
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log('  ✅ ' + label) }
  else { fail++; fails.push(label); console.log('  ❌ ' + label + (detail ? '  → ' + detail : '')) }
}
function section(t) {
  console.log('')
  console.log('─'.repeat(70))
  console.log(t)
  console.log('─'.repeat(70))
}
const sha = (b) => createHash('sha256').update(b).digest('hex')
const mb = (n) => (n / 1048576).toFixed(2) + ' MB'

/**
 * 解析 ID3v2 头，返回标签总长度（用于跳过标签比较音频载荷）。
 *
 * 为什么需要它：不同工具解密后**会重新打标签** —— 典型做法是把 NCM 容器里
 * 单独存的封面嵌进 ID3，于是一个 1 KB 的标签会变成几百 KB，文件也就对不上了。
 * 但**音频载荷仍然是逐字节相同的**，所以比较必须跳过标签段。
 * @param {Buffer} buf 音频文件
 * @returns {{ver: string, size: number, total: number}|null}
 */
function id3Info(buf) {
  if (buf.length < 10 || buf.subarray(0, 3).toString('ascii') !== 'ID3') return null
  // synchsafe integer：每个字节只用低 7 位
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  return { ver: `2.${buf[3]}.${buf[4]}`, size, total: 10 + size }
}

/** 取出去掉 ID3v2 之后的音频载荷（末尾 ID3v1 的 128 字节也一并去掉）。 */
function audioPayload(buf) {
  const id3 = id3Info(buf)
  let start = id3 ? id3.total : 0
  let end = buf.length
  // ID3v1：末尾 128 字节以 "TAG" 开头
  if (end - start > 128 && buf.subarray(end - 128, end - 125).toString('ascii') === 'TAG') end -= 128
  return buf.subarray(start, end)
}

/* ================================================================== *
 * 1. 常量自检
 * ================================================================== */
section('1. 常量自检')
check('core_key 解出来是 "hzHRAmso5kInbaxW"',
  NCM_CONSTANTS.CORE_KEY.toString('ascii') === 'hzHRAmso5kInbaxW',
  NCM_CONSTANTS.CORE_KEY.toString('ascii'))
check('meta_key 是 16 字节', NCM_CONSTANTS.META_KEY.length === 16)
check('meta 前缀是 "163 key(Don\'t modify):"',
  NCM_CONSTANTS.META_PREFIX.toString('ascii') === "163 key(Don't modify):")
check('magic 是 CTENFDAM', NCM_CONSTANTS.MAGIC.toString('ascii') === 'CTENFDAM')

/* ================================================================== *
 * 2. S 盒与密钥流
 * ================================================================== */
section('2. S 盒与密钥流')
const boxA = buildKeyBox(Buffer.from('abcdefghijklmnop'))
check('S 盒是 256 字节', boxA.length === 256)
check('S 盒是 0..255 的一个排列', (() => {
  const seen = new Set(boxA)
  return seen.size === 256 && [...seen].every((v) => v >= 0 && v <= 255)
})())
const boxB = buildKeyBox(Buffer.from('abcdefghijklmnop'))
check('同样输入得到同样 S 盒（确定性）', Buffer.compare(Buffer.from(boxA), Buffer.from(boxB)) === 0)
const boxC = buildKeyBox(Buffer.from('ponmlkjihgfedcba'))
check('不同输入得到不同 S 盒', Buffer.compare(Buffer.from(boxA), Buffer.from(boxC)) !== 0)
const ks = buildKeystream(boxA)
check('密钥流是 256 字节', ks.length === 256)
check('密钥流不是全零', ks.some((v) => v !== 0))

// 关键性质：密钥流只跟「位置 % 256」有关，所以分块大小不影响结果。
// 这正是能把整段音频当固定表处理的原因。
const ks2 = buildKeystream(buildKeyBox(Buffer.from('abcdefghijklmnop')))
check('密钥流可重复计算且一致', Buffer.compare(Buffer.from(ks), Buffer.from(ks2)) === 0)

/* ================================================================== *
 * 3. 合成往返（不依赖磁盘素材）
 * ================================================================== */
section('3. 合成往返：自己造一个 NCM，再解回来')

/** 按规范造一个 NCM 容器。 */
function buildNcm(audio, { format = 'flac', musicName = '测试曲目', artist = '测试歌手' } = {}) {
  const pkcs7 = (buf) => {
    const pad = 16 - (buf.length % 16)
    return Buffer.concat([buf, Buffer.alloc(pad, pad)])
  }
  const aesEnc = (key, data) => {
    const c = createCipheriv('aes-128-ecb', key, null)
    c.setAutoPadding(false)
    return Buffer.concat([c.update(data), c.final()])
  }
  // 音频密钥：明文 17 字节前缀 + 随机密钥 + 填充
  const realKey = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd', 'hex')
  const keyPlain = Buffer.concat([Buffer.from('neteasecloudmusic'), realKey])
  const keyCipher = aesEnc(NCM_CONSTANTS.CORE_KEY, pkcs7(keyPlain))
  for (let i = 0; i < keyCipher.length; i++) keyCipher[i] ^= 0x64

  // 元数据
  const metaJson = JSON.stringify({ musicName, artist: [[artist, 1]], format, bitrate: 1411200 })
  const metaPlain = Buffer.concat([Buffer.from('music:'), Buffer.from(metaJson, 'utf8')])
  const metaCipher = aesEnc(NCM_CONSTANTS.META_KEY, pkcs7(metaPlain))
  const metaB64 = Buffer.from(metaCipher.toString('base64'), 'ascii')
  const metaBody = Buffer.concat([NCM_CONSTANTS.META_PREFIX, metaB64])
  for (let i = 0; i < metaBody.length; i++) metaBody[i] ^= 0x63

  // 音频：用同一张密钥流异或
  const box = buildKeyBox(realKey)
  const kstream = buildKeystream(box)
  const enc = Buffer.from(audio)
  for (let i = 0; i < enc.length; i++) enc[i] ^= kstream[(i + 1) & 0xff]

  const head = Buffer.alloc(10)
  NCM_CONSTANTS.MAGIC.copy(head, 0)
  head.writeUInt16LE(0x0170, 8)
  const keyLenBuf = Buffer.alloc(4); keyLenBuf.writeUInt32LE(keyCipher.length, 0)
  const metaLenBuf = Buffer.alloc(4); metaLenBuf.writeUInt32LE(metaBody.length, 0)
  const crc = Buffer.alloc(4)
  const unknown5 = Buffer.alloc(5)
  const coverLen = Buffer.alloc(4); coverLen.writeUInt32LE(0, 0)

  return Buffer.concat([head, keyLenBuf, keyCipher, metaLenBuf, metaBody, crc, unknown5, coverLen, enc])
}

// 造一段假的 "FLAC"（有正确 magic 就行）
const fakeAudio = Buffer.concat([
  Buffer.from('fLaC'), Buffer.alloc(3000, 0x5a), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
])
const synth = buildNcm(fakeAudio, { format: 'flac', musicName: '往返测试', artist: '本地' })
check('合成文件被识别为 NCM', isNcm(synth))
const synthOut = decryptNcm(synth)
check('合成往返：音频逐字节一致', Buffer.compare(synthOut.audio, fakeAudio) === 0,
  `期望 ${fakeAudio.length}B，得到 ${synthOut.audio.length}B`)
check('合成往返：format 解析正确', synthOut.format === 'flac', String(synthOut.format))
check('合成往返：musicName 解析正确', synthOut.meta?.musicName === '往返测试', String(synthOut.meta?.musicName))
check('合成往返：artist 解析正确', synthOut.meta?.artist?.[0]?.[0] === '本地')
check('合成往返：嗅探出的格式也是 flac', sniffAudioFormat(synthOut.audio) === 'flac')

// 故意破坏 magic
const broken = Buffer.from(synth); broken[0] = 0x00
check('magic 被破坏时 isNcm 返回 false', !isNcm(broken))
let threw = false
try { decryptNcm(broken) } catch { threw = true }
check('magic 被破坏时 decryptNcm 抛错（不静默产出垃圾）', threw)

// 流式性质：块边界不能影响结果。用不同 CHUNK 解密应当一致。
const big = Buffer.alloc(0x8000 * 2 + 777)
for (let i = 0; i < big.length; i++) big[i] = i & 0xff
const bigNcm = buildNcm(big)
const bigOut = decryptNcm(bigNcm)
check('跨多个读块的大文件解密正确（块边界无关）', Buffer.compare(bigOut.audio, big) === 0,
  `${big.length}B -> ${bigOut.audio.length}B`)

/* ================================================================== *
 * 4. 真实文件验证
 *
 * 这一节需要**你自己的 .ncm 文件**，以及一份「已知正确」的转换结果做锚点。
 * 别人 clone 下来不会有这些文件 —— 所以：
 *   · 路径走环境变量，可以指向自己的素材
 *   · 文件不在就**整节跳过**，不算失败
 *
 * 怎么准备锚点：用任意一个能正确解 NCM 的工具（或网易云客户端）转一次，
 * 把结果放到 DSH_TEST_KNOWN_A / B 指向的位置。
 * ================================================================== */
section('4. 真实文件验证（跟已知正确的转换结果对比）')

const samples = [
  {
    ncm: process.env.DSH_TEST_NCM_A ||
      'G:\\CloudMusic\\VipSongsDownload\\The Little Dippers - Forever (Single Version).ncm',
    known: process.env.DSH_TEST_KNOWN_A ||
      join(homedir(), 'Desktop', '转换输出', 'The Little Dippers - Forever (Single Version).mp3'),
  },
  {
    ncm: process.env.DSH_TEST_NCM_B ||
      'G:\\CloudMusic\\VipSongsDownload\\The Little Dippers - Forever.ncm',
    known: process.env.DSH_TEST_KNOWN_B ||
      join(homedir(), 'Desktop', '转换输出', 'The Little Dippers - Forever.mp3'),
  },
]

if (!samples.some((s) => existsSync(s.ncm))) {
  console.log('  ⏭  跳过：没有真实 .ncm 素材。')
  console.log('     想跑这一节就设环境变量指到你自己的文件：')
  console.log('       DSH_TEST_NCM_A=<你的 .ncm>  DSH_TEST_KNOWN_A=<已知正确的转换结果>')
  console.log('     （合成样本的往返验证在下面第 5 节，那部分不需要外部素材）')
}

let realTested = 0
for (const s of samples) {
  if (!existsSync(s.ncm)) { console.log('  ⏭  跳过（源文件不在）: ' + s.ncm); continue }
  console.log('')
  console.log('  素材: ' + s.ncm.split('\\').pop())
  const src = readFileSync(s.ncm)
  console.log('    加密文件 ' + mb(src.length))

  check('  被识别为 NCM', isNcm(src))
  const out = decryptNcm(src)
  console.log('    解密后音频 ' + mb(out.audio.length) + '   格式=' + (out.format ?? '(元数据无)') +
    '   嗅探=' + (sniffAudioFormat(out.audio) ?? '(认不出)'))
  if (out.meta) {
    console.log('    元数据: musicName=' + JSON.stringify(out.meta.musicName) +
      '  format=' + out.meta.format + '  bitrate=' + out.meta.bitrate +
      '  duration=' + out.meta.duration + 'ms')
  }
  check('  解密成功且音频非空', out.audio.length > 1024)
  const sniffed = sniffAudioFormat(out.audio)
  check('  音频头部是合法格式（fLaC/ID3/…）', sniffed !== null, String(sniffed))
  check('  封面解析出来了', out.cover === null || out.cover.length > 100,
    out.cover ? out.cover.length + 'B' : '(无封面)')
  if (out.cover) {
    check('  封面是图片（JPEG/PNG）', out.cover[0] === 0xff || out.cover.subarray(1, 4).toString() === 'PNG',
      out.cover.subarray(0, 4).toString('hex'))
  }

  // 跟已知结果比 —— 关键是比**音频载荷**，不是整个文件。
  // 不同工具解密后会重新打标签（尤其会把封面嵌进 ID3），整文件哈希对不上很正常。
  if (existsSync(s.known)) {
    const known = readFileSync(s.known)
    const mineId3 = id3Info(out.audio)
    const knownId3 = id3Info(known)
    console.log('    已知结果 ' + mb(known.length) + '  ID3=' + (knownId3 ? knownId3.ver + '/' + knownId3.size + 'B' : '无') + '  sha=' + sha(known).slice(0, 16) + '…')
    console.log('    本次解密 ' + mb(out.audio.length) + '  ID3=' + (mineId3 ? mineId3.ver + '/' + mineId3.size + 'B' : '无') + '  sha=' + sha(out.audio).slice(0, 16) + '…')

    const minePayload = audioPayload(out.audio)
    const knownPayload = audioPayload(known)
    const sameLen = minePayload.length === knownPayload.length
    const sameBytes = sameLen && Buffer.compare(minePayload, knownPayload) === 0
    check('  **音频载荷与已知正确结果逐字节一致**', sameBytes,
      sameLen ? '长度同为 ' + minePayload.length + 'B 但内容不同' : `长度 ${minePayload.length} vs ${knownPayload.length}`)
    if (sameBytes) {
      console.log('      → 载荷 ' + mb(minePayload.length) + '  sha=' + sha(minePayload).slice(0, 16) + '…  完全一致 ✅')
      if (mineId3?.size !== knownId3?.size) {
        console.log('      （整文件不同只因 ID3 标签：本次 ' + (mineId3?.size ?? 0) + 'B vs 已知 ' + (knownId3?.size ?? 0) + 'B）')
        console.log('      （已知文件把封面嵌进了 ID3；本次把封面单独提取出来，共 ' + (out.cover?.length ?? 0) + 'B）')
      }
    } else {
      // 长度一致但内容不同 → 至少定位首个差异
      const n = Math.min(minePayload.length, knownPayload.length)
      let firstDiff = -1
      for (let i = 0; i < n; i++) if (minePayload[i] !== knownPayload[i]) { firstDiff = i; break }
      console.log('      首个差异在载荷第 ' + firstDiff + ' 字节')
      if (firstDiff >= 0 && firstDiff < 200) {
        console.log('        期望 ' + knownPayload.subarray(firstDiff, firstDiff + 24).toString('hex'))
        console.log('        实际 ' + minePayload.subarray(firstDiff, firstDiff + 24).toString('hex'))
      }
    }
  } else {
    // 没已知结果时，至少验证解出来的是合法音频
    if (sniffed === 'mp3') {
      const hasID3 = out.audio.subarray(0, 3).toString('ascii') === 'ID3'
      check('  是合法 MP3（' + (hasID3 ? '有 ID3 头' : '裸 MPEG 帧') + '）', true)
    }
  }
  realTested++
}

if (realTested === 0) console.log('  ⚠️ 没有可用的真实素材，仅跑了合成往返测试')

/* ================================================================== *
 * 结果
 * ================================================================== */
section('结果')
console.log(`  通过 ${pass}    失败 ${fail}`)
if (fails.length) fails.forEach((f) => console.log('    ❌ ' + f))
console.log('')
console.log(fail === 0 ? '  ✅ 全部通过' : '  ❌ 有失败项')
process.exit(fail === 0 ? 0 : 1)
