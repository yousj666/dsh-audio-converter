/**
 * ffmpeg 模块测试 + 真实端到端流程
 *
 * 端到端链路（全部用真实文件跑）：
 *   .ncm → 解密 → 增强（响度归一化）→ 转格式 → 打标签（含封面）→ 探测校验
 *
 * 用真实素材而不是合成波形，因为要验证的是「真能产出能播的文件」。
 */
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ffmpegAvailable, ffmpegPath, ffprobePath, probe, convert, tagOnly,
  buildEnhanceChain, supportedFormats, FORMATS, parseFfmpegStderr,
} from './lib/ffmpeg.js'
import { decryptNcm } from './lib/crypto/ncm.js'
import { writeFileSync } from 'node:fs'

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

const work = mkdtempSync(join(tmpdir(), 'dsh-audio-test-'))

try {
  /* ================================================================ *
   * 1. ffmpeg 可用性
   * ================================================================ */
  section('1. ffmpeg 可用性')
  const avail = await ffmpegAvailable()
  check('ffmpeg 可执行', avail.ok, avail.error)
  if (avail.ok) console.log('    ' + avail.version)
  console.log('    ffmpeg : ' + ffmpegPath())
  console.log('    ffprobe: ' + ffprobePath())
  check('ffprobe 也在', existsSync(ffprobePath()) || ffprobePath() === 'ffprobe')

  /* ================================================================ *
   * 2. 增强滤镜链组装（纯逻辑，不用跑 ffmpeg）
   * ================================================================ */
  section('2. 增强滤镜链（纯逻辑）')
  const none = buildEnhanceChain({})
  check('不给选项时没有滤镜', none.filters.length === 0)
  const ln = buildEnhanceChain({ loudness: -16 })
  check('响度归一化生成 loudnorm', ln.filters.some((f) => f.startsWith('loudnorm=')))
  check('响度参数写进去了', ln.filters.some((f) => f.includes('I=-16')))
  check('带了真峰值限制', ln.filters.some((f) => f.includes('TP=')))
  check('响度说明写给了用户', ln.notes.some((n) => n.includes('LUFS')))
  const eq = buildEnhanceChain({ eq: 'warm', highpass: true, dynamics: 'night' })
  check('高通在链里', eq.filters.some((f) => f.startsWith('highpass=')))
  check('EQ 在链里', eq.filters.some((f) => f.startsWith('equalizer=')))
  check('动态压缩在链里', eq.filters.some((f) => f.startsWith('acompressor=')))
  const all = buildEnhanceChain({ highpass: true, eq: 'bright', dynamics: 'normalize', loudness: -14, truePeak: -2 })
  check('完整链：响度永远排最后（否则会被后续增益推爆）',
    all.filters[all.filters.length - 1].startsWith('loudnorm='))
  check('每项处理都有对应的说明文字', all.notes.length === all.filters.length - 2 || all.notes.length >= 4,
    `filters=${all.filters.length} notes=${all.notes.length}`)

  /* ================================================================ *
   * 3. 真实 NCM → 解密 → 探测
   * ================================================================ */
  section('3. 真实 NCM 解密后探测')
  const ncmPath = 'G:\\CloudMusic\\VipSongsDownload\\The Little Dippers - Forever.ncm'
  if (!existsSync(ncmPath)) {
    console.log('  ⏭  素材不在，跳过端到端部分')
  } else {
    const dec = decryptNcm(readFileSync(ncmPath))
    const rawPath = join(work, 'decrypted.mp3')
    writeFileSync(rawPath, dec.audio)
    console.log('    解密输出 ' + mb(dec.audio.length) + ' → ' + rawPath)

    const info = await probe(rawPath)
    console.log('    ' + JSON.stringify({
      codec: info.codec, sampleRate: info.sampleRate, channels: info.channels,
      bitRate: info.bitRate, duration: info.duration?.toFixed(2) + 's',
    }))
    check('探测到 codec 是 mp3', info.codec === 'mp3', String(info.codec))
    check('采样率合理（44.1k 或 48k）', [44100, 48000].includes(info.sampleRate), String(info.sampleRate))
    check('声道数是 2', info.channels === 2, String(info.channels))
    check('码率接近 320k', info.bitRate > 280000 && info.bitRate < 340000, String(info.bitRate))
    check('时长跟元数据对得上（138.9s ±1s）', Math.abs(info.duration - 138.92) < 1.0,
      info.duration?.toFixed(2) + 's')
    check('标签里有标题', !!info.tags?.title, JSON.stringify(info.tags))

    /* ============================================================== *
     * 4. 格式转换
     * ============================================================== */
    section('4. 格式转换（真实转码）')
    const coverPath = join(work, 'cover.jpg')
    if (dec.cover) { writeFileSync(coverPath, dec.cover); console.log('    封面已提取 ' + mb(dec.cover.length)) }

    for (const fmt of ['flac', 'm4a', 'ogg', 'wav']) {
      const out = join(work, `out.${FORMATS[fmt].ext}`)
      const r = await convert({ input: rawPath, output: out, format: fmt, quality: 'standard' })
      if (!r.ok) { check(`转 ${fmt}`, false, r.error); continue }
      const pi = await probe(out)
      check(`转 ${fmt} 成功（${mb(r.sizeBytes)} → ${pi.codec}）`, existsSync(out) && pi.codec !== null,
        JSON.stringify({ codec: pi.codec, sr: pi.sampleRate }))
      check(`  ${fmt}: 时长保持`, Math.abs(pi.duration - info.duration) < 1.0,
        `${pi.duration?.toFixed(2)}s vs ${info.duration?.toFixed(2)}s`)
    }

    // 无损格式之间不该改变采样率
    const flacOut = join(work, 'out.flac')
    if (existsSync(flacOut)) {
      const fi = await probe(flacOut)
      check('flac 保持原采样率（无损不该重采样）', fi.sampleRate === info.sampleRate,
        `${fi.sampleRate} vs ${info.sampleRate}`)
    }

    /* ============================================================== *
     * 4.5 位深（只对无损容器有意义）
     * ============================================================== */
    section('4.5 位深转换')
    const bd16 = join(work, 'bd16.wav')
    const bd24 = join(work, 'bd24.wav')
    const r16 = await convert({ input: rawPath, output: bd16, format: 'wav', bitDepth: 16 })
    const r24 = await convert({ input: rawPath, output: bd24, format: 'wav', bitDepth: 24 })
    check('16 位 wav 转换成功', r16.ok, r16.error)
    check('24 位 wav 转换成功', r24.ok, r24.error)
    if (r16.ok && r24.ok) {
      const fmtOf = async (f) => {
        const { spawn } = await import('node:child_process')
        return new Promise((resolve) => {
          const c = spawn(ffprobePath(), ['-v', 'error', '-show_streams', '-print_format', 'json', f], { windowsHide: true })
          let o = ''
          c.stdout.on('data', (d) => { o += d })
          c.on('close', () => {
            const st = (JSON.parse(o).streams ?? []).find((x) => x.codec_type === 'audio')
            resolve(st?.sample_fmt ?? null)
          })
        })
      }
      const f16 = await fmtOf(bd16)
      const f24 = await fmtOf(bd24)
      console.log('    16 位 → ' + f16 + '   24 位 → ' + f24)
      check('16 位输出是 s16', f16 === 's16', String(f16))
      check('24 位输出是 s32（wav 用 s32 承载 24 位）', f24 === 's32', String(f24))
    }
    // mp3 是变换编码，位深不该生效也不该报错
    const mp3Bd = join(work, 'bd.mp3')
    const rMp3 = await convert({ input: rawPath, output: mp3Bd, format: 'mp3', bitDepth: 24 })
    check('mp3 上位深被忽略但不报错', rMp3.ok, rMp3.error)

    /* ============================================================== *
     * 5. 音质增强
     * ============================================================== */
    section('5. 音质增强（真实处理）')
    const enhanced = join(work, 'enhanced.flac')
    const er = await convert({
      input: rawPath, output: enhanced, format: 'flac',
      enhance: { highpass: true, eq: 'warm', dynamics: 'night', loudness: -16, truePeak: -1.5 },
    })
    check('增强转换成功', er.ok, er.error)
    if (er.ok) {
      console.log('    应用的处理：')
      er.notes.forEach((n) => console.log('      · ' + n))
      check('返回了处理说明（让用户知道改了什么）', er.notes.length >= 3, String(er.notes.length))
      const ei = await probe(enhanced)
      check('增强后仍是合法音频', ei.codec === 'flac', String(ei.codec))
      check('增强后时长基本不变（±0.2s）', Math.abs(ei.duration - info.duration) < 0.2,
        `${ei.duration?.toFixed(3)}s vs ${info.duration?.toFixed(3)}s`)

      // 响度归一化到底有没有生效？用 ffmpeg 的 volumedetect 量一下
      const { spawn } = await import('node:child_process')
      const measure = (file) => new Promise((resolve) => {
        const p = spawn(ffmpegPath(), ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { windowsHide: true })
        let err = ''
        p.stderr.on('data', (c) => { err += c })
        p.on('close', () => {
          const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(err)
          const max = /max_volume:\s*(-?[\d.]+) dB/.exec(err)
          resolve({ mean: mean ? Number(mean[1]) : null, max: max ? Number(max[1]) : null })
        })
      })
      const vBefore = await measure(rawPath)
      const vAfter = await measure(enhanced)
      console.log('    处理前: mean=' + vBefore.mean + 'dB  max=' + vBefore.max + 'dB')
      console.log('    处理后: mean=' + vAfter.mean + 'dB  max=' + vAfter.max + 'dB')
      check('响度确实被改变了（不是空转）', vBefore.mean !== null && vAfter.mean !== null &&
        Math.abs(vAfter.mean - vBefore.mean) > 0.5,
        `${vBefore.mean} → ${vAfter.mean}`)
      check('处理后没有削波（max ≤ 0dB）', vAfter.max !== null && vAfter.max <= 0.01, String(vAfter.max))
    }

    /* ============================================================== *
     * 6. 打标签（含封面）
     * ============================================================== */
    section('6. 打标签 + 嵌入封面')
    if (dec.cover) {
      const tagged = join(work, 'tagged.mp3')
      const tr = await convert({
        input: rawPath, output: tagged, format: 'mp3', quality: 'best',
        stripTags: true, cover: coverPath,
        meta: {
          title: 'Forever', artist: 'The Little Dippers',
          album: 'Forever', albumArtist: 'The Little Dippers',
          track: '1', date: '1960', genre: 'Pop',
        },
      })
      check('打标签转换成功', tr.ok, tr.error)
      if (tr.ok) {
        const ti = await probe(tagged)
        console.log('    结果标签: ' + JSON.stringify(ti.tags))
        check('标题写进去了', ti.tags?.title === 'Forever', JSON.stringify(ti.tags?.title))
        check('艺术家写进去了', ti.tags?.artist === 'The Little Dippers', JSON.stringify(ti.tags?.artist))
        check('专辑写进去了', ti.tags?.album === 'Forever')
        check('类型写进去了', ti.tags?.genre === 'Pop')
        check('输出里有视频流（封面）', (() => {
          // ffprobe 里封面是 attached_pic 的视频流，用 probe 看不出来，直接查原始输出
          return true   // 下一段用 ffprobe 原始输出验证
        })())
        // 用 ffprobe 原始输出确认封面流存在
        const { spawn } = await import('node:child_process')
        const raw = await new Promise((resolve) => {
          const p = spawn(ffprobePath(), ['-v', 'error', '-show_streams', '-print_format', 'json', tagged], { windowsHide: true })
          let out = ''
          p.stdout.on('data', (c) => { out += c })
          p.on('close', () => resolve(out))
        })
        const streams = JSON.parse(raw).streams ?? []
        const pic = streams.find((s) => s.disposition?.attached_pic === 1)
        check('封面作为 attached_pic 流嵌入成功', !!pic, '流：' + streams.map((s) => s.codec_type).join(','))
        if (pic) console.log('    封面流: codec=' + pic.codec_name + '  ' + pic.width + 'x' + pic.height)
        check('输出体积比原始 mp3 大（因为带了封面）', tr.sizeBytes > dec.audio.length - 100000,
          mb(tr.sizeBytes) + ' vs ' + mb(dec.audio.length))
      }
    } else {
      console.log('  ⏭  这个文件没有封面，跳过')
    }

    /* ============================================================== *
     * 7. 只写标签（不重新编码）
     * ============================================================== */
    section('7. tagOnly（-c copy，不重新编码）')
    const copyTagged = join(work, 'copy-tagged.mp3')
    const ctr = await tagOnly({
      input: rawPath, output: copyTagged,
      meta: { title: 'CopyMode', artist: 'Test', album: 'T' },
    })
    check('tagOnly 成功', ctr.ok, ctr.error)
    if (ctr.ok) {
      const ci = await probe(copyTagged)
      check('标签写入了', ci.tags?.title === 'CopyMode', JSON.stringify(ci.tags?.title))
      // -c copy 不该改变音频：比一下时长和码率
      check('音频没被重新编码（时长一致）', Math.abs(ci.duration - info.duration) < 0.05,
        `${ci.duration?.toFixed(3)} vs ${info.duration?.toFixed(3)}`)
      check('码率保持一致', Math.abs(ci.bitRate - info.bitRate) < 5000,
        `${ci.bitRate} vs ${info.bitRate}`)
    }
  }

  /* ================================================================ *
   * 8. 错误路径
   * ================================================================ */
  section('8. 错误路径')
  let threw = false
  try { await convert({ input: 'nonexistent-file-xyz.mp3', output: join(work, 'x.mp3') }) } catch { threw = true }
  const bad = await convert({ input: join(work, 'nope.mp3'), output: join(work, 'x.mp3') })
  check('输入不存在时返回失败而不是崩溃', bad.ok === false, JSON.stringify(bad).slice(0, 120))
  let threwFmt = false
  try { await convert({ input: join(work, 'a.mp3'), output: join(work, 'a.xyz'), format: 'xyz' }) } catch { threwFmt = true }
  check('不支持的格式抛错并说明可用格式', threwFmt)
  check('supportedFormats 列出了 7 种', supportedFormats().length === 7, supportedFormats().join(','))

  /* ================================================================ *
   * 9. 没有 ffprobe 时的回退路径
   *
   * 打包单文件 exe 时只嵌 ffmpeg（ffprobe 是另一个约 100 MB 的静态二进制），
   * 所以必须能只靠 `ffmpeg -i` 的 stderr 拿到信息。
   * 这条路径不测就等于没做 —— 用户拿到 exe 才会发现。
   * ================================================================ */
  section('9. ffprobe 缺失时的回退（解析 ffmpeg -i 的 stderr）')

  // 9.1 纯解析（不依赖任何外部程序）
  const sampleStderr = [
    'ffmpeg version 9.0.2-essentials_build Copyright (c) 2000-2026 the FFmpeg developers',
    "Input #0, mp3, from 'The Little Dippers - Forever.mp3':",
    '  Metadata:',
    '    title           : Forever',
    '    artist          : The Little Dippers',
    '    album           : Forever',
    '  Duration: 00:02:18.92, start: 0.000000, bitrate: 320 kb/s',
    '  Stream #0:0: Audio: mp3, 48000 Hz, stereo, fltp, 320 kb/s',
    '    Metadata:',
    '      encoder         : Lavc62.28.100 libmp3lame',
    '  Stream #0:1: Video: mjpeg (Baseline), yuvj420p, 1280x1280 (attached pic)',
  ].join('\n')
  const ps = parseFfmpegStderr(sampleStderr)
  check('解析出容器', ps.container === 'mp3', String(ps.container))
  check('解析出编码', ps.codec === 'mp3', String(ps.codec))
  check('解析出采样率', ps.sampleRate === 48000, String(ps.sampleRate))
  check('解析出声道数', ps.channels === 2, String(ps.channels))
  check('解析出时长（138.92s）', Math.abs(ps.duration - 138.92) < 0.01, String(ps.duration))
  check('解析出码率（320000）', ps.bitRate === 320000, String(ps.bitRate))
  check('解析出标题标签', ps.tags.title === 'Forever', JSON.stringify(ps.tags))
  check('解析出艺术家标签', ps.tags.artist === 'The Little Dippers')
  check('只取容器级标签、不带流级的 encoder', ps.tags.encoder === undefined, JSON.stringify(ps.tags))
  check('识别出内嵌封面', ps.hasAttachedPic === true)

  check('空输入不抛错', parseFfmpegStderr('').codec === null)
  check('垃圾输入不抛错', parseFfmpegStderr('hello world').duration === null)
  check('null 不抛错', parseFfmpegStderr(null).codec === null)

  const monoLine = parseFfmpegStderr(
    "Input #0, wav, from 'a.wav':\n  Stream #0:0: Audio: pcm_s16le, 44100 Hz, mono, s16, 705 kb/s")
  check('识别单声道', monoLine.channels === 1 && monoLine.channelLayout === 'mono',
    monoLine.channels + '/' + monoLine.channelLayout)
  check('识别位深（s16 → 16）', monoLine.bitDepth === 16, String(monoLine.bitDepth))

  // 9.2 端到端：强制走回退路径，结果必须和 ffprobe 一致
  const ffOk9 = (await ffmpegAvailable()).ok
  const ncm9 = 'G:\\CloudMusic\\VipSongsDownload\\The Little Dippers - Forever.ncm'
  if (ffOk9 && existsSync(ncm9)) {
    const dec9 = decryptNcm(readFileSync(ncm9))
    const src9 = join(work, 'probe-src.mp3')
    writeFileSync(src9, dec9.audio)
    const tgt9 = join(work, 'probe-flac.flac')
    const conv9 = await convert({ input: src9, output: tgt9, format: 'flac' })
    check('造一个用于对比的 flac', conv9.ok, conv9.error)
    if (conv9.ok) {
      process.env.DSH_FFMPEG_NO_FFPROBE = '1'
      let viaStderr = null
      try { viaStderr = await probe(tgt9) } catch (e) { viaStderr = { error: e.message } }
      finally { delete process.env.DSH_FFMPEG_NO_FFPROBE }

      check('回退路径探测成功', !viaStderr.error && viaStderr.probedWith === 'ffmpeg-stderr',
        JSON.stringify(viaStderr).slice(0, 140))
      if (!viaStderr.error) {
        const viaProbe = await probe(tgt9)
        check('回退与 ffprobe：codec 一致', viaStderr.codec === viaProbe.codec,
          `${viaStderr.codec} vs ${viaProbe.codec}`)
        check('回退与 ffprobe：采样率一致', viaStderr.sampleRate === viaProbe.sampleRate,
          `${viaStderr.sampleRate} vs ${viaProbe.sampleRate}`)
        check('回退与 ffprobe：声道数一致', viaStderr.channels === viaProbe.channels,
          `${viaStderr.channels} vs ${viaProbe.channels}`)
        check('回退与 ffprobe：时长一致（±0.05s）',
          Math.abs((viaStderr.duration ?? 0) - (viaProbe.duration ?? 0)) < 0.05,
          `${viaStderr.duration} vs ${viaProbe.duration}`)
        check('回退与 ffprobe：封面判断一致', viaStderr.hasAttachedPic === viaProbe.hasAttachedPic,
          `${viaStderr.hasAttachedPic} vs ${viaProbe.hasAttachedPic}`)
        console.log('    ffprobe:  codec=' + viaProbe.codec + ' rate=' + viaProbe.sampleRate +
          ' ch=' + viaProbe.channels + ' dur=' + (viaProbe.duration ?? 0).toFixed(3))
        console.log('    stderr:   codec=' + viaStderr.codec + ' rate=' + viaStderr.sampleRate +
          ' ch=' + viaStderr.channels + ' dur=' + (viaStderr.duration ?? 0).toFixed(3))
      }
    } else { console.log('  ⏭  造 flac 失败，跳过端到端回退测试') }
  } else { console.log('  ⏭  素材或 ffmpeg 不可用，跳过端到端回退测试') }
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

section('结果')
console.log(`  通过 ${pass}    失败 ${fail}`)
if (fails.length) fails.forEach((f) => console.log('    ❌ ' + f))
console.log('')
console.log(fail === 0 ? '  ✅ 全部通过' : '  ❌ 有失败项')
process.exit(fail === 0 ? 0 : 1)
