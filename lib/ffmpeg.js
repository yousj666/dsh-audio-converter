// ffmpeg 封装：探测 / 转换 / 增强 / 打标签
//
// 关于「音质增强」的诚实说明
//   已经损失的信息**无法凭空恢复** —— 128kbps 的 mp3 转成 FLAC 不会变好听。
//   这个模块提供的是**真实有效**的处理，不是噱头：
//     · 响度归一化（EBU R128）—— 让音量一致，避免忽大忽小
//     · 重采样 / 位深转换     —— 匹配设备或做后续处理的前置步骤
//     · 动态范围处理          —— 压缩动态，小声也听得清（通勤、嘈杂环境有用）
//     · 均衡（EQ）           —— 补偿耳机/音箱的频响
//     · 真峰值限幅            —— 防止归一化后削波
//   这些都会**改变听感**，但不会恢复已被有损编码丢掉的高频细节。
//   界面上会明确写出这一点，不做「一键变无损」这种假承诺。
//
// @module dsh-audio-converter/ffmpeg
'use strict'

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { extractEmbeddedFfmpeg } from './resources.js'

/**
 * 常见 ffmpeg 位置。
 *
 * ⚠️ 为什么不能只靠 existsSync 判断
 *   WinGet 安装的 ffmpeg 在 `…\Microsoft\WinGet\Links\ffmpeg.exe`，
 *   那是**应用执行别名（App Execution Alias）** —— 一种特殊重解析点。
 *   PowerShell 的 Test-Path 和 where.exe 都能解析它，但 **Node 的 existsSync / stat 会 ENOENT**。
 *   所以这里把「路径存在」和「能执行」分开：候选路径只用来排序，
 *   真正判定是**试跑一次 -version**。这样才能对 symlink / alias / PATH 都成立。
 */
const FFMPEG_CANDIDATES = [
  join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  join(homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
  'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
  join(homedir(), 'AppData', 'Local', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  '/usr/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
  'ffmpeg',
]

/**
 * 在 WinGet 的 Packages 目录里找真正的可执行文件。
 * WinGet Links 只是个别名层，真身在 Packages 下的版本目录里。
 * @param {string} bin 'ffmpeg.exe' | 'ffprobe.exe'
 * @returns {string[]} 找到的绝对路径
 */
function findInWinGetPackages(bin) {
  const base = join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages')
  if (!existsSync(base)) return []
  const out = []
  try {
    for (const pkg of readdirSync(base)) {
      if (!/ffmpeg/i.test(pkg)) continue
      const pkgDir = join(base, pkg)
      // 结构是 <pkg>/<version-dir>/bin/<bin>，但版本目录名不固定，最多往下探 3 层
      const walk = (dir, depth) => {
        if (depth > 3 || out.length > 8) return
        let entries
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const p = join(dir, e.name)
          if (e.isFile() && e.name.toLowerCase() === bin.toLowerCase()) { out.push(p); continue }
          if (e.isDirectory()) walk(p, depth + 1)
        }
      }
      walk(pkgDir, 0)
    }
  } catch { /* 权限之类的问题，忽略 */ }
  return out
}

/** ffprobe 候选：从 ffmpeg 候选按规则换名，再加上 WinGet 深搜结果。 */
function ffprobeCandidates() {
  const mapped = FFMPEG_CANDIDATES.map((p) => {
    if (p === 'ffmpeg') return 'ffprobe'
    if (p === '/usr/bin/ffmpeg') return '/usr/bin/ffprobe'
    if (p === '/opt/homebrew/bin/ffmpeg') return '/opt/homebrew/bin/ffprobe'
    return p.replace(/ffmpeg\.exe$/i, 'ffprobe.exe').replace(/ffmpeg$/i, 'ffprobe')
  })
  return [...mapped, ...findInWinGetPackages('ffprobe.exe')]
}

/** 解析结果缓存 */
let resolved = null
let resolving = null

/**
 * 跑一个子进程并收集输出。
 * @param {string} cmd 可执行文件
 * @param {string[]} args 参数
 * @param {AbortSignal|undefined} signal 取消信号
 * @param {number} timeoutMs 超时
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean}>}
 */
function run(cmd, args, signal, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* 已退出 */ }
    }, timeoutMs)
    child.stdout.on('data', (c) => { stdout += c })
    // ffmpeg 把进度和错误都写到 stderr，保留尾部即可
    child.stderr.on('data', (c) => { stderr += c; if (stderr.length > 200000) stderr = stderr.slice(-100000) })
    const onAbort = () => { try { child.kill() } catch { /* 已退出 */ } }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ code: -1, stdout, stderr: String(error?.message ?? error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/**
 * 逐个试跑候选，返回第一个能跑通的。
 * @param {string[]} candidates 候选路径
 * @param {string[]} probeArgs 用来验证的参数
 * @returns {Promise<{path: string|null, version?: string, tried: string[]}>}
 */
async function resolveBinary(candidates, probeArgs) {
  const tried = []
  for (const c of candidates) {
    tried.push(c)
    const r = await run(c, probeArgs, undefined, 15000)
    if (r.code === 0) {
      const version = (r.stdout || r.stderr || '').split('\n')[0]?.trim() ?? ''
      return { path: c, version, tried }
    }
  }
  return { path: null, tried }
}

/**
 * 定位 ffmpeg / ffprobe。**按「能不能执行」判定，不按「文件在不在」判定。**
 * 结果会缓存，并发调用只解析一次。
 * @returns {Promise<{ffmpeg: string|null, ffprobe: string|null, ffmpegVersion: string, tried: string[]}>}
 */
export async function ensureBinaries() {
  if (resolved) return resolved
  if (!resolving) {
    resolving = (async () => {
      // exe 模式：ffmpeg 是内嵌在 exe 里的，先解出来、优先用它。
      // 普通模式返回 null，候选列表不变。
      const embedded = extractEmbeddedFfmpeg()
      const ffCandidates = embedded ? [embedded, ...FFMPEG_CANDIDATES] : FFMPEG_CANDIDATES
      const ff = await resolveBinary(ffCandidates, ['-hide_banner', '-version'])
      // ffprobe 是**可选**的：exe 里没嵌（它是另一个约 100 MB 的静态二进制）。
      // 找不到就走 `ffmpeg -i` 的 stderr 回退，见 probe()。
      const fp = await resolveBinary(ffprobeCandidates(), ['-v', 'error', '-version'])
      resolved = {
        ffmpeg: ff.path,
        ffprobe: fp.path,
        ffmpegVersion: ff.version ?? '',
        tried: ff.tried,
        embedded: !!embedded,
      }
      return resolved
    })()
  }
  return resolving
}

/** 同步拿 ffmpeg 路径（可能还没解析过，返回首选候选）。异步路径请用 ensureBinaries。 */
export function ffmpegPath() {
  return resolved?.ffmpeg ?? FFMPEG_CANDIDATES[0]
}
export function ffprobePath() {
  return resolved?.ffprobe ?? 'ffprobe'
}

/** ffmpeg 是否可用（会真跑一次 -version）。 */
export async function ffmpegAvailable() {
  const r = await ensureBinaries()
  if (!r.ffmpeg) {
    return {
      ok: false,
      error: '找不到可用的 ffmpeg。试过这些位置：\n  ' + r.tried.join('\n  ') +
        '\n安装方式：winget install Gyan.FFmpeg',
      tried: r.tried,
    }
  }
  return { ok: true, version: r.ffmpegVersion, path: r.ffmpeg, ffprobe: r.ffprobe }
}

/** 取 ffmpeg 可执行路径，拿不到就抛出带安装提示的错误。 */
async function requireFfmpeg() {
  const r = await ensureBinaries()
  if (!r.ffmpeg) {
    throw new Error('找不到可用的 ffmpeg。安装：winget install Gyan.FFmpeg\n试过：\n  ' + r.tried.join('\n  '))
  }
  return r.ffmpeg
}

/** 取 ffprobe 可执行路径。 */
async function requireFfprobe() {
  const r = await ensureBinaries()
  if (!r.ffprobe) throw new Error('找不到可用的 ffprobe（通常与 ffmpeg 同目录）')
  return r.ffprobe
}

/**
 * 从 `ffmpeg -i` 的 stderr 里解析出媒体信息。
 *
 * 为什么需要这个：ffprobe 和 ffmpeg 是**两个独立的静态二进制，各约 100 MB**。
 * 打成单文件 exe 时，为了体积只嵌 ffmpeg 一个 —— 那就得能不看 ffprobe 也拿到信息。
 * 有 ffprobe 时仍然优先用它（JSON 更准），这只是回退路径。
 *
 * ffmpeg 的 stderr 长这样：
 *   Input #0, mp3, from 'a.mp3':
 *     Metadata:
 *       title           : Forever
 *     Duration: 00:02:18.92, start: 0.000000, bitrate: 320 kb/s
 *     Stream #0:0: Audio: mp3, 48000 Hz, stereo, fltp, 320 kb/s
 *
 * @param {string} text stderr 全文
 * @returns {object} 与 probe() 形状一致
 */
export function parseFfmpegStderr(text) {
  const out = {
    codec: null, codecLong: null, sampleRate: null, channels: null,
    channelLayout: null, bitDepth: null, bitRate: null, duration: null,
    container: null, sizeBytes: null, tags: {}, hasAttachedPic: false,
  }
  if (typeof text !== 'string' || !text) return out

  const lines = text.split(/\r?\n/)

  // ── 容器 ──
  const inputMatch = text.match(/Input #0,\s*([^,]+),/)
  if (inputMatch) out.container = inputMatch[1].trim()

  // ── 时长 / 总码率 ──
  const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (durMatch) {
    out.duration = Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
  }
  const brMatch = text.match(/Duration:.*?bitrate:\s*(\d+)\s*kb\/s/)
  if (brMatch) out.bitRate = Number(brMatch[1]) * 1000

  // ── 音频流 ──
  // Stream #0:0: Audio: mp3, 48000 Hz, stereo, fltp, 320 kb/s
  const audioRe = /Stream #\d+:\d+(?:\([^)]*\))?:\s*Audio:\s*([^,\n]+)((?:,[^\n]*)?)/
  const am = text.match(audioRe)
  if (am) {
    out.codec = am[1].trim()
    const rest = am[2] || ''
    const sr = rest.match(/(\d+)\s*Hz/)
    if (sr) out.sampleRate = Number(sr[1])
    const ch = rest.match(/(\d+)\s*channels?|mono|stereo/)
    if (ch) {
      if (ch[0] === 'mono') { out.channels = 1; out.channelLayout = 'mono' }
      else if (ch[0] === 'stereo') { out.channels = 2; out.channelLayout = 'stereo' }
      else { out.channels = Number(ch[1]); out.channelLayout = ch[0].trim() }
    }
    const sfmt = rest.match(/,\s*(u8|s16|s32|s64|flt|fltp|dbl|dblp)\b/)
    if (sfmt) {
      const map = { u8: 8, s16: 16, s32: 32, s64: 64, flt: 32, fltp: 32, dbl: 64, dblp: 64 }
      out.bitDepth = map[sfmt[1]] ?? null
    }
    const abr = rest.match(/,\s*(\d+)\s*kb\/s/)
    if (abr && !out.bitRate) out.bitRate = Number(abr[1]) * 1000
  }

  // ── 封面（attached pic）──
  out.hasAttachedPic = /\(attached pic\)/i.test(text) || /Stream #\d+:\d+.*Video: (mjpeg|png)/i.test(text)

  // ── 标签：取 Input 那一段里的 Metadata ──
  // 只认第一个 Metadata 块（那是容器级标签），流级的不要
  const metaIdx = lines.findIndex((l) => /^\s*Metadata:\s*$/.test(l))
  if (metaIdx >= 0) {
    for (let i = metaIdx + 1; i < lines.length; i++) {
      const l = lines[i]
      if (/^\s*Stream #/.test(l) || /^\s*Duration:/.test(l)) break
      const m = l.match(/^\s{2,}([A-Za-z0-9_\-. ]+?)\s*:\s*(.*)$/)
      if (m) {
        const k = m[1].trim().toLowerCase().replace(/\s+/g, '_')
        const v = m[2].trim()
        if (v) out.tags[k] = v
      } else if (l.trim() && !/^\s*$/.test(l)) break
    }
  }

  return out
}

/**
 * 探测音频文件信息。
 * @param {string} file 文件路径
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} 归一化后的信息
 */
export async function probe(file, signal) {
  // ── 优先 ffprobe（JSON 输出更准）──
  // DSH_FFMPEG_NO_FFPROBE=1 可以强制走回退路径 —— 打包成单文件 exe 时
  // 只嵌了 ffmpeg、没有 ffprobe，这条路径必须能被测到，不能只靠"大概能跑"。
  const skipFfprobe = process.env.DSH_FFMPEG_NO_FFPROBE === '1'
  const probeBin = skipFfprobe ? null : (await ensureBinaries()).ffprobe
  if (probeBin) {
    const r = await run(probeBin, [
      '-v', 'error',
      '-show_format', '-show_streams',
      '-print_format', 'json',
      file,
    ], signal, 30000)
    if (r.code === 0) {
      let raw
      try { raw = JSON.parse(r.stdout) } catch { raw = null }
      if (raw) {
        const audio = (raw.streams ?? []).find((s) => s.codec_type === 'audio')
        const fmt = raw.format ?? {}
        return {
          codec: audio?.codec_name ?? null,
          codecLong: audio?.codec_long_name ?? null,
          sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
          channels: audio?.channels ?? null,
          channelLayout: audio?.channel_layout ?? null,
          bitDepth: audio?.bits_per_raw_sample ? Number(audio.bits_per_raw_sample) : (audio?.bits_per_sample || null),
          bitRate: fmt.bit_rate ? Number(fmt.bit_rate) : (audio?.bit_rate ? Number(audio.bit_rate) : null),
          duration: fmt.duration ? Number(fmt.duration) : (audio?.duration ? Number(audio.duration) : null),
          container: fmt.format_name ?? null,
          sizeBytes: fmt.size ? Number(fmt.size) : null,
          tags: fmt.tags ?? {},
          hasAttachedPic: (raw.streams ?? []).some((s) => s.disposition?.attached_pic === 1),
          probedWith: 'ffprobe',
        }
      }
    }
    // ffprobe 有但失败 —— 落到下面的 ffmpeg 回退
  }

  // ── 回退：ffmpeg -i（信息打在 stderr 上，退出码恒非 0，别当失败）──
  const ff = await requireFfmpeg()
  const r = await run(ff, ['-hide_banner', '-i', file], signal, 30000)
  const text = (r.stderr || '') + (r.stdout || '')
  if (!/Input #0/.test(text)) {
    throw new Error('探测失败（ffmpeg 也没能读出这个文件）：' + text.slice(0, 300))
  }
  const parsed = parseFfmpegStderr(text)
  parsed.probedWith = 'ffmpeg-stderr'
  return parsed
}

/** 输出格式 → ffmpeg 编码参数 */
const FORMATS = {
  mp3: { ext: 'mp3', args: (q) => ['-c:a', 'libmp3lame', '-b:a', q === 'best' ? '320k' : (q === 'small' ? '128k' : '192k')] },
  aac: { ext: 'm4a', args: (q) => ['-c:a', 'aac', '-b:a', q === 'best' ? '256k' : (q === 'small' ? '96k' : '160k')] },
  m4a: { ext: 'm4a', args: (q) => ['-c:a', 'aac', '-b:a', q === 'best' ? '256k' : (q === 'small' ? '96k' : '160k')] },
  flac: { ext: 'flac', args: () => ['-c:a', 'flac', '-compression_level', '8'] },
  // WAV 的位深由**编码器**决定（pcm_s16le / s24le / s32le），不是 -sample_fmt。
  // 也不能硬编码 -ar，否则会把源采样率改掉（48k 源会被强制降到 44.1k）。
  wav: { ext: 'wav', args: (q, o) => {
    const bd = Number(o.bitDepth)
    const codec = bd === 24 ? 'pcm_s24le' : bd === 32 ? 'pcm_s32le' : 'pcm_s16le'
    return ['-c:a', codec]
  } },
  ogg: { ext: 'ogg', args: (q) => ['-c:a', 'libvorbis', '-q:a', q === 'best' ? '8' : (q === 'small' ? '3' : '5')] },
  opus: { ext: 'opus', args: (q) => ['-c:a', 'libopus', '-b:a', q === 'best' ? '192k' : (q === 'small' ? '64k' : '128k')] },
}

/** 支持的输出格式列表 */
export function supportedFormats() {
  return Object.keys(FORMATS)
}

/**
 * 构造「音质增强」的 -af 滤镜链。
 *
 * 顺序有讲究：先做动态/均衡这类会改变峰值的处理，最后才做限幅，
 * 否则限幅后又被后续增益推爆。
 * @param {object} o 选项
 * @returns {{filters: string[], notes: string[]}}
 */
export function buildEnhanceChain(o = {}) {
  const f = []
  const notes = []

  // 1) 高通：去掉对耳机/音箱无用的超低频，能明显减少浑浊感
  if (o.highpass) { f.push('highpass=f=30'); notes.push('高通 30Hz（去超低频浑浊）') }

  // 2) 均衡：补偿常见耳机的两头翘
  if (o.eq === 'warm') { f.push('equalizer=f=200:t=q:w=1:g=2', 'equalizer=f=4000:t=q:w=1.5:g=-2'); notes.push('暖声 EQ（200Hz +2dB / 4kHz -2dB）') }
  else if (o.eq === 'bright') { f.push('equalizer=f=3000:t=q:w=1.5:g=3', 'equalizer=f=10000:t=h:w=0.7:g=2'); notes.push('明亮 EQ（3kHz +3dB / 10kHz +2dB）') }
  else if (o.eq === 'vocal') { f.push('equalizer=f=1000:t=q:w=1:g=2', 'equalizer=f=300:t=q:w=1:g=-2'); notes.push('人声突出 EQ（1kHz +2dB / 300Hz -2dB）') }
  else if (o.eq === 'bass') { f.push('equalizer=f=80:t=q:w=1:g=5'); notes.push('低频增强（80Hz +5dB）') }

  // 3) 动态处理
  if (o.dynamics === 'night') {
    // 夜间模式：压动态，小声也听得清
    f.push('acompressor=threshold=-18dB:ratio=4:attack=20:release=250:makeup=6')
    notes.push('夜间动态压缩（ratio 4:1）')
  } else if (o.dynamics === 'normalize') {
    f.push('dynaudnorm=f=250:g=15:p=0.9')
    notes.push('动态归一化（dynaudnorm）')
  }

  // 4) 响度归一化（EBU R128），放最后一步做响度目标
  if (o.loudness) {
    const lufs = typeof o.loudness === 'number' ? o.loudness : -16
    const tp = typeof o.truePeak === 'number' ? o.truePeak : -1.5
    f.push(`loudnorm=I=${lufs}:TP=${tp}:LRA=11:print_format=summary`)
    notes.push(`响度归一化 ${lufs} LUFS / 真峰值 ${tp} dBTP（EBU R128）`)
  }

  return { filters: f, notes }
}

/**
 * 转换 / 增强一个音频文件。
 *
 * @param {object} opts
 * @param {string} opts.input 输入文件
 * @param {string} opts.output 输出文件
 * @param {string} [opts.format] 输出格式，默认按输出扩展名推断
 * @param {'small'|'standard'|'best'} [opts.quality] 质量档
 * @param {number} [opts.sampleRate] 重采样目标
 * @param {number} [opts.channels] 声道数
 * @param {boolean} [opts.stripTags] 是否清掉原标签（重新打标签时用）
 * @param {object} [opts.enhance] 增强选项，见 buildEnhanceChain
 * @param {object} [opts.meta] 要写入的标签 { title, artist, album, albumArtist, track, date, genre, comment }
 * @param {string} [opts.cover] 封面图片路径
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:boolean, output:string, notes:string[], log?:string, error?:string, sizeBytes?:number}>}
 */
export async function convert(opts) {
  const {
    input, output, quality = 'standard', sampleRate, channels, bitDepth,
    stripTags = false, enhance = null, meta = null, cover = null, signal,
  } = opts
  if (!input || !output) throw new Error('convert 需要 input 和 output')

  const fmtKey = (opts.format ?? output.split('.').pop() ?? 'mp3').toLowerCase()
  const fmt = FORMATS[fmtKey]
  if (!fmt) throw new Error(`不支持的输出格式：${fmtKey}（可用：${supportedFormats().join(', ')}）`)

  const args = ['-hide_banner', '-nostdin', '-y', '-i', input]

  // 封面单独给一路输入
  const hasCover = typeof cover === 'string' && cover.length > 0 && existsSync(cover)
  if (hasCover) args.push('-i', cover)

  args.push('-map', '0:a')
  if (hasCover) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic')

  args.push(...fmt.args(quality, opts))

  // 重采样 / 声道
  if (sampleRate) args.push('-ar', String(sampleRate))
  if (channels) args.push('-ac', String(channels))
  // 位深：只对无损容器有意义（mp3/aac 是变换编码，压根没有"位深"概念）。
  //   WAV 靠编码器区分（见 FORMATS.wav），这里不碰，否则会和 -c:a 冲突。
  //   FLAC 靠 -sample_fmt + -bits_per_raw_sample。
  if (bitDepth && fmtKey === 'flac') {
    const bd = Number(bitDepth)
    const SAMPLE_FMT = { 16: 's16', 24: 's32', 32: 's32' }
    if (SAMPLE_FMT[bd]) {
      args.push('-sample_fmt', SAMPLE_FMT[bd])
      if (bd === 24) args.push('-bits_per_raw_sample', '24')
    }
  }

  // 增强滤镜链
  const notes = []
  if (enhance && Object.keys(enhance).length) {
    const { filters, notes: n } = buildEnhanceChain(enhance)
    if (filters.length) args.push('-af', filters.join(','))
    notes.push(...n)
  }

  // 标签
  if (stripTags) args.push('-map_metadata', '-1')
  if (meta && typeof meta === 'object') {
    const map = {
      title: 'title', artist: 'artist', album: 'album',
      albumArtist: 'album_artist', track: 'track', date: 'date',
      genre: 'genre', comment: 'comment', composer: 'composer',
    }
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || v === null || v === '') continue
      const tag = map[k]
      if (!tag) continue
      args.push('-metadata', `${tag}=${String(v)}`)
    }
  }
  // mp3 写 ID3v2.3 兼容性最好（老播放器也认）
  if (fmtKey === 'mp3') args.push('-id3v2_version', '3')

  args.push(output)

  // 确保输出目录存在
  try { mkdirSync(dirname(output), { recursive: true }) } catch { /* 已存在或无权限 */ }

  const r = await run(await requireFfmpeg(), args, signal)
  if (r.code !== 0) {
    return {
      ok: false, output, notes,
      error: (r.timedOut ? 'ffmpeg 超时；' : '') + (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n').slice(0, 800),
    }
  }
  let sizeBytes = null
  try { sizeBytes = existsSync(output) ? (await import('node:fs')).statSync(output).size : null } catch { /* 忽略 */ }

  return { ok: true, output, notes, sizeBytes }
}

/**
 * 只写标签（不重新编码音频），用 -c copy。
 * @param {object} opts { input, output, meta, cover, signal }
 * @returns {Promise<{ok:boolean, output:string, error?:string}>}
 */
export async function tagOnly(opts) {
  const { input, output, meta = {}, cover = null, signal } = opts
  const args = ['-hide_banner', '-nostdin', '-y', '-i', input]
  const hasCover = typeof cover === 'string' && cover.length > 0 && existsSync(cover)
  if (hasCover) args.push('-i', cover)
  args.push('-map', '0')
  if (hasCover) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic')
  args.push('-c:a', 'copy')
  if (hasCover) args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)')
  const map = { title: 'title', artist: 'artist', album: 'album', albumArtist: 'album_artist', track: 'track', date: 'date', genre: 'genre', comment: 'comment' }
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null || v === '') continue
    if (map[k]) args.push('-metadata', `${map[k]}=${String(v)}`)
  }
  args.push('-id3v2_version', '3', output)
  try { mkdirSync(dirname(output), { recursive: true }) } catch { /* 忽略 */ }
  const r = await run(await requireFfmpeg(), args, signal)
  if (r.code !== 0) return { ok: false, output, error: (r.stderr || r.stdout).slice(-600) }
  return { ok: true, output }
}

/** 临时目录助手：给解出来的中间文件找地方。 */
export function tempPath(name) {
  const dir = join(tmpdir(), 'dsh-audio-converter')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
  return join(dir, name)
}

export { FORMATS }
