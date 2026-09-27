/**
 * QMC v2 解密器测试
 *
 * 黄金值全部由一份**独立的 Python 参考实现**算出（按公开规范另写，不 import 原项目）。
 * v2 的密钥链很长（base64 → TEA → 交错 key → TEA → 主密钥 → Map/RC4 流），
 * 中间任何一步翻译错了都会在某个黄金值上暴露出来。
 *
 * 覆盖：
 *   · simple_key_8（float32 语义，最容易错）
 *   · TEA CBC 解密（两组密钥）
 *   · compress_key / qmc2_hash / segment_key
 *   · ekey_v1 派生
 *   · 尾包解析（STag / QTag / MusicEx / PcV1Legacy 四种形态）
 *   · 端到端：自造一个带内嵌 EKey 的 v2 文件 → 解密 → 逐字节比对
 *   · 失败路径：尾包无密钥时必须给出**可操作**的提示
 */
import {
  simpleKey8, teaCbcDecrypt, teaDecryptBlock, ekeyV1, deriveMasterKey,
  compressKey, qmc2Hash, segmentKey, makeQmc2Stream, parseFooter, decryptQmc,
  EKEY_V2_KEY2, MapStream, Rc4Stream, QMC2_CONSTANTS,
} from './lib/crypto/qmc2.js'
import { qmc1Transform } from './lib/crypto/qmc.js'
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
const H = (b) => Buffer.from(b).toString('hex')
const fh = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex')

/* ================================================================== *
 * 1. simple_key_8 —— float32 语义
 * ================================================================== */
section('1. simple_key_8（float32 语义，不用 fround 就会错）')
const sk = simpleKey8()
check('8 字节', sk.length === 8)
check('与独立 Python 实现一致（695646382b20150b）', H(sk) === '695646382b20150b', H(sk))
check('每个值都在 0..255', [...sk].every((v) => v >= 0 && v <= 255))

/* ================================================================== *
 * 2. TEA CBC 解密
 * ================================================================== */
section('2. TEA CBC 解密（两组密钥）')

// 用 simple_key_8 与 header 01..08 交错出的 16 字节密钥
const HDR = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
const TK = Buffer.allocUnsafe(16)
for (let i = 0; i < 8; i++) { TK[i * 2] = sk[i]; TK[i * 2 + 1] = HDR[i] }
check('交错密钥与 Python 一致', H(TK) === '69015602460338042b05200615070b08', H(TK))

const body1 = fh('303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a')
const ct1 = fh('11cba7ed6e79301845a8eff4b150c95740ee45fdff0b62080e6be7a2f8bca2edaee7cc7ba879fa0ccb0907154f4020642fe48141f8af7072')
const out1 = teaCbcDecrypt(ct1, TK)
check('TEA 解密（交错密钥）与 Python 一致', Buffer.compare(out1, body1) === 0,
  '得到 ' + H(out1).slice(0, 40) + '…')

const ct2 = fh('0882a3f1a45a1e3415770b685ac3bfb6309825b1c5c670db33e29f19da2437b40bef24a23d4f2e058495e28f7e4a65dfaaab48e3f6d68fad')
const out2 = teaCbcDecrypt(ct2, EKEY_V2_KEY2)
check('TEA 解密（EKEY_V2_KEY2）与 Python 一致', Buffer.compare(out2, body1) === 0,
  '得到 ' + H(out2).slice(0, 40) + '…')

// 密钥不对 → 尾部校验必须失败，不能静默吐垃圾
let badThrew = false
let badMsg = ''
try { teaCbcDecrypt(ct1, Buffer.alloc(16, 0x55)) } catch (e) { badThrew = true; badMsg = e.message }
check('密钥不对时尾部校验失败并抛错', badThrew, badMsg.slice(0, 60))
check('错误信息说明了原因', /尾部校验|TEA/.test(badMsg), badMsg.slice(0, 60))

let shortThrew = false
try { teaCbcDecrypt(Buffer.alloc(4), TK) } catch { shortThrew = true }
check('密文过短时抛错', shortThrew)

const notMul8 = false
let mul8Threw = false
try { teaCbcDecrypt(Buffer.alloc(12), TK) } catch { mul8Threw = true }
check('密文长度非 8 倍数时抛错', mul8Threw)

check('teaDecryptBlock 是确定性函数',
  teaDecryptBlock(0x0123456789abcdefn, [1, 2, 3, 4]) === teaDecryptBlock(0x0123456789abcdefn, [1, 2, 3, 4]))

/* ================================================================== *
 * 3. compress_key / 散列 / 分段
 * ================================================================== */
section('3. compress_key · qmc2_hash · segment_key')
const LK = fh('0d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6')
const map = compressKey(LK)
check('compress_key 输出 128 字节', map.length === 128)
check('compress_key 与 Python 一致',
  H(map) === '3fbac171fff7c23c3f38c2f3ff75c1be3fbec175fff3c2383f3cc2f7ff71c1ba3fbac171fff7c23c3f38c2f3ff75c1be3fbec175fff3c2383f3cc2f7ff71c1ba3fbac171fff7c23c3f38c2f3ff75c1be3fbec175fff3c2383f3cc2f7ff71c1ba3fbac171fff7c23c3f38c2f3ff75c1be3fbec175fff3c2383f3cc2f7ff71c1ba',
  H(map).slice(0, 48) + '…')
check('空密钥时抛错', (() => { try { compressKey(new Uint8Array(0)); return false } catch { return true } })())

const hash = qmc2Hash(LK)
check('qmc2_hash 与 Python 一致（469722240）', hash === 469722240n, hash.toString())

const segCases = [[0, 13, 3613248000], [1, 20, 1174305600], [2, 27, 579904000], [17, 132, 19769454], [100, 9, 51674613]]
let segOk = 0
for (const [seg, seed, expect] of segCases) {
  if (segmentKey(seg, seed, hash) === expect) segOk++
}
check(`segment_key 5 个用例全部与 Python 一致`, segOk === 5, `${segOk}/5`)
check('seed=0 时返回 0', segmentKey(7, 0, hash) === 0)

/* ================================================================== *
 * 4. EKey → 主密钥
 * ================================================================== */
section('4. EKey 派生主密钥')
const EKEY = 'AQIDBAUGBwh2I3F0mPGk/yiZ4thypNIG6SReomR2KeD7HNnJYt2oPw=='
const MASTER = '01020304050607084d41535445524b45592d30313233343536373839'
const master = deriveMasterKey(EKEY)
check('ekey_v1 派生与 Python 一致', H(master) === MASTER, H(master))
check('主密钥 = header(8) + 正文（前 8 字节是 header）',
  H(master.subarray(0, 8)) === '0102030405060708', H(master.subarray(0, 8)))

// 走 v2 双段前缀的分支：v2 前缀 + 非法载荷 → 应当抛错而不是静默返回
let v2Threw = false
try { deriveMasterKey(QMC2_CONSTANTS.EKEY_V2_PREFIX + Buffer.alloc(16).toString('base64')) } catch { v2Threw = true }
check('v2 双段前缀 + 垃圾载荷时抛错', v2Threw)

let shortThrew2 = false
try { ekeyV1(Buffer.from([1, 2, 3]).toString('base64')) } catch { shortThrew2 = true }
check('EKey 解码后不足 8 字节时抛错', shortThrew2)

/* ================================================================== *
 * 5. 尾包解析（四种形态）
 * ================================================================== */
section('5. 尾包解析')
const tail = (payload) => Buffer.concat([Buffer.alloc(1024 - payload.length, 0x11), payload])

// PcV1Legacy：小端长度 + base64 EKey
const ekeyB64 = Buffer.from(EKEY, 'latin1')
const legacyLen = Buffer.alloc(4); legacyLen.writeUInt32LE(ekeyB64.length, 0)
const fLegacy = parseFooter(tail(Buffer.concat([ekeyB64, legacyLen])))
check('PcV1Legacy 解析出 EKey', fLegacy?.kind === 'PcV1Legacy' && fLegacy.ekey === EKEY, JSON.stringify(fLegacy))
check('PcV1Legacy size = 长度 + 4', fLegacy?.size === ekeyB64.length + 4, String(fLegacy?.size))

// QTag：csv = ekey,resourceId,2
const qtagCsv = Buffer.from(`${EKEY},12345,2`, 'latin1')
const qtagLen = Buffer.alloc(4); qtagLen.writeUInt32BE(qtagCsv.length, 0)
const fQtag = parseFooter(tail(Buffer.concat([qtagCsv, qtagLen, Buffer.from('QTag')])))
check('QTag 解析出 EKey 与资源号',
  fQtag?.kind === 'QTag' && fQtag.ekey === EKEY && fQtag.resourceId === 12345, JSON.stringify(fQtag))

// STag：csv = resourceId,2,mid —— **没有 EKey**
const stagCsv = Buffer.from('67890,2,0011wjLv1bIkvv', 'latin1')
const stagLen = Buffer.alloc(4); stagLen.writeUInt32BE(stagCsv.length, 0)
const fStag = parseFooter(tail(Buffer.concat([stagCsv, stagLen, Buffer.from('STag')])))
check('STag 解析出资源元数据', fStag?.kind === 'STag' && fStag.resourceId === 67890 && fStag.mid === '0011wjLv1bIkvv',
  JSON.stringify(fStag))
check('STag 明确没有 EKey', fStag?.ekey === null)

// MusicEx：没有 EKey
const inner = Buffer.alloc(0xc0 - 0x10, 0)
Buffer.from([0x6d, 0x69, 0x64, 0x31, 0x00]).copy(inner, 12)   // mid 的 UTF-16LE
const musicExPayload = Buffer.concat([
  Buffer.alloc(0),                                        // inner_src 尾部
])
const meData = Buffer.concat([
  inner,
  (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0xc0, 0); return b })(),
])
const meBody = Buffer.concat([
  meData,
  (() => { const b = Buffer.alloc(4); b.writeUInt32LE(1, 0); return b })(),
])
const fMusicEx = parseFooter(tail(Buffer.concat([meBody, Buffer.from('musicex\x00', 'latin1')])))
check('MusicEx 被识别且没有 EKey', fMusicEx?.kind === 'MusicEx' && fMusicEx.ekey === null, JSON.stringify(fMusicEx))

// 不是 QMC 的文件
check('随机数据解析不出尾包', parseFooter(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])) === null)
check('过短输入返回 null', parseFooter(Buffer.alloc(4)) === null)

/* ================================================================== *
 * 6. 流密码
 * ================================================================== */
section('6. 流密码')
const ms = makeQmc2Stream(master)
check('主密钥 30 字节 → MapStream', ms instanceof MapStream)
const bigKey = Buffer.alloc(320, 7)
check('主密钥 320 字节 → Rc4Stream', makeQmc2Stream(bigKey) instanceof Rc4Stream)
check('主密钥为空时抛错', (() => { try { makeQmc2Stream(Buffer.alloc(0)); return false } catch { return true } })())

// MapStream 就是 compress_key + qmc1_transform，验一下等价
const payload = Buffer.alloc(300)
for (let i = 0; i < payload.length; i++) payload[i] = (i * 29 + 3) & 0xff
const mapDirect = qmc1Transform(payload, compressKey(master), 0)
check('MapStream.decrypt 等价于 compress_key + qmc1_transform',
  Buffer.compare(ms.decrypt(payload), mapDirect) === 0)

// RC4 流：自逆（异或流）
const rc4 = makeQmc2Stream(bigKey)
check('Rc4Stream 解密是自逆的',
  Buffer.compare(rc4.decrypt(rc4.decrypt(payload)), payload) === 0)
// 另一条独立的 Rc4Stream 应当给出同样结果（状态是构造时确定的）
check('Rc4Stream 结果可复现',
  Buffer.compare(makeQmc2Stream(bigKey).decrypt(payload), rc4.decrypt(payload)) === 0)

/* ================================================================== *
 * 7. 端到端：自造带内嵌 EKey 的 v2 文件
 * ================================================================== */
section('7. 端到端（自造 PcV1Legacy 文件）')
const fakeFlac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(5000, 0x42)])
// MapStream 是自逆的，所以"加密"就是再变换一次
const cipher = ms.decrypt(fakeFlac)
const ekeyBuf = Buffer.from(EKEY, 'latin1')
const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(ekeyBuf.length, 0)
const v2File = Buffer.concat([cipher, ekeyBuf, lenBuf])

const dec = decryptQmc(v2File, { filename: 'song.mflac' })
check('识别为 v2', dec.generation === 'v2', dec.generation)
check('尾包类型 PcV1Legacy', dec.footerKind === 'PcV1Legacy', String(dec.footerKind))
check('用了内嵌 EKey', dec.embeddedEkey === true)
check('音频逐字节一致', Buffer.compare(dec.audio, fakeFlac) === 0,
  `${dec.audio.length}B vs ${fakeFlac.length}B`)
check('嗅探出 flac', dec.format === 'flac', String(dec.format))

// 同样内容走 QTag 尾包
const qtagCsv2 = Buffer.from(`${EKEY},999,2`, 'latin1')
const qtagLen2 = Buffer.alloc(4); qtagLen2.writeUInt32BE(qtagCsv2.length, 0)
const qtagFile = Buffer.concat([cipher, qtagCsv2, qtagLen2, Buffer.from('QTag')])
const decQtag = decryptQmc(qtagFile, { filename: 'song.mgg' })
check('QTag 路径也能解出来', decQtag.footerKind === 'QTag' && Buffer.compare(decQtag.audio, fakeFlac) === 0,
  String(decQtag.footerKind))

/* ================================================================== *
 * 8. 失败路径：必须给出可操作的提示
 * ================================================================== */
section('8. 尾包无密钥时的提示')
const stagCsv2 = Buffer.from('111,2,0011mid', 'latin1')
const stagLen2 = Buffer.alloc(4); stagLen2.writeUInt32BE(stagCsv2.length, 0)
const stagFile = Buffer.concat([cipher, stagCsv2, stagLen2, Buffer.from('STag')])
let stagThrew = false
let stagMsg = ''
try { decryptQmc(stagFile, { filename: 'song.mgg' }) } catch (e) { stagThrew = true; stagMsg = e.message }
check('STag 无密钥时抛错', stagThrew)
check('提示里说明了「尾包没有内嵌密钥」', /没有内嵌密钥/.test(stagMsg), stagMsg.slice(0, 60))
check('提示里给了可操作的办法', /重新下载|player_process_db/.test(stagMsg))
console.log('    提示内容：')
stagMsg.split('\n').filter(Boolean).forEach((l) => console.log('      ' + l))

// 完全不是 QMC
let notQmc = false
try { decryptQmc(Buffer.alloc(2000, 0x77), { filename: 'x.mflac' }) } catch { notQmc = true }
check('不是 QMC 时抛错', notQmc)

// 外部 EKey 参数
const noEkeyFile = Buffer.concat([cipher, ekeyBuf, lenBuf])
const viaOpt = decryptQmc(noEkeyFile, { filename: 'x.mflac', ekey: EKEY })
check('也可以用外部 EKey 传入', Buffer.compare(viaOpt.audio, fakeFlac) === 0)

section('结果')
console.log(`  通过 ${pass}    失败 ${fail}`)
if (fails.length) fails.forEach((f) => console.log('    ❌ ' + f))
console.log('')
console.log(fail === 0 ? '  ✅ 全部通过' : '  ❌ 有失败项')
process.exit(fail === 0 ? 0 : 1)
