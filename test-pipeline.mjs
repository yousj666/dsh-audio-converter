/**
 * 管线测试：格式识别 → 解密 → 转换/增强/打标签
 *
 * 用真实 NCM 文件跑，覆盖：
 *   · 识别正确（含"改了后缀的普通文件"这种陷阱）
 *   · 只解密不转码
 *   · 解密 + 转码
 *   · 解密 + 增强 + 打标签 + 嵌封面
 *   · 解不了的格式要给**有意义的理由**，而不是含糊的失败
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectFormat, decryptionSupport, decryptToFile, processFile } from './lib/pipeline.js'
import { ffmpegAvailable } from './lib/ffmpeg.js'
import { deriveMasterKey, makeQmc2Stream } from './lib/crypto/qmc2.js'

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
const mb = (n) => (n / 1048576).toFixed(2) + ' MB'

const srcNcm = 'G:\\CloudMusic\\VipSongsDownload\\The Little Dippers - Forever.ncm'
const work = mkdtempSync(join(tmpdir(), 'dsh-audio-pipe-'))
const ffmpegOk = (await ffmpegAvailable()).ok

try {
  /* ================================================================ *
   * 1. 格式识别
   * ================================================================ */
  section('1. 格式识别')
  if (existsSync(srcNcm)) {
    const buf = readFileSync(srcNcm)
    const d = detectFormat(buf, srcNcm)
    check('真实 NCM 识别为 ncm', d.kind === 'ncm', JSON.stringify(d))
    check('标记为加密', d.encrypted === true)
    check('ncm 支持解密', decryptionSupport('ncm').ok)
  } else { console.log('  ⏭  真实 NCM 不在，跳过') }

  // 改了后缀的普通文件：应该按 magic 认成 plain，而不是按后缀当加密文件
  const fakeFlac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(2000, 0x11)])
  const d2 = detectFormat(fakeFlac, 'song.ncm')
  check('改了 .ncm 后缀的 FLAC 被认成 plain（看 magic 不看后缀）',
    d2.kind === 'plain' && d2.format === 'flac', JSON.stringify(d2))

  const d3 = detectFormat(fakeFlac, 'song.flac')
  check('普通 .flac 认成 plain', d3.kind === 'plain' && d3.encrypted === false)

  // KGM / VPR 的 magic
  const kgmBuf = Buffer.concat([
    Buffer.from([0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b, 0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14]),
    Buffer.alloc(2000, 0x22),
  ])
  const dk = detectFormat(kgmBuf, 'a.kgm')
  check('KGM magic 识别为 kgm', dk.kind === 'kgm', JSON.stringify(dk))
  const vprBuf = Buffer.concat([
    Buffer.from([0x05, 0x28, 0xbc, 0x96, 0xe9, 0xe4, 0x5a, 0x43, 0x91, 0xaa, 0xbd, 0xd0, 0x7a, 0xf5, 0x36, 0x31]),
    Buffer.alloc(2000, 0x33),
  ])
  const dv = detectFormat(vprBuf, 'a.vpr')
  check('VPR magic 识别为 kgm（VPR 变体）', dv.kind === 'kgm', JSON.stringify(dv))

  // STag 是**真实形态**：标记在文件最末尾，前面是 [csv][4B 大端长度]
  // 早先按标记嗅探会把它误判成「新版无解」，其实它是 v2、只是尾包不含密钥
  const stagCsv = Buffer.from('67890,2,0011wjLv1bIkvv', 'latin1')
  const stagLen = Buffer.alloc(4); stagLen.writeUInt32BE(stagCsv.length, 0)
  const stagBuf = Buffer.concat([Buffer.alloc(2000, 0x44), stagCsv, stagLen, Buffer.from('STag')])
  const dst = detectFormat(stagBuf, 'a.mgg')
  check('带 STag 尾包识别为 qmc2（v2，可解但缺密钥）', dst.kind === 'qmc2', JSON.stringify(dst))
  check('识别出尾包类型是 STag', dst.qmcFooterKind === 'STag', String(dst.qmcFooterKind))
  check('并明确标出「没有内嵌密钥」', dst.qmcHasEkey === false, String(dst.qmcHasEkey))

  // 内嵌 EKey 的 QTag 尾包 —— 这种是能直接解的
  const qtagCsv = Buffer.from('AQIDBAUGBwh2I3F0mPGk/yiZ4thypNIG6SReomR2KeD7HNnJYt2oPw==,12345,2', 'latin1')
  const qtagLen = Buffer.alloc(4); qtagLen.writeUInt32BE(qtagCsv.length, 0)
  const qtagBuf = Buffer.concat([Buffer.alloc(2000, 0x55), qtagCsv, qtagLen, Buffer.from('QTag')])
  const dqt = detectFormat(qtagBuf, 'a.mflac')
  check('带 QTag 尾包识别为 qmc2', dqt.kind === 'qmc2', JSON.stringify(dqt))
  check('并标出「有内嵌密钥」', dqt.qmcHasEkey === true, String(dqt.qmcHasEkey))

  const tkmBuf = Buffer.alloc(3000, 0x77)
  const dtk = detectFormat(tkmBuf, 'a.tkm')
  check('.tkm 识别为 qmc（v1，可解）', dtk.kind === 'qmc', JSON.stringify(dtk))

  // 不认识的
  check('乱码文件认成 unknown', detectFormat(Buffer.alloc(500, 0x99), 'x.bin').kind === 'unknown')

  /* ================================================================ *
   * 2. 解不了的时候，理由要说清楚
   * ================================================================ */
  section('2. 不支持格式的理由')
  const kgmSupport = decryptionSupport('kgm')
  check('KGM 现在支持解密', kgmSupport.ok === true, JSON.stringify(kgmSupport))

  const qmcSupport = decryptionSupport('qmc')
  check('QMC v1 现在支持解密', qmcSupport.ok === true, JSON.stringify(qmcSupport))

  const qmc2Support = decryptionSupport('qmc2')
  check('QMC v2 现在支持解密', qmc2Support.ok === true, JSON.stringify(qmc2Support))

  const newSupport = decryptionSupport('qmc2-new')
  check('最新一代 QMC 明确说不支持', newSupport.ok === false)
  check('理由说明「动态密钥 + 设备指纹」', /动态密钥/.test(newSupport.reason) && /设备指纹/.test(newSupport.reason))
  check('理由包含「离线在原理上解不了」', /离线.*解不了|离线无法解密/.test(newSupport.reason))
  check('理由给了可行替代方案', /客户端|19\.51/.test(newSupport.reason))
  console.log('    qmc2-new 的提示文字：')
  newSupport.reason.split('。').filter(Boolean).forEach((s) => console.log('      · ' + s))

  const xmSupport = decryptionSupport('xm')
  check('XM 说明虾米已停服', /停止服务/.test(xmSupport.reason), xmSupport.reason)

  /* ================================================================ *
   * 3. 真实文件：只解密
   * ================================================================ */
  section('3. 真实 NCM：只解密不转码')
  if (!existsSync(srcNcm)) {
    console.log('  ⏭  素材不在，跳过')
  } else {
    const outDir = join(work, 'decrypt-only')
    const r = await processFile({ input: srcNcm, outDir, embedCover: false, writeTags: false })
    check('解密成功', r.ok, r.error)
    if (r.ok) {
      console.log('    → ' + r.output)
      console.log('    ' + mb(r.sizeBytes) + ' → ' + mb(r.outSizeBytes) + '  用时 ' + r.elapsedMs + 'ms')
      r.notes.forEach((n) => console.log('      · ' + n))
      check('识别为 ncm', r.kind === 'ncm')
      check('输出格式 mp3', r.format === 'mp3', r.format)
      check('输出文件存在且非空', existsSync(r.output) && statSync(r.output).size > 1024)
      check('源信息探测到了时长', (r.srcInfo?.duration ?? 0) > 100, String(r.srcInfo?.duration))
      check('标签里解析出标题', r.meta?.title === 'Forever', JSON.stringify(r.meta?.title))
      check('标签里解析出艺术家', /Little Dippers/.test(r.meta?.artist ?? ''), JSON.stringify(r.meta?.artist))
      check('「格式相同不转码」这一点被说明', r.notes.some((n) => /无需解密|直接输出|解密成功/.test(n)))

      // 结构性断言：这个函数有「只解密」和「解密+转码」两条返回路径，
      // 两者的返回结构必须完全一致，否则调用方得按分支处理、很容易漏字段。
      // （第一版就漏了 srcInfo / meta，被这个测试抓出来了。）
      const KEY_FIELDS = ['ok', 'input', 'output', 'kind', 'srcFormat', 'format',
        'sizeBytes', 'outSizeBytes', 'elapsedMs', 'srcInfo', 'outInfo', 'meta', 'notes']
      const missing = KEY_FIELDS.filter((k) => !(k in r))
      check('只解密路径的返回结构完整（与转码路径一致）', missing.length === 0, '缺字段：' + missing.join(','))
    }

    /* ============================================================== *
     * 4. 真实文件：解密 + 转码
     * ============================================================== */
    section('4. 真实 NCM：解密 + 转 FLAC')
    const r2 = await processFile({
      input: srcNcm, outDir: join(work, 'to-flac'), format: 'flac', quality: 'standard',
      embedCover: false, writeTags: true,
    })
    check('转码成功', r2.ok, r2.error)
    if (r2.ok) {
      console.log('    ' + mb(r2.sizeBytes) + ' → ' + mb(r2.outSizeBytes) + '  用时 ' + r2.elapsedMs + 'ms')
      console.log('    源 ' + JSON.stringify(r2.srcInfo))
      console.log('    出 ' + JSON.stringify(r2.outInfo))
      check('输出是 flac 编码', r2.outInfo?.codec === 'flac', String(r2.outInfo?.codec))
      check('时长保持（±0.2s）', Math.abs((r2.outInfo?.duration ?? 0) - (r2.srcInfo?.duration ?? 0)) < 0.2,
        `${r2.outInfo?.duration} vs ${r2.srcInfo?.duration}`)
      check('采样率保持', r2.outInfo?.sampleRate === r2.srcInfo?.sampleRate,
        `${r2.outInfo?.sampleRate} vs ${r2.srcInfo?.sampleRate}`)
      check('输出文件名带 .flac', r2.output.endsWith('.flac'), r2.output)
    }

    /* ============================================================== *
     * 5. 真实文件：增强 + 封面 + 标签
     * ============================================================== */
    section('5. 真实 NCM：增强 + 嵌封面 + 写标签')
    const r3 = await processFile({
      input: srcNcm, outDir: join(work, 'enhanced'), format: 'mp3', quality: 'best',
      enhance: { highpass: true, eq: 'warm', loudness: -16, truePeak: -1.5 },
      embedCover: true, writeTags: true,
    })
    check('增强流程成功', r3.ok, r3.error)
    if (r3.ok) {
      console.log('    处理说明：')
      r3.notes.forEach((n) => console.log('      · ' + n))
      check('返回了处理说明', r3.notes.length >= 4, String(r3.notes.length))
      check('说明里包含封面已嵌入', r3.notes.some((n) => /封面已嵌入/.test(n)))
      check('说明里包含响度归一化', r3.notes.some((n) => /LUFS/.test(n)))
      check('输出比源大（多出封面）或无封面时合理', r3.outSizeBytes > 1000)
      check('输出是 mp3', r3.outInfo?.codec === 'mp3', String(r3.outInfo?.codec))
      // 采样率必须保持 —— loudnorm 内部会重采样，不锁住 -ar 会输出成 96kHz
      check('增强后采样率没被透镜改掉', r3.outInfo?.sampleRate === r3.srcInfo?.sampleRate,
        `${r3.outInfo?.sampleRate} vs 源 ${r3.srcInfo?.sampleRate}`)
      // 封面流验证
      const { spawn } = await import('node:child_process')
      const { ffprobePath } = await import('./lib/ffmpeg.js')
      const raw = await new Promise((resolve) => {
        const p = spawn(ffprobePath(), ['-v', 'error', '-show_streams', '-print_format', 'json', r3.output], { windowsHide: true })
        let s = ''
        p.stdout.on('data', (c) => { s += c })
        p.on('close', () => resolve(s))
      })
      const streams = JSON.parse(raw).streams ?? []
      check('输出里有封面流（attached_pic）', streams.some((s) => s.disposition?.attached_pic === 1),
        streams.map((s) => s.codec_type).join(','))
    }

    /* ============================================================== *
     * 6. 批量
     * ============================================================== */
    section('6. 批量处理（两个真实文件）')
    const ncmDir = 'G:\\CloudMusic\\VipSongsDownload'
    const all = existsSync(ncmDir) ? (await import('node:fs')).readdirSync(ncmDir).filter((f) => f.endsWith('.ncm')) : []
    if (all.length >= 2) {
      const results = []
      for (const f of all.slice(0, 3)) {
        results.push(await processFile({
          input: join(ncmDir, f), outDir: join(work, 'batch'), format: 'mp3',
          embedCover: false, writeTags: false,
        }))
      }
      check(`批量处理 ${results.length} 个文件全部成功`, results.every((r) => r.ok),
        results.filter((r) => !r.ok).map((r) => r.error).join('; '))
      results.forEach((r) => {
        if (r.ok) console.log('    · ' + r.output.split('\\').pop() + '  ' + mb(r.outSizeBytes) + '  ' + r.elapsedMs + 'ms')
      })
    } else { console.log('  ⏭  目录里没有足够的 ncm 文件') }

    /* ============================================================== *
     * 7. QMC v2 走完整管线（自造一个内嵌 EKey 的 .mflac）
     *
     * 单测里已经验过解密器本身，这里验的是**接进管线之后**：
     * 格式识别 → 解密 → 落盘 → 转码 整条路走不走得通。
     * ============================================================== */
    section('7. QMC v2 端到端（自造 .mflac）')
    if (ffmpegOk) {
      const EKEY = 'AQIDBAUGBwh2I3F0mPGk/yiZ4thypNIG6SReomR2KeD7HNnJYt2oPw=='
      const stream = makeQmc2Stream(deriveMasterKey(EKEY))
      // 造一段「真 flac 头 + 假音频」——嗅探只看头，转码才是真考验
      // 这里用一小段真 flac，好让 ffmpeg 真的能解
      const realFlac = join(work, 'seed.flac')
      const seedOk = await processFile({
        input: srcNcm, outDir: work, format: 'flac', embedCover: false, writeTags: false,
      })
      if (seedOk.ok) {
        const rawFlac = readFileSync(seedOk.output)
        const cipher = stream.decrypt(rawFlac)          // MapStream 自逆，这就是"加密"
        const ekeyBuf = Buffer.from(EKEY, 'latin1')
        const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(ekeyBuf.length, 0)
        const qmcPath = join(work, 'fake.mflac')
        writeFileSync(qmcPath, Buffer.concat([cipher, ekeyBuf, lenBuf]))

        const det = detectFormat(readFileSync(qmcPath), qmcPath)
        check('管线把自造 .mflac 识别为 qmc2', det.kind === 'qmc2', JSON.stringify(det))
        check('识别出尾包类型 PcV1Legacy', det.qmcFooterKind === 'PcV1Legacy', String(det.qmcFooterKind))
        check('识别出「有内嵌密钥」', det.qmcHasEkey === true, String(det.qmcHasEkey))
        check('decryptionSupport(qmc2) 说支持', decryptionSupport('qmc2').ok === true)

        // 只解密（格式相同 → 直接落盘）
        const rDec = await processFile({ input: qmcPath, outDir: join(work, 'qmc'), embedCover: false, writeTags: false })
        check('QMC v2 端到端解密成功', rDec.ok, rDec.error)
        if (rDec.ok) {
          console.log('    ' + mb(rDec.sizeBytes) + ' → ' + mb(rDec.outSizeBytes) + '  ' + rDec.kind + ' → ' + rDec.format)
          rDec.notes.forEach((n) => console.log('      · ' + n))
          check('输出就是原始 flac 字节', readFileSync(rDec.output).equals(rawFlac))
          check('说明里点出了尾包类型', rDec.notes.some((n) => /PcV1Legacy/.test(n)))
        }

        // 解密 + 转码
        const rConv = await processFile({
          input: qmcPath, outDir: join(work, 'qmc-mp3'), format: 'mp3', embedCover: false, writeTags: false,
        })
        check('QMC v2 解密 + 转码成功', rConv.ok, rConv.error)
        if (rConv.ok) check('输出是 mp3', rConv.outInfo?.codec === 'mp3', String(rConv.outInfo?.codec))

        // 尾包不含密钥时必须给出可操作提示
        const stagCsv = Buffer.from('111,2,0011mid', 'latin1')
        const stagLen = Buffer.alloc(4); stagLen.writeUInt32BE(stagCsv.length, 0)
        const stagPath = join(work, 'nostag.mgg')
        writeFileSync(stagPath, Buffer.concat([cipher, stagCsv, stagLen, Buffer.from('STag')]))
        const rStag = await processFile({ input: stagPath, outDir: join(work, 'stag'), embedCover: false, writeTags: false })
        check('STag 尾包时失败但有解释', !rStag.ok && /没有内嵌密钥/.test(rStag.error ?? ''), (rStag.error ?? '').slice(0, 70))
        check('解释里给了可行办法', /重新下载|player_process_db/.test(rStag.error ?? ''))

        // 传外部 EKey 就能解
        const rViaEkey = await processFile({
          input: stagPath, outDir: join(work, 'stag-ok'), ekey: EKEY, embedCover: false, writeTags: false,
        })
        check('提供外部 EKey 后 STag 也能解', rViaEkey.ok, rViaEkey.error)
        void realFlac
      } else { console.log('  ⏭  造种子 flac 失败，跳过') }
    } else { console.log('  ⏭  ffmpeg 不可用，跳过') }
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

section('结果')
console.log(`  通过 ${pass}    失败 ${fail}`)
if (fails.length) fails.forEach((f) => console.log('    ❌ ' + f))
console.log('')
console.log(fail === 0 ? '  ✅ 全部通过' : '  ❌ 有失败项')
process.exit(fail === 0 ? 0 : 1)
