/**
 * KGM（酷狗）与 QMC（QQ音乐）解密器测试
 *
 * 方法：
 *   1. **跨语言对拍** —— 黄金值由一份独立的 Python 参考实现算出（按公开规范另写一遍，
 *      不是 import 原项目）。JS 侧如果翻译错了，值就对不上。
 *   2. **往返测试** —— 自造合法文件，解回来逐字节比对。
 *   3. **边界与失败路径** —— QMC v1 的 0x7FFF 边界、KGM 的版本 5、公钥耗尽。
 */
import { decryptKgm, isKgm, scramble, MEND_TABLE, KGM_MAGIC, VPR_MAGIC, KGM_CONSTANTS } from './lib/crypto/kgm.js'
import { qmc1Transform, decryptQmcV1, detectQmcGeneration, V1_STATIC_KEY, QMC_CONSTANTS } from './lib/crypto/qmc.js'
import { sniffAudioFormat } from './lib/crypto/ncm.js'

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
const hex = (b) => Buffer.from(b).toString('hex')

/** 把带空格的 hex 串转成 Buffer */
function fromHex(s) { return Buffer.from(s.replace(/\s+/g, ''), 'hex') }

/* ================================================================== *
 * 1. 公共小工具
 * ================================================================== */
section('1. scramble 字节变换')
check('scramble(0x5A) = 0xFA（与参考实现一致）', scramble(0x5a) === 0xfa, '0x' + scramble(0x5a).toString(16))
check('scramble 是自逆的', scramble(scramble(0x5a)) === 0x5a)
check('scramble 自逆（全 256 个值）', (() => {
  for (let v = 0; v < 256; v++) if (scramble(scramble(v)) !== v) return false
  return true
})())
check('MEND 表是 272 字节', MEND_TABLE.length === 272, String(MEND_TABLE.length))
check('v1 静态密钥是 128 字节', V1_STATIC_KEY.length === 128)

/* ================================================================== *
 * 2. QMC v1 —— 跨语言对拍
 * ================================================================== */
section('2. QMC v1 跨语言对拍（黄金值来自独立 Python 实现）')

// 小输入：32 字节 0..31
const smallIn = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
const smallExpected = 'c34bd4c99462f155d0a86c699356070fd34f87308b060769c08b25a78ca66a11'
check('小输入（偏移 0）对得上',
  hex(qmc1Transform(smallIn, V1_STATIC_KEY, 0)) === smallExpected,
  hex(qmc1Transform(smallIn, V1_STATIC_KEY, 0)))

// 跨边界：从 0x7FF0 = 32752 开始
const midIn = fromHex('030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bc')
const midExpected = 'c00a184380444b95e310be37c794b32639ac4b18e861cf7c0ad4db5f9cc7d51fbd7fd267ec1773cc891d95a08c4a4b8f142e5cf8c5492c5c7f831d3f793ba87f'
check('跨 0x7FFF 边界（起始 32752）对得上',
  hex(qmc1Transform(midIn, V1_STATIC_KEY, 32752)) === midExpected,
  hex(qmc1Transform(midIn, V1_STATIC_KEY, 32752)))

// 边界之后：从 0x8000 = 32768 开始 —— 这一段的密钥索引规则不一样，最容易写错
const postIn = fromHex('05101b26313c47525d68737e89949faab5c0cbd6e1ecf7020d18232e39444f5a65707b86919ca7b2bdc8d3dee9f4ff0a')
const postExpected = '4fc6d1b656cb158afc0e11e1d29d9f69eb55e849f2fd89da9f279fbe82304199220446163ba3f66a49d957413761e2c9'
check('边界之后（起始 32768，走 mod 0x7FFF 分支）对得上',
  hex(qmc1Transform(postIn, V1_STATIC_KEY, 32768)) === postExpected,
  hex(qmc1Transform(postIn, V1_STATIC_KEY, 32768)))

/* ================================================================== *
 * 3. QMC v1 —— 性质
 * ================================================================== */
section('3. QMC v1 性质')
const data = Buffer.alloc(200)
for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff
check('变换是自逆的（两次变回来）',
  Buffer.compare(qmc1Transform(qmc1Transform(data, V1_STATIC_KEY), V1_STATIC_KEY), data) === 0)

// 分块无关性：任意切点分段处理，结果必须和整体处理一样。
// 这条专门盯着偏移逻辑 —— 分段时每段要带上正确的 offsetStart。
let splitOk = 0
const splits = [1, 100, 127, 128, 129, 255, 256, 1000, 20000]
for (const cut of splits) {
  const whole = qmc1Transform(data, V1_STATIC_KEY, 0)
  const part1 = qmc1Transform(data.subarray(0, cut), V1_STATIC_KEY, 0)
  const part2 = qmc1Transform(data.subarray(cut), V1_STATIC_KEY, cut)
  if (Buffer.compare(Buffer.concat([part1, part2]), whole) === 0) splitOk++
}
check(`切点无关（${splits.length} 个切点）`, splitOk === splits.length, `${splitOk}/${splits.length}`)

// 大偏移：跨 0x7FFF 的分段
const big = Buffer.alloc(4000)
for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff
const cut2 = 32760   // 跨过 0x7FFF
const wholeBig = qmc1Transform(big, V1_STATIC_KEY, 32000)
const p1 = qmc1Transform(big.subarray(0, cut2 - 32000), V1_STATIC_KEY, 32000)
const p2 = qmc1Transform(big.subarray(cut2 - 32000), V1_STATIC_KEY, cut2)
check('跨边界的偏移也切点无关', Buffer.compare(Buffer.concat([p1, p2]), wholeBig) === 0)

/* ================================================================== *
 * 4. QMC —— 解密与世代识别
 * ================================================================== */
section('4. QMC 解密与世代识别')
// 造一个 v1 文件：明文是 fLaC 开头
const fakeFlac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(3000, 0x33)])
const qmcFile = qmc1Transform(fakeFlac, V1_STATIC_KEY, 0)   // 自逆，所以这就是"加密"
const dec = decryptQmcV1(qmcFile)
check('v1 解密后逐字节一致', Buffer.compare(dec.audio, fakeFlac) === 0)
check('v1 嗅探出 flac', dec.format === 'flac', String(dec.format))

// 解不出来的必须抛错（不能吐垃圾还报成功）
const garbage = Buffer.alloc(3000, 0x99)
let threw = false
let errMsg = ''
try { decryptQmcV1(garbage) } catch (e) { threw = true; errMsg = e.message }
check('解不出容器时抛错', threw)
check('错误信息列出了可能原因', /v2|v3|不是 QMC/.test(errMsg), errMsg.slice(0, 80))

// 世代识别
check('.tkm → v1', detectQmcGeneration(Buffer.alloc(2000), 'a.tkm').gen === 'v1')
check('.bkcflac → v1', detectQmcGeneration(Buffer.alloc(2000), 'a.bkcflac').gen === 'v1')
check('.mflac → v2', detectQmcGeneration(Buffer.alloc(2000), 'a.mflac').gen === 'v2')
check('.qmcflac → v2', detectQmcGeneration(Buffer.alloc(2000), 'a.qmcflac').gen === 'v2')
check('.mgg1 → v2 或 v3（取决于尾部标记）',
  ['v2', 'v3'].includes(detectQmcGeneration(Buffer.alloc(2000), 'a.mgg1').gen))
// 带 STag 标记的应该判成 v3（新版）
const stagFile = Buffer.concat([Buffer.alloc(500, 0), Buffer.from('STag'), Buffer.alloc(1500, 0x44)])
check('带 STag 标记 → v3（新版，离线无解）',
  detectQmcGeneration(stagFile, 'a.mgg1').gen === 'v3',
  detectQmcGeneration(stagFile, 'a.mgg1').reason)
check('普通文件识别不出 QMC', detectQmcGeneration(Buffer.alloc(2000), 'plain.mp3').gen === null)
check('常量：BOUNDARY = 0x7FFF', QMC_CONSTANTS.BOUNDARY === 0x7fff)

/* ================================================================== *
 * 5. KGM —— 跨语言对拍
 * ================================================================== */
section('5. KGM 跨语言对拍（黄金值来自独立 Python 实现）')
const cryptoTest = fromHex('102030405060708090a0b0c0d0e0f001')
const fakePub = fromHex('0763c800ff0d2abc')
const kgmAudioIn = fromHex('0714212e3b4855626f7c8996a3b0bdcad7e4f1fe0b1825323f4c596673808d9aa7b4c1cedbe8f5020f1c293643505d6a7784919eabb8c5d2dfecf90613202d3a4754616e7b8895a2afbcc9d6e3f0fd0a1724313e4b5865727f8c99a6b3c0cddae7f4010e')
const kgmAudioExpected = '28869b6bd580faf9cb68bf002287f74b2b39f72091c55ef68b0338cb2a72c17177a597b3c55e840dfb5c0cd33e65cb98a1ca78c065f9aca4939fa0d455420f61dc3bf0a8b13e2cebbd50845fb58eafc2bfbb3c3da4579656ef83f68603133edfc4fd5934'

// 直接构造一个 KGM 文件，让 decryptKgm 用我们给的假公钥表
function buildKgm(audio, cryptoTestBytes, { version = 3, magic = KGM_MAGIC, audioOffset = 1024 } = {}) {
  const header = Buffer.alloc(1024, 0)
  magic.copy(header, 0)
  header.writeUInt32LE(audioOffset, 0x10)
  header.writeUInt32LE(version, 0x14)
  cryptoTestBytes.copy(header, 0x1c)
  return Buffer.concat([header, audio])
}

// 先用「加密」的方向造出密文：c = scramble(p ^ xm) ^ ok
function kgmEncrypt(plain, cryptoTestBytes, pub) {
  const ownKey = Buffer.concat([cryptoTestBytes, Buffer.from([0])])
  const out = Buffer.from(plain)
  const blockCount = Math.ceil(plain.length / 16)
  for (let b = 0; b < blockCount; b++) {
    const phase = b % 17
    const pubValue = pub[b]
    for (let col = 0; col < 16; col++) {
      const off = b * 16 + col
      if (off >= plain.length) break
      const ownIdx = (phase * 16 + col) % 17
      const pubIdx = (phase * 16 + col) % 272
      const xormask = scramble(pubValue ^ MEND_TABLE[pubIdx])
      out[off] = scramble(plain[off] ^ xormask) ^ ownKey[ownIdx]
    }
  }
  return out
}

// 黄金值里 audio_in 本身就是**密文**，audio_out 是解出来的明文。
// 所以直接把 audio_in 当文件内容即可 —— 不要再"加密"一遍，
// 那样会和解密相互抵消，看起来"对上了"其实什么都没验证。
const kgmFile = buildKgm(kgmAudioIn, cryptoTest)
const kgmOut = decryptKgm(kgmFile, { pubKey: new Uint8Array(fakePub) })
check('KGM 解密对得上黄金值',
  hex(kgmOut.audio) === kgmAudioExpected,
  '得到 ' + hex(kgmOut.audio).slice(0, 48) + '…')

// 另外单独验一次自逆性质：加密再解密应当回到原文
const roundTripPlain = Buffer.from(kgmAudioExpected, 'hex')
const rtFile = buildKgm(kgmEncrypt(roundTripPlain, cryptoTest, fakePub), cryptoTest)
const rtOut = decryptKgm(rtFile, { pubKey: new Uint8Array(fakePub) })
check('加密→解密 往返还原（自逆性）',
  Buffer.compare(rtOut.audio, roundTripPlain) === 0)

/* ================================================================== *
 * 6. KGM —— 结构与失败路径
 * ================================================================== */
section('6. KGM 结构与失败路径')
check('isKgm 认 KGM magic', isKgm(kgmFile))
const vprFile = buildKgm(kgmEncrypt(kgmAudioIn, cryptoTest, fakePub), cryptoTest, { magic: VPR_MAGIC })
check('isKgm 认 VPR magic', isKgm(vprFile))
check('isKgm 拒绝普通文件', !isKgm(Buffer.alloc(2000, 0x11)))
check('isKgm 拒绝过短文件', !isKgm(Buffer.alloc(100)))
check('返回里带加密版本', kgmOut.cryptoVersion === 3, String(kgmOut.cryptoVersion))
check('返回里带音频偏移', kgmOut.audioOffset === 1024, String(kgmOut.audioOffset))

// 版本 5 = KGG，需要客户端密钥库
let v5threw = false
let v5msg = ''
try { decryptKgm(buildKgm(kgmAudioIn, cryptoTest, { version: 5 }), { pubKey: new Uint8Array(fakePub) }) }
catch (e) { v5threw = true; v5msg = e.message }
check('加密版本 5（KGG）明确报不支持', v5threw)
check('理由说明密钥在客户端密钥库、离线无解', /客户端|离线/.test(v5msg), v5msg.slice(0, 80))

// 公钥不够用
let pubThrew = false
let pubMsg = ''
try {
  const bigAudio = Buffer.alloc(16 * 20, 0)     // 20 块
  decryptKgm(buildKgm(bigAudio, cryptoTest), { pubKey: new Uint8Array(fakePub.subarray(0, 4)) })
} catch (e) { pubThrew = true; pubMsg = e.message }
check('公钥不够用时抛错', pubThrew)
check('错误信息教用户怎么生成完整表', /expand-kugou-key/.test(pubMsg), pubMsg.slice(0, 120))

// 非法偏移
let offThrew = false
try { decryptKgm(buildKgm(kgmAudioIn, cryptoTest, { audioOffset: 4 }), { pubKey: new Uint8Array(fakePub) }) }
catch { offThrew = true }
check('音频偏移小于头部长度时抛错', offThrew)

// 不是 KGM
let magicThrew = false
try { decryptKgm(Buffer.alloc(2000, 0x22), { pubKey: new Uint8Array(fakePub) }) } catch { magicThrew = true }
check('magic 不对时抛错', magicThrew)

/* ================================================================== *
 * 7. 实际公钥表可用性
 * ================================================================== */
section('7. 酷狗公钥表')
check('公钥表文件存在', (await import('node:fs')).existsSync(KGM_CONSTANTS.KEY_BIN))
const { loadKugouKey } = await import('./lib/crypto/kgm.js')
let pubTable = null
try { pubTable = loadKugouKey() } catch (e) { console.log('    ' + e.message.split('\n')[0]) }
check('能载入公钥表', !!pubTable, '')
if (pubTable) {
  console.log('    大小 ' + (pubTable.length / 1048576).toFixed(2) + ' MB，可覆盖 ' +
    (pubTable.length * 16 / 1048576).toFixed(0) + ' MB 音频')
  check('公钥表大小合理（≥1MB）', pubTable.length >= 1048576, String(pubTable.length))
  check('前 16 字节是 0（与完整表前缀一致）', pubTable.subarray(0, 16).every((v) => v === 0))
}

section('结果')
console.log(`  通过 ${pass}    失败 ${fail}`)
if (fails.length) fails.forEach((f) => console.log('    ❌ ' + f))
console.log('')
console.log(fail === 0 ? '  ✅ 全部通过' : '  ❌ 有失败项')
process.exit(fail === 0 ? 0 : 1)
