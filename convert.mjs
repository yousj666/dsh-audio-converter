#!/usr/bin/env node
/**
 * 音频转换器的命令行入口 —— 不依赖 DSH，双击 / 拖拽就能用。
 *
 * 用法：
 *   node convert.mjs <文件或文件夹...> [选项]
 *
 *   --format <fmt>    目标格式：mp3 / flac / m4a / aac / wav / ogg / opus
 *                     不填 = 沿用源格式（只解密，不转码）
 *   --enhance <预设>  none / loudness / night / warm / bright / vocal / bass / full
 *   --quality <档>    small / standard / best（默认 standard）
 *   --sample-rate <n> 重采样，如 44100 / 48000
 *   --channels <n>    声道数 1 / 2
 *   --bit-depth <n>   位深 16 / 24 / 32（只对 flac/wav 有意义）
 *   --out <目录>      输出目录，默认桌面\音频转换输出
 *   --ekey <字符串>   QQ音乐 v2 的 STag/MusicEx 尾包需要外部 EKey 时用
 *   --list            只看看有什么格式支持，不转换
 *   --dry             只识别格式，不真转（用来确认文件能不能解）
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { processFile, detectFormat, decryptionSupport } from './lib/pipeline.js'
import { ffmpegAvailable, supportedFormats } from './lib/ffmpeg.js'
import { capabilityMatrix } from './lib/index.js'
import { readFileSync } from 'node:fs'

const ACCEPT = new Set([
  '.ncm', '.kwm', '.kgm', '.kgma', '.vpr',
  '.qmc0', '.qmc2', '.qmc3', '.qmcflac', '.qmcogg', '.tkm',
  '.mflac', '.mflac0', '.mflac2', '.mgg', '.mgg0', '.mgg1', '.mgg2', '.mmp4', '.xm',
  '.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma', '.aiff', '.ape',
])

const ENHANCE_PRESETS = {
  loudness: { loudness: -16, truePeak: -1.5 },
  night: { dynamics: 'night', loudness: -18, truePeak: -1.5 },
  warm: { highpass: true, eq: 'warm' },
  bright: { highpass: true, eq: 'bright' },
  vocal: { highpass: true, eq: 'vocal' },
  bass: { highpass: true, eq: 'bass' },
  full: { highpass: true, eq: 'warm', dynamics: 'night', loudness: -16, truePeak: -1.5 },
}

/* ---------------- 参数解析 ---------------- */
function parseArgs(argv) {
  const opts = { inputs: [], quality: 'standard' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--format': case '-f': opts.format = String(next() || '').toLowerCase(); break
      case '--enhance': case '-e': opts.enhance = next(); break
      case '--quality': case '-q': opts.quality = next(); break
      case '--sample-rate': opts.sampleRate = Number(next()); break
      case '--channels': opts.channels = Number(next()); break
      case '--bit-depth': opts.bitDepth = Number(next()); break
      case '--out': case '-o': opts.outDir = next(); break
      case '--ekey': opts.ekey = next(); break
      case '--list': opts.list = true; break
      case '--dry': opts.dry = true; break
      case '--help': case '-h': opts.help = true; break
      default:
        if (a.startsWith('-')) { console.error('未知选项：' + a); process.exit(2) }
        opts.inputs.push(a)
    }
  }
  return opts
}

const USAGE = `
音频转换器

  node convert.mjs <文件或文件夹...> [选项]

选项
  -f, --format <fmt>     mp3 / flac / m4a / aac / wav / ogg / opus
                         不填 = 沿用源格式（只解密，不转码）
  -e, --enhance <预设>   none / loudness / night / warm / bright / vocal / bass / full
  -q, --quality <档>     small / standard / best（默认 standard）
      --sample-rate <n>  重采样，如 44100 / 48000
      --channels <n>     声道数 1 / 2
      --bit-depth <n>    位深 16 / 24 / 32（只对 flac/wav 有意义）
  -o, --out <目录>       输出目录，默认 桌面\\音频转换输出
      --ekey <字符串>    QQ音乐 v2 的 STag / MusicEx 尾包需要外部 EKey
      --list             看支持哪些格式
      --dry              只识别格式、不真转（用来确认文件能不能解）
`

/* ---------------- 展开输入 ---------------- */
function expand(inputs) {
  const files = []
  for (const p of inputs) {
    const full = resolve(p)
    if (!existsSync(full)) { files.push({ path: full, missing: true }); continue }
    const st = statSync(full)
    if (st.isDirectory()) {
      for (const f of readdirSync(full)) {
        const fp = join(full, f)
        try {
          if (statSync(fp).isFile() && ACCEPT.has(extname(f).toLowerCase())) files.push({ path: fp })
        } catch { /* 跳过读不了的 */ }
      }
    } else {
      files.push({ path: full })
    }
  }
  return files
}

const mb = (n) => (n / 1048576).toFixed(2) + ' MB'

/* ---------------- 主流程 ---------------- */
async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.help) { console.log(USAGE); return 0 }

  if (opts.list) {
    console.log('\nffmpeg：' + ((await ffmpegAvailable()).ok ? '就绪' : '不可用'))
    console.log('\n常规格式互转：' + supportedFormats().join(' / '))
    console.log('\n加密格式支持：')
    for (const c of capabilityMatrix()) {
      const m = c.status === 'supported' ? '✅' : c.status === 'todo' ? '🔨' : '❌'
      console.log(`  ${m} ${c.platform}  ${c.ext}`)
      console.log(`      ${c.note}`)
    }
    console.log('\n音质增强：响度归一化(EBU R128) / 重采样 / 声道 / 位深 / EQ(暖声·明亮·人声·低频) / 动态压缩 / 高通')
    console.log('注：增强改变的是听感，无法恢复有损编码已丢失的信息。\n')
    return 0
  }

  if (!opts.inputs.length) { console.log(USAGE); return 1 }

  // ffmpeg 检查
  const ff = await ffmpegAvailable()
  if (!ff.ok) {
    console.error('❌ ffmpeg 不可用，无法转换。')
    console.error('   安装：winget install Gyan.FFmpeg')
    console.error('   ' + (ff.error || '').split('\n')[0])
    return 1
  }

  const files = expand(opts.inputs)
  const missing = files.filter((f) => f.missing)
  const real = files.filter((f) => !f.missing)

  console.log('')
  console.log('════════════════════════════════════════════')
  console.log('  音频转换器')
  console.log('════════════════════════════════════════════')
  console.log('  找到 ' + real.length + ' 个文件' + (missing.length ? '，' + missing.length + ' 个路径不存在' : ''))
  console.log('  输出到 ' + (opts.outDir || join(homedir(), 'Desktop', '音频转换输出')))
  console.log('  目标格式 ' + (opts.format || '沿用源格式（只解密）') +
    '   质量 ' + opts.quality +
    (opts.enhance && opts.enhance !== 'none' ? '   增强 ' + opts.enhance : ''))
  console.log('')

  for (const m of missing) console.log('  ⚠️ 找不到：' + m.path)
  if (!real.length) return 1

  // --dry：只识别
  if (opts.dry) {
    for (const f of real) {
      const det = detectFormat(readFileSync(f.path), f.path)
      const sup = decryptionSupport(det.kind)
      const mark = det.kind === 'plain' ? '普通音频' : sup.ok ? '可解密' : '不可解密'
      console.log(`  ${basename(f.path)}`)
      console.log(`    类型 ${det.kind}${det.format ? ' / ' + det.format : ''}  →  ${mark}`)
      if (det.note) console.log('    ' + det.note)
      if (!sup.ok) console.log('    ⚠️ ' + sup.reason.replace(/\n/g, '\n    '))
    }
    return 0
  }

  const outDir = opts.outDir || join(homedir(), 'Desktop', '音频转换输出')
  mkdirSync(outDir, { recursive: true })

  const enhance = opts.enhance && opts.enhance !== 'none' ? ENHANCE_PRESETS[opts.enhance] : null
  if (opts.enhance && opts.enhance !== 'none' && !enhance) {
    console.error('未知的增强预设：' + opts.enhance)
    return 2
  }

  let ok = 0
  let bad = 0
  for (let i = 0; i < real.length; i++) {
    const f = real[i]
    const tag = `[${i + 1}/${real.length}]`
    process.stdout.write(`  ${tag} ${basename(f.path)} … `)
    const t0 = Date.now()
    const r = await processFile({
      input: f.path,
      outDir,
      format: opts.format,
      quality: opts.quality,
      sampleRate: opts.sampleRate,
      channels: opts.channels,
      bitDepth: opts.bitDepth,
      enhance,
      embedCover: true,
      writeTags: true,
      ekey: opts.ekey,
    })
    if (r.ok) {
      ok++
      console.log('✅')
      console.log(`        ${mb(r.sizeBytes)} → ${mb(r.outSizeBytes)}   ${r.srcFormat} → ${r.format}` +
        `   ${(Date.now() - t0) / 1000 < 1 ? Date.now() - t0 + 'ms' : ((Date.now() - t0) / 1000).toFixed(1) + 's'}`)
      for (const n of r.notes || []) console.log('        · ' + n)
    } else {
      bad++
      console.log('❌')
      console.log('        ' + String(r.error || '未知错误').replace(/\n/g, '\n        '))
    }
  }

  console.log('')
  console.log('════════════════════════════════════════════')
  console.log(`  完成 ${ok} 个${bad ? '，失败 ' + bad + ' 个' : ''}`)
  console.log('  输出目录：' + outDir)
  console.log('════════════════════════════════════════════')
  console.log('')
  return bad === 0 ? 0 : 1
}

main()
  .then((code) => { process.exitCode = code })
  .catch((e) => {
    console.error('')
    console.error('❌ 出错了：' + (e?.stack || e))
    process.exitCode = 1
  })
