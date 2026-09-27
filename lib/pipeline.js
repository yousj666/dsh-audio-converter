// 音频处理管线：识别格式 → 解密（如需要）→ 转换/增强 → 打标签
//
// 设计原则
//   1. **能解的做到最好，解不了的明确说清为什么** —— 不假装支持然后吐个坏文件。
//   2. 每个中间产物都落到临时目录，失败时能看出卡在哪一步。
//   3. 解密与转码解耦：只想解密就解密，想再转码再转码。
//
// @module dsh-audio-converter/pipeline
'use strict'

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { decryptNcm, isNcm, sniffAudioFormat } from './crypto/ncm.js'
import { decryptKwm } from './crypto/kwm.js'
import { decryptKgm, isKgm } from './crypto/kgm.js'
import { decryptQmc as decryptQmcAll, detectQmc as detectQmcAny } from './crypto/qmc2.js'
import { convert, probe, tagOnly, tempPath } from './ffmpeg.js'

/* ------------------------------------------------------------------ *
 * 格式识别
 * ------------------------------------------------------------------ */

/** 酷狗 KGM / VPR 的 magic */
const KGM_MAGIC = Buffer.from([0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b, 0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14])
const VPR_MAGIC = Buffer.from([0x05, 0x28, 0xbc, 0x96, 0xe9, 0xe4, 0x5a, 0x43, 0x91, 0xaa, 0xbd, 0xd0, 0x7a, 0xf5, 0x36, 0x31])

/** 各平台加密格式的后缀 */
const ENCRYPTED_EXTS = new Map([
  ['.ncm', 'ncm'],
  ['.kwm', 'kwm'],
  ['.kgm', 'kgm'],
  ['.kgma', 'kgm'],
  ['.vpr', 'kgm'],
  ['.qmc0', 'qmc'],
  ['.qmc2', 'qmc'],
  ['.qmc3', 'qmc'],
  ['.qmcflac', 'qmc'],
  ['.qmcogg', 'qmc'],
  ['.tkm', 'qmc'],
  ['.mflac', 'qmc2'],
  ['.mflac0', 'qmc2'],
  ['.mflac2', 'qmc2'],
  ['.mgg', 'qmc2'],
  ['.mgg0', 'qmc2'],
  ['.mgg1', 'qmc2-new'],
  ['.mgg2', 'qmc2-new'],
  ['.mmp4', 'qmc2-new'],
  ['.xm', 'xm'],
])

/**
 * 识别一个文件的真实类型。
 *
 * **先看 magic，再看后缀** —— 因为有些人只是把 flac 改成了 .ncm 后缀，
 * 而且加密文件的 magic 比后缀可靠得多。
 *
 * @param {Buffer} buf 文件内容（只需要开头若干字节准确）
 * @param {string} filename 原始文件名（用来看后缀）
 * @returns {{kind: string, note?: string, encrypted: boolean}}
 */
export function detectFormat(buf, filename = '') {
  const ext = extname(filename).toLowerCase()

  // 1) 加密格式的 magic
  if (isNcm(buf)) return { kind: 'ncm', encrypted: true }
  if (isKgm(buf)) {
    const isVpr = buf.subarray(0, 16).equals(VPR_MAGIC)
    return { kind: 'kgm', encrypted: true, note: isVpr ? 'VPR 变体' : undefined }
  }

  // 2) 普通音频的 magic（宁可先认出来，避免把改后缀的普通文件当加密文件处理）
  const plain = sniffAudioFormat(buf)
  if (plain) return { kind: 'plain', format: plain, encrypted: false }

  // 3) QMC 家族：没有统一 magic，靠尾包解析 + 后缀判世代
  //    （实现放在 qmc2.js，那里才知道四种尾包形态的区别）
  const qmcInfo = detectQmcAny(buf, filename)
  if (qmcInfo.isQmc) {
    // gen=v1 与 v2 都能尝试解密；hasEkey=false 时会在解密阶段给出可操作提示
    const kind = qmcInfo.gen === 'v1' ? 'qmc' : 'qmc2'
    return {
      kind,
      encrypted: true,
      note: qmcInfo.reason,
      qmcFooterKind: qmcInfo.footerKind,
      qmcHasEkey: qmcInfo.hasEkey,
    }
  }

  // 4) KWM 没有 magic，只能按后缀 + 长度判断（真正的判定在解密时的密钥恢复里）
  if (ext === '.kwm') return { kind: 'kwm', encrypted: true }

  // 5) 后缀声称加密但 magic 对不上 —— 说清楚
  const claimed = ENCRYPTED_EXTS.get(ext)
  if (claimed) {
    return {
      kind: claimed,
      encrypted: true,
      note: `后缀是 ${ext}，但文件头不像对应的加密格式（可能只是改了后缀，或格式变种）`,
    }
  }

  return { kind: 'unknown', encrypted: false }
}

/**
 * 这个类型能不能解。
 * @param {string} kind detectFormat 的结果
 * @returns {{ok: boolean, reason?: string}}
 */
export function decryptionSupport(kind) {
  switch (kind) {
    case 'ncm': return { ok: true }
    case 'kwm': return { ok: true }
    case 'plain': return { ok: true, reason: '本来就是普通音频，不需要解密' }
    case 'kgm':
      return { ok: true }
    case 'qmc':
      return { ok: true }
    case 'qmc2':
      return { ok: true }
    case 'qmc2-new':
      return {
        ok: false,
        reason: '这是 QQ 音乐的新版加密（STag/QTag 或 512 字节动态密钥）。' +
          'QQ 音乐用「动态密钥分发 + 设备指纹绑定」，密钥不下发到本地，' +
          '**离线无法解密** —— 这不是实现问题，是设计上就不给。' +
          '可行做法：用 QQ 音乐客户端重新下载为普通格式，或在客户端里导出。',
      }
    case 'xm':
      return { ok: false, reason: '虾米音乐已停止服务，XM 格式未实现' }
    default:
      return { ok: false, reason: '认不出这个格式' }
  }
}

/* ------------------------------------------------------------------ *
 * 解密
 * ------------------------------------------------------------------ */

/**
 * 解密一个加密音频文件。
 * @param {string} inputPath 输入文件路径
 * @param {object} [opts]
 * @param {string} [opts.workDir] 中间产物目录
 * @returns {Promise<{ok:boolean, audioPath?:string, format?:string, meta?:object, coverPath?:string, kind?:string, error?:string, notes:string[]}>}
 */
export async function decryptToFile(inputPath, opts = {}) {
  const buf = readFileSync(inputPath)
  const kindInfo = detectFormat(buf, inputPath)
  const support = decryptionSupport(kindInfo.kind)
  const notes = []

  if (!support.ok && kindInfo.kind !== 'plain') {
    return { ok: false, kind: kindInfo.kind, error: support.reason, notes }
  }

  const workDir = opts.workDir ?? dirname(tempPath('x'))
  try { mkdirSync(workDir, { recursive: true }) } catch { /* 已存在 */ }
  const stem = basename(inputPath, extname(inputPath))

  // ── 普通音频：原样返回 ──
  if (kindInfo.kind === 'plain') {
    return { ok: true, kind: 'plain', audioPath: inputPath, format: kindInfo.format, notes: ['本来就是普通音频，无需解密'] }
  }

  // ── NCM ──
  if (kindInfo.kind === 'ncm') {
    let out
    try {
      out = decryptNcm(buf)
    } catch (error) {
      return { ok: false, kind: 'ncm', error: 'NCM 解密失败：' + (error?.message ?? error), notes }
    }
    const fmt = out.format ?? sniffAudioFormat(out.audio) ?? 'mp3'
    const audioPath = join(workDir, `${stem}.${fmt}`)
    writeFileSync(audioPath, out.audio)
    notes.push(`NCM 解密成功，时长 ${out.meta?.duration ? (out.meta.duration / 1000).toFixed(1) + 's' : '未知'}，码率 ${out.meta?.bitrate ?? '未知'}`)

    let coverPath = null
    if (out.cover && out.cover.length > 100) {
      // 封面可能是 jpg 也可能是 png，按 magic 定后缀
      const isPng = out.cover.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      coverPath = join(workDir, `${stem}.cover.${isPng ? 'png' : 'jpg'}`)
      writeFileSync(coverPath, out.cover)
      notes.push(`封面已提取（${(out.cover.length / 1048576).toFixed(2)} MB）`)
    }

    // 把 NCM 元数据整理成通用标签
    const meta = {}
    if (out.meta) {
      if (out.meta.musicName) meta.title = out.meta.musicName
      if (Array.isArray(out.meta.artist) && out.meta.artist.length) {
        meta.artist = out.meta.artist.map((a) => (Array.isArray(a) ? a[0] : a)).filter(Boolean).join(' / ')
      }
      if (out.meta.album) meta.album = out.meta.album
      if (out.meta.albumArtist) meta.albumArtist = out.meta.albumArtist
    }
    return { ok: true, kind: 'ncm', audioPath, format: fmt, meta, coverPath, metaRaw: out.meta, notes }
  }

  // ── KWM ──
  if (kindInfo.kind === 'kwm') {
    let out
    try {
      out = decryptKwm(buf)
    } catch (error) {
      return { ok: false, kind: 'kwm', error: 'KWM 解密失败：' + (error?.message ?? error), notes }
    }
    const fmt = out.format ?? 'mp3'
    const audioPath = join(workDir, `${stem}.${fmt}`)
    writeFileSync(audioPath, out.audio)
    notes.push(`KWM 解密成功（密钥来源：${out.keySource}，前导静音 ${out.leadSilence} 字节）`)
    return { ok: true, kind: 'kwm', audioPath, format: fmt, notes }
  }

  // ── KGM / KGMA / VPR ──
  if (kindInfo.kind === 'kgm') {
    let out
    try {
      out = decryptKgm(buf)
    } catch (error) {
      return { ok: false, kind: 'kgm', error: 'KGM 解密失败：' + (error?.message ?? error), notes }
    }
    const fmt = out.format ?? 'mp3'
    const audioPath = join(workDir, `${stem}.${fmt}`)
    writeFileSync(audioPath, out.audio)
    notes.push(`KGM 解密成功（加密版本 ${out.cryptoVersion}，音频起始偏移 ${out.audioOffset}）`)
    return { ok: true, kind: 'kgm', audioPath, format: fmt, notes }
  }

  // ── QMC（v1 静态密钥 / v2 尾包 EKey，同一个入口自动分流）──
  if (kindInfo.kind === 'qmc' || kindInfo.kind === 'qmc2') {
    let out
    try {
      out = decryptQmcAll(buf, { filename: inputPath, ekey: opts.ekey })
    } catch (error) {
      return { ok: false, kind: kindInfo.kind, error: 'QMC 解密失败：' + (error?.message ?? error), notes }
    }
    const fmt = out.format ?? 'mp3'
    const audioPath = join(workDir, `${stem}.${fmt}`)
    writeFileSync(audioPath, out.audio)
    notes.push(out.generation === 'v1'
      ? 'QMC v1 解密成功（128 字节公开静态密钥）'
      : `QMC v2 解密成功（${out.footerKind} 尾包，密钥${out.embeddedEkey ? '内嵌' : '来自外部 EKey'}）`)
    return { ok: true, kind: kindInfo.kind, audioPath, format: fmt, notes }
  }

  return { ok: false, kind: kindInfo.kind, error: '这个格式暂时处理不了', notes }
}

/* ------------------------------------------------------------------ *
 * 完整流程：解密 → 转换 → 增强 → 打标签
 * ------------------------------------------------------------------ */

/**
 * 处理一个文件：需要解密就先解密，再按选项转码/增强/打标签。
 *
 * @param {object} opts
 * @param {string} opts.input 输入文件
 * @param {string} [opts.outDir] 输出目录，默认与输入同目录
 * @param {string} [opts.format] 目标格式，默认沿用源格式
 * @param {'small'|'standard'|'best'} [opts.quality]
 * @param {number} [opts.sampleRate]
 * @param {number} [opts.channels]
 * @param {object} [opts.enhance] 增强选项
 * @param {boolean} [opts.embedCover] 是否把封面嵌进输出（默认 true）
 * @param {boolean} [opts.writeTags] 是否写标签（默认 true）
 * @param {string} [opts.nameTemplate] 文件名模板（暂只支持默认）
 * @param {AbortSignal} [opts.signal]
 * @param {(stage:string, info:object)=>void} [opts.onProgress]
 * @returns {Promise<object>} 结果汇总
 */
export async function processFile(opts) {
  const { input, outDir, quality = 'standard', sampleRate, channels, bitDepth, enhance, signal } = opts
  const embedCover = opts.embedCover !== false
  const writeTags = opts.writeTags !== false
  const report = (stage, info) => { try { opts.onProgress?.(stage, info) } catch { /* 忽略 */ } }

  if (!existsSync(input)) return { ok: false, input, error: '文件不存在' }
  const sizeBytes = statSync(input).size
  const t0 = Date.now()

  // ── 1. 解密 ──
  report('detect', { input })
  // ekey 必须传下去 —— STag/MusicEx 尾包不含密钥，靠用户提供。
  // （第一版这里漏了，单测测解密器抓不到，只有走完整管线才暴露。）
  const dec = await decryptToFile(input, {
    workDir: join(dirname(tempPath('x')), 'work'),
    ekey: opts.ekey,
  })
  if (!dec.ok) return { ok: false, input, kind: dec.kind, error: dec.error, notes: dec.notes }

  const srcInfo = await probe(dec.audioPath, signal).catch(() => null)
  report('decrypted', { kind: dec.kind, format: dec.format, srcInfo })

  // ── 2. 目标格式 ──
  const targetFmt = (opts.format ?? dec.format ?? 'mp3').toLowerCase()
  const stemBase = basename(input, extname(input)).replace(/\.(ncm|kwm|kgm|kgma|vpr|qmc[0-9]?|qmcflac|qmcogg|tkm|mflac[0-9]?|mgg[0-9]?|xm)$/i, '')
  const outRoot = outDir ?? dirname(input)
  const outPath = join(outRoot, `${stemBase}.${targetFmt}`)

  // 源格式 = 目标格式 且没要求增强 → 只解密，不转码
  const sameFormat = (dec.format ?? '').toLowerCase() === targetFmt
  const wantsEnhance = !!(enhance && Object.keys(enhance).length)
  const needsCover = embedCover && !!dec.coverPath
  const needsTags = writeTags && !!dec.meta && Object.keys(dec.meta).length

  report('converting', { targetFmt, sameFormat, wantsEnhance, needsCover, needsTags })

  // ── 3. 什么都不用做：直接拷出来 ──
  // 注意：这条路径的返回结构必须和下面转码那条**完全一致**，
  // 否则调用方得按分支处理，很容易漏字段（第一版就漏了 srcInfo / meta）。
  if (sameFormat && !wantsEnhance && !needsCover && !needsTags) {
    const { copyFileSync } = await import('node:fs')
    try { mkdirSync(outRoot, { recursive: true }) } catch { /* 忽略 */ }
    copyFileSync(dec.audioPath, outPath)
    report('done', { outPath })
    return {
      ok: true,
      input,
      output: outPath,
      kind: dec.kind,
      srcFormat: dec.format,
      format: targetFmt,
      sizeBytes,
      outSizeBytes: statSync(outPath).size,
      elapsedMs: Date.now() - t0,
      srcInfo: srcInfo ? { codec: srcInfo.codec, sampleRate: srcInfo.sampleRate, bitRate: srcInfo.bitRate, duration: srcInfo.duration } : null,
      outInfo: srcInfo ? { codec: srcInfo.codec, sampleRate: srcInfo.sampleRate, bitRate: srcInfo.bitRate, duration: srcInfo.duration } : null,
      meta: dec.meta ?? null,
      notes: [...dec.notes, '格式相同且未要求处理，直接输出'],
    }
  }

  // ── 4. 转码 / 增强 / 打标签 ──
  //
  // 采样率：默认**沿用源采样率**，除非用户明确指定。
  // 为什么必须显式传：loudnorm / aresample 这类滤镜内部会重采样，
  // 不锁住 -ar 的话，一个 48kHz 的源会被输出成 96kHz —— 体积翻倍、
  // 听感毫无提升，用户还以为是"增强"带来的。
  const effectiveSampleRate = sampleRate ?? srcInfo?.sampleRate ?? undefined
  const r = await convert({
    input: dec.audioPath,
    output: outPath,
    format: targetFmt,
    quality,
    sampleRate: effectiveSampleRate,
    channels,
    bitDepth,
    stripTags: writeTags,
    enhance: wantsEnhance ? enhance : null,
    meta: needsTags ? dec.meta : null,
    cover: needsCover ? dec.coverPath : null,
    signal,
  })

  if (!r.ok) {
    return { ok: false, input, kind: dec.kind, error: r.error, notes: [...dec.notes, ...r.notes] }
  }
  report('done', { outPath })

  const outInfo = await probe(outPath, signal).catch(() => null)
  const notes = [...dec.notes, ...r.notes]
  if (needsCover) notes.push('封面已嵌入')
  if (needsTags) notes.push('标签已写入')

  return {
    ok: true,
    input,
    output: outPath,
    kind: dec.kind,
    srcFormat: dec.format,
    format: targetFmt,
    sizeBytes,
    outSizeBytes: r.sizeBytes,
    elapsedMs: Date.now() - t0,
    srcInfo: srcInfo ? { codec: srcInfo.codec, sampleRate: srcInfo.sampleRate, bitRate: srcInfo.bitRate, duration: srcInfo.duration } : null,
    outInfo: outInfo ? { codec: outInfo.codec, sampleRate: outInfo.sampleRate, bitRate: outInfo.bitRate, duration: outInfo.duration } : null,
    meta: dec.meta ?? null,
    notes,
  }
}

/**
 * 只处理音频（不带加密解密的普通文件），供只想转码/增强的场景。
 * @param {object} opts 同 processFile
 */
export async function processPlain(opts) {
  return processFile({ ...opts, embedCover: opts.embedCover, writeTags: opts.writeTags })
}

export { tagOnly, probe, convert }
