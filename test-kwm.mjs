/**
 * KWM（酷我）解密器测试
 *
 * 手上没有真实 KWM 文件，所以：
 *   1. 按格式规范**造**一个（头部全零 + 32 字节循环密钥异或）
 *   2. 解回来，验证逐字节一致
 *   3. 重点测**密钥恢复**这条容易出错的路：
 *      · 相邻同块  · 半旋转回退  · 暴力扫描  · 认不出来时必须抛错而不是产出垃圾
 */
import { decryptKwm, isKwm, KWM_CONSTANTS } from './lib/crypto/kwm.js'
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

const { HEADER_LEN, KEY_LEN } = KWM_CONSTANTS

/**
 * 造一个 KWM。
 *
 * 关键：密钥恢复靠的是「明文静音（全零）→ 密文就等于密钥本身」。
 * 所以前导区必须是**全零**，异或完才会在密文里留下 key 的副本。
 * （如果前导区填 key，异或完就变全零了 —— 那就没东西可恢复。）
 * @param {Buffer} audio 真实音频（会跟在若干块密钥之后）
 * @param {Buffer} key 32 字节循环密钥
 * @param {{repeatKeyChunks?: number}} [opts] 前导放几块（2 块 → 相邻同块路径；1 块 → 只能暴力扫描）
 */
function buildKwm(audio, key, { repeatKeyChunks = 2 } = {}) {
  const lead = Buffer.alloc(KEY_LEN * repeatKeyChunks, 0)   // 静音
  const plain = Buffer.concat([lead, audio])
  const enc = Buffer.from(plain)
  for (let i = 0; i < enc.length; i++) enc[i] ^= key[i & (KEY_LEN - 1)]
  return Buffer.concat([Buffer.alloc(HEADER_LEN, 0), enc])
}

/* ================================================================== *
 * 1. 基本往返
 * ================================================================== */
section('1. 基本往返')
const key = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii')   // 32 字节
const fakeFlac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(4000, 0x7c), Buffer.from([9, 9, 9])])
const kwm = buildKwm(fakeFlac, key)

check('isKwm 接受足够长的文件', isKwm(kwm))
check('isKwm 拒绝过短的文件', !isKwm(Buffer.alloc(100)))

const out = decryptKwm(kwm)
check('解密成功', out.audio.length > 0)
check('密钥来源是「相邻同块」', out.keySource === '相邻同块', out.keySource)
check('识别出格式 flac', out.format === 'flac', String(out.format))
check('前导静音被识别出来', out.leadSilence === 64, String(out.leadSilence))

// 跳过前导静音后，音频载荷应逐字节一致
const payload = out.audio.subarray(out.leadSilence, out.leadSilence + fakeFlac.length)
check('音频载荷逐字节一致', Buffer.compare(payload, fakeFlac) === 0,
  `${payload.length}B vs ${fakeFlac.length}B`)
check('嗅探确认是 flac', sniffAudioFormat(payload) === 'flac')

/* ================================================================== *
 * 2. 不同音频内容（确保不是靠运气）
 * ================================================================== */
section('2. 随机内容往返（5 轮）')
let roundTripOk = 0
for (let round = 0; round < 5; round++) {
  const k = Buffer.alloc(KEY_LEN)
  for (let i = 0; i < KEY_LEN; i++) k[i] = (round * 37 + i * 11) & 0xff
  const audioLen = 1000 + round * 777
  const audio = Buffer.alloc(audioLen)
  // 用 mp3 风格的头（ID3）好让嗅探通过
  Buffer.from('ID3').copy(audio, 0)
  for (let i = 3; i < audioLen; i++) audio[i] = (i * 31 + round) & 0xff
  const f = buildKwm(audio, k)
  try {
    const r = decryptKwm(f)
    const got = r.audio.subarray(r.leadSilence, r.leadSilence + audio.length)
    if (Buffer.compare(got, audio) === 0) roundTripOk++
  } catch { /* 记到下面的断言里 */ }
}
check('5 轮随机内容全部往返正确', roundTripOk === 5, roundTripOk + '/5')

/* ================================================================== *
 * 3. 密钥恢复的回退路径
 * ================================================================== */
section('3. 密钥恢复的回退路径')
// 没有重复块 → 只能靠暴力扫描（首块恰好等于密钥）
const noRepeat = buildKwm(fakeFlac, key, { repeatKeyChunks: 1 })
const outNoRepeat = decryptKwm(noRepeat)
check('只有一个密钥块时仍能恢复（走暴力扫描）', outNoRepeat.format === 'flac', outNoRepeat.keySource)

// 完全认不出的文件 → 必须抛错，不能产出垃圾还报成功
const garbage = Buffer.concat([Buffer.alloc(HEADER_LEN, 0), Buffer.alloc(5000, 0x5a)])
let threw = false
let errMsg = ''
try { decryptKwm(garbage) } catch (e) { threw = true; errMsg = e.message }
check('认不出来时抛错（不静默产出垃圾）', threw, errMsg.slice(0, 80))
check('错误信息说清了试过哪些手段', /相邻同块|半旋转|暴力扫描|无法恢复/.test(errMsg), errMsg.slice(0, 100))

// 过短文件
let threwShort = false
try { decryptKwm(Buffer.alloc(50)) } catch { threwShort = true }
check('文件过短时抛错', threwShort)

/* ================================================================== *
 * 4. 常量
 * ================================================================== */
section('4. 常量')
check('HEADER_LEN = 1024', HEADER_LEN === 1024)
check('KEY_LEN = 32', KEY_LEN === 32)

section('结果')
console.log(`  通过 ${pass}    失败 ${fail}`)
if (fails.length) fails.forEach((f) => console.log('    ❌ ' + f))
console.log('')
console.log(fail === 0 ? '  ✅ 全部通过' : '  ❌ 有失败项')
process.exit(fail === 0 ? 0 : 1)
