// dsh-audio-converter — host 半边
//
// 两件事：
//   1. 给模型注册工具，让「帮我转一下这些歌」这类要求能直接执行
//   2. 注册 HTTP 路由，给浏览器半边（拖拽页签）用
//
// 长任务用 job 模型：POST 立刻返回 job id，界面轮询状态。
// 转一首 FLAC 要几秒、量产几十首要几分钟，同步 HTTP 撑不住。
//
// 零运行时依赖：只用 node: 内建模块 + 同包的 lib/。
//
// @module dsh-audio-converter
'use strict'

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { detectFormat, decryptionSupport, processFile } from './pipeline.js'
import { ffmpegAvailable, supportedFormats, probe } from './ffmpeg.js'
import { readFileSync } from 'node:fs'

const name = 'dsh-audio-converter'
// 只硬依赖 tools；webServer / agents 等一律 ctx.get() 软取。
// （硬 inject 只要一项解析不出来，apply() 就永远不执行，而且几乎无法排查。）
const inject = ['tools']

/* ------------------------------------------------------------------ *
 * 公共信息
 * ------------------------------------------------------------------ */

/** 上传落盘目录 */
function incomingDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'audio-converter', 'incoming')
}

/** 默认输出目录 */
function defaultOutDir() {
  return join(homedir(), 'Desktop', '音频转换输出')
}

/** 能被拖进来的扩展名（含加密格式） */
const ACCEPT_EXTS = [
  '.ncm', '.kwm', '.kgm', '.kgma', '.vpr',
  '.qmc0', '.qmc2', '.qmc3', '.qmcflac', '.qmcogg', '.tkm',
  '.mflac', '.mflac0', '.mflac2', '.mgg', '.mgg0', '.mgg1', '.mgg2', '.mmp4', '.xm',
  '.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma', '.aiff', '.ape',
]

/** 加密格式的支持矩阵（给界面和模型看的事实，不是宣传） */
function capabilityMatrix() {
  const rows = [
    { platform: '网易云音乐', ext: '.ncm', status: 'supported', note: '已验证：与已知正确结果逐字节一致' },
    { platform: '酷我音乐', ext: '.kwm', status: 'supported', note: '已验证：密钥恢复 + 容器嗅探' },
    { platform: '酷狗音乐', ext: '.kgm/.kgma/.vpr', status: 'supported', note: 'v1~v4 已实现：272 字节 MEND 表 + 17/16/272 三重异或；v5(KGG) 需客户端密钥库，不支持' },
    { platform: 'QQ音乐 v1（老格式）', ext: '.tkm/.bkc*', status: 'supported', note: '128 字节公开静态密钥，已与独立参考实现跨语言对拍' },
    { platform: 'QQ音乐 v2（mflac/mgg）', ext: '.mflac/.mgg/.qmcflac', status: 'supported', note: '尾包内嵌 EKey 的（QTag / PcV1Legacy）直接解，已跨语言对拍；STag / MusicEx 尾包不含密钥，需外部 EKey' },
    { platform: 'QQ音乐 v3（新版）', ext: '.mgg1/.mgg2/.mmp4', status: 'impossible', note: '动态密钥分发 + 设备指纹绑定，密钥不下发到本地，离线无法解密' },
    { platform: '虾米音乐', ext: '.xm', status: 'impossible', note: '虾米已停止服务' },
  ]
  return rows
}

/* ------------------------------------------------------------------ *
 * job 队列
 * ------------------------------------------------------------------ */

/** @type {Map<string, object>} jobId -> job */
const jobs = new Map()
const MAX_JOBS = 200

function createJob(input, options) {
  const job = {
    id: randomUUID(),
    input,
    options,
    status: 'queued',
    stage: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    progress: null,
    result: null,
    error: null,
    notes: [],
  }
  jobs.set(job.id, job)
  // 控制内存：超了就丢最旧的已完成任务
  if (jobs.size > MAX_JOBS) {
    const done = [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'failed')
      .sort((a, b) => a.createdAt - b.createdAt)
    while (jobs.size > MAX_JOBS && done.length) jobs.delete(done.shift().id)
  }
  return job
}

/** 顺序跑一个 job 队列，避免一次转 50 首把机器打满 */
let queueRunning = false
const queue = []

async function pumpQueue() {
  if (queueRunning) return
  queueRunning = true
  try {
    while (queue.length) {
      const job = queue.shift()
      job.status = 'running'
      job.startedAt = Date.now()
      job.stage = 'detect'
      try {
        const r = await processFile({
          ...job.options,
          input: job.input,
          onProgress: (stage, info) => { job.stage = stage; job.progress = info },
        })
        job.finishedAt = Date.now()
        if (r.ok) {
          job.status = 'done'
          job.result = r
          job.notes = r.notes ?? []
        } else {
          job.status = 'failed'
          job.error = r.error
          job.notes = r.notes ?? []
        }
      } catch (error) {
        job.finishedAt = Date.now()
        job.status = 'failed'
        job.error = String(error?.message ?? error)
      }
    }
  } finally {
    queueRunning = false
  }
}

function enqueue(job) {
  queue.push(job)
  pumpQueue().catch(() => {})
  return job
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 统一的 output 声明（纯文本渲染，信息量大但不塞 JSON） */
function outputOf(render) {
  return {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        message: { type: 'string' },
        results: { type: 'array', items: { type: 'object', additionalProperties: true } },
        formats: { type: 'array', items: { type: 'string' } },
        capabilities: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{ type: 'text', text: value?.message ?? JSON.stringify(value, null, 2) }],
  }
}

/** 把一批结果渲染成人看的文字 */
function renderResults(results) {
  const lines = []
  let ok = 0
  let bad = 0
  for (const r of results) {
    if (r.ok) {
      ok++
      lines.push(`✅ ${basename(r.input)}  →  ${basename(r.output)}`)
      lines.push(`   ${(r.sizeBytes / 1048576).toFixed(2)} MB → ${(r.outSizeBytes / 1048576).toFixed(2)} MB` +
        `  ${r.srcFormat} → ${r.format}  用时 ${r.elapsedMs}ms`)
      if (r.notes?.length) for (const n of r.notes) lines.push('   · ' + n)
    } else {
      bad++
      lines.push(`❌ ${basename(r.input)}`)
      lines.push('   ' + (r.error ?? '未知错误'))
      if (r.notes?.length) for (const n of r.notes) lines.push('   · ' + n)
    }
    lines.push('')
  }
  lines.unshift(`完成 ${ok} 个${bad ? `，失败 ${bad} 个` : ''}`, '')
  return lines.join('\n')
}

/** 展开输入为文件列表（支持目录） */
function expandInputs(inputs) {
  const out = []
  for (const p of inputs) {
    if (!existsSync(p)) { out.push({ path: p, missing: true }); continue }
    const st = statSync(p)
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) {
        const full = join(p, f)
        try { if (statSync(full).isFile() && ACCEPT_EXTS.includes(extname(f).toLowerCase())) out.push({ path: full }) } catch { /* 跳过 */ }
      }
    } else {
      out.push({ path: p })
    }
  }
  return out
}

/** 定义工具 */
function makeTools(ctx) {
  const base = { output: outputOf(), isConcurrencySafe: () => false }

  return [
    {
      ...base,
      name: 'audio_convert',
      description:
        '转换音频文件，并自动解密各平台的加密格式。支持目录（会批量处理目录里的音频）。' +
        '加密格式：网易云 .ncm、酷我 .kwm 已支持；酷狗 .kgm、QQ音乐 .qmc/.mflac/.mgg 暂不支持（会明确说明原因）。' +
        '常规格式可在 mp3 / flac / m4a / aac / wav / ogg / opus 之间互转。' +
        '可选音质增强：响度归一化、EQ、动态压缩、重采样、位深。' +
        '注意：增强会改变听感，但无法恢复有损编码已丢失的信息。',
      parameters: {
        type: 'object',
        properties: {
          inputs: {
            type: 'array',
            items: { type: 'string' },
            description: '输入文件或目录的绝对路径列表',
          },
          output_dir: { type: 'string', description: `输出目录，默认 ${defaultOutDir()}` },
          format: {
            type: 'string',
            description: `目标格式，可选：${supportedFormats().join(' / ')}。不填则沿用源格式（即只解密不转码）`,
          },
          quality: {
            type: 'string',
            enum: ['small', 'standard', 'best'],
            description: '质量档，默认 standard。small=体积优先，best=质量优先',
          },
          sample_rate: { type: 'number', description: '重采样目标（如 44100 / 48000）。不填保持原样' },
          bit_depth: {
            type: 'number',
            enum: [16, 24, 32],
            description: '位深，只对 flac/wav 这类无损容器有意义（mp3/aac 是变换编码，没有位深概念）。不填保持原样',
          },
          channels: { type: 'number', description: '声道数（1 单声道 / 2 立体声）。不填保持原样' },
          enhance: {
            type: 'string',
            enum: ['none', 'loudness', 'night', 'warm', 'bright', 'vocal', 'bass', 'full'],
            description: '音质增强预设。none=不处理（默认）；loudness=响度归一化；night=夜间降动态；warm/bright/vocal/bass=各类 EQ；full=高通+暖声EQ+动态+响度全套',
          },
          embed_cover: { type: 'boolean', description: '是否把封面嵌进输出，默认 true' },
          write_tags: { type: 'boolean', description: '是否写入标签，默认 true' },
          ekey: {
            type: 'string',
            description: 'QQ 音乐 EKey（base64）。只有当 .mflac/.mgg 的尾包是 STag / MusicEx 时才需要 —— ' +
              '那两种尾包里不含密钥，得从客户端数据库里取出来手动提供。其他格式忽略这个参数',
          },
        },
        required: ['inputs'],
      },
      async execute(args = {}) {
        const inputs = Array.isArray(args.inputs) ? args.inputs : [args.inputs].filter(Boolean)
        if (!inputs.length) return { ok: false, message: 'inputs 不能为空' }

        const files = expandInputs(inputs)
        const missing = files.filter((f) => f.missing)
        const real = files.filter((f) => !f.missing)
        if (!real.length) {
          return { ok: false, message: '没有找到可处理的文件。\n' + missing.map((m) => '  找不到：' + m.path).join('\n') }
        }

        const outDir = args.output_dir ?? defaultOutDir()
        const enhance = enhancePreset(args.enhance)
        const results = []
        for (const f of real) {
          const r = await processFile({
            input: f.path,
            outDir,
            format: args.format,
            quality: args.quality ?? 'standard',
            sampleRate: args.sample_rate,
            channels: args.channels,
            bitDepth: args.bit_depth,
            enhance,
            embedCover: args.embed_cover !== false,
            writeTags: args.write_tags !== false,
            ekey: args.ekey,
          })
          results.push(r)
        }

        const okCount = results.filter((r) => r.ok).length
        return {
          ok: okCount > 0,
          results,
          message: renderResults(results) +
            (missing.length ? `\n另外 ${missing.length} 个路径不存在：\n` + missing.map((m) => '  ' + m.path).join('\n') : ''),
        }
      },
    },

    {
      ...base,
      name: 'audio_inspect',
      description:
        '查看音频文件的信息：真实格式（看 magic 不看后缀）、是否是加密格式、能不能解、' +
        '以及解码后的编码/采样率/码率/时长/标签。用来在处理前先确认文件到底是什么。',
      parameters: {
        type: 'object',
        properties: {
          inputs: { type: 'array', items: { type: 'string' }, description: '文件路径列表' },
        },
        required: ['inputs'],
      },
      async execute(args = {}) {
        const inputs = Array.isArray(args.inputs) ? args.inputs : [args.inputs].filter(Boolean)
        const files = expandInputs(inputs).filter((f) => !f.missing)
        if (!files.length) return { ok: false, message: '没有找到文件' }

        const results = []
        const lines = []
        for (const f of files.slice(0, 50)) {
          const buf = readFileSync(f.path)
          const det = detectFormat(buf, f.path)
          const sup = decryptionSupport(det.kind)
          const item = {
            path: f.path,
            sizeBytes: buf.length,
            kind: det.kind,
            encrypted: det.encrypted,
            format: det.format ?? null,
            decryptable: sup.ok,
            note: det.note ?? sup.reason ?? null,
          }
          // 普通音频直接探测
          if (!det.encrypted) {
            try { item.info = await probe(f.path) } catch { /* 忽略 */ }
          }
          results.push(item)

          lines.push(`${basename(f.path)}`)
          lines.push(`  ${(buf.length / 1048576).toFixed(2)} MB  类型=${det.kind}` +
            (det.format ? ` 格式=${det.format}` : '') + (det.encrypted ? '（加密）' : ''))
          if (det.note) lines.push('  ' + det.note)
          if (sup.ok && sup.reason) lines.push('  ' + sup.reason)
          if (!sup.ok) lines.push('  ⚠️ 无法解密：' + sup.reason)
          if (item.info) {
            lines.push(`  ${item.info.codec} · ${item.info.sampleRate}Hz · ${item.info.channels}ch · ` +
              `${Math.round((item.info.bitRate ?? 0) / 1000)}kbps · ${item.info.duration?.toFixed(1)}s`)
            if (item.info.tags?.title) lines.push(`  标签：${item.info.tags.title} — ${item.info.tags.artist ?? '?'}`)
          }
          lines.push('')
        }
        return { ok: true, results, message: lines.join('\n') }
      },
    },

    {
      ...base,
      name: 'audio_capabilities',
      description:
        '查这个转换器到底支持什么：各平台加密格式的支持状态（已支持 / 待实现 / 离线不可能），' +
        '常规格式转换的可用目标格式，以及 ffmpeg 是否就绪。处理前不确定能不能转时先问它。',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        const ff = await ffmpegAvailable()
        const caps = capabilityMatrix()
        const lines = []
        lines.push('ffmpeg：' + (ff.ok ? ff.version : '❌ 不可用 — ' + ff.error))
        lines.push('')
        lines.push('加密格式支持：')
        for (const c of caps) {
          const mark = c.status === 'supported' ? '✅' : c.status === 'todo' ? '🔨' : '❌'
          lines.push(`  ${mark} ${c.platform}  ${c.ext}`)
          lines.push(`      ${c.note}`)
        }
        lines.push('')
        lines.push('常规格式互转：' + supportedFormats().join(' / '))
        lines.push('')
        lines.push('音质增强：响度归一化（EBU R128）/ 重采样 / 声道 / EQ（暖声·明亮·人声·低频）/ 动态压缩 / 高通')
        lines.push('注：增强会改变听感，但无法恢复有损编码已丢失的信息。')
        return {
          ok: true,
          formats: supportedFormats(),
          capabilities: caps,
          message: lines.join('\n'),
        }
      },
    },
  ]
}

/** 增强预设 → 具体选项 */
function enhancePreset(preset) {
  switch (preset) {
    case 'loudness': return { loudness: -16, truePeak: -1.5 }
    case 'night': return { dynamics: 'night', loudness: -18, truePeak: -1.5 }
    case 'warm': return { highpass: true, eq: 'warm' }
    case 'bright': return { highpass: true, eq: 'bright' }
    case 'vocal': return { highpass: true, eq: 'vocal' }
    case 'bass': return { highpass: true, eq: 'bass' }
    case 'full': return { highpass: true, eq: 'warm', dynamics: 'night', loudness: -16, truePeak: -1.5 }
    default: return null
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 路由（给浏览器半边）
 * ------------------------------------------------------------------ */

/** 只答同源回环请求 */
function isTrustedRequest(req) {
  const host = req?.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostname
  try { hostname = new URL(`http://${host}`).hostname } catch { return false }
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  if (!loopback) return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  return true
}

function registerHttpRoutes(ctx) {
  ctx.inject(['webServer'], (scope) => {
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const readJson = (req) => new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => { raw += c; if (raw.length > 2 * 1024 * 1024) raw = raw.slice(0, 2 * 1024 * 1024) })
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) } })
      req.on('error', () => resolve({}))
    })
    /** 收原始字节（拖拽上传用） */
    const readBytes = (req, limit = 512 * 1024 * 1024) => new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      req.on('data', (c) => {
        total += c.length
        if (total > limit) { reject(new Error('文件过大（上限 512MB）')); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

    // 状态与能力
    scope.webServer.register({
      name: 'dsh-audio-status', kind: 'exact', path: '/dsh-audio/status',
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) return send(res, 403, { error: 'forbidden' })
        const ff = await ffmpegAvailable()
        return send(res, 200, {
          ok: true,
          ffmpeg: { ok: ff.ok, version: ff.version ?? null, path: ff.path ?? null, error: ff.error ?? null },
          formats: supportedFormats(),
          capabilities: capabilityMatrix(),
          acceptExts: ACCEPT_EXTS,
          defaultOutDir: defaultOutDir(),
        })
      },
    })

    // 拖拽上传：原始字节 + 文件名在 query 里
    scope.webServer.register({
      name: 'dsh-audio-upload', kind: 'exact', path: '/dsh-audio/upload',
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) return send(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        try {
          const url = new URL(req.url, 'http://localhost')
          const rawName = url.searchParams.get('name') ?? 'upload.bin'
          // 只取文件名，挡掉 ../ 这种路径穿越
          const safeName = basename(rawName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'upload.bin'
          const dir = incomingDir()
          mkdirSync(dir, { recursive: true })
          const target = join(dir, `${Date.now()}-${safeName}`)
          const bytes = await readBytes(req)
          if (!bytes.length) return send(res, 400, { ok: false, error: '没有收到数据' })
          writeFileSync(target, bytes)
          return send(res, 200, { ok: true, path: target, sizeBytes: bytes.length, name: safeName })
        } catch (error) {
          return send(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })

    // 提交处理任务
    scope.webServer.register({
      name: 'dsh-audio-submit', kind: 'exact', path: '/dsh-audio/submit',
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) return send(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        const body = await readJson(req)
        const inputs = Array.isArray(body.inputs) ? body.inputs : [body.inputs].filter(Boolean)
        if (!inputs.length) return send(res, 400, { ok: false, error: '缺少 inputs' })

        const files = expandInputs(inputs).filter((f) => !f.missing)
        if (!files.length) return send(res, 400, { ok: false, error: '没有找到可处理的文件' })

        const outDir = body.outDir || defaultOutDir()
        const enhance = enhancePreset(body.enhance)
        const ids = []
        for (const f of files) {
          const job = createJob(f.path, {
            outDir,
            format: body.format || undefined,
            quality: body.quality ?? 'standard',
            sampleRate: body.sampleRate,
            channels: body.channels,
            bitDepth: body.bitDepth,
            enhance,
            embedCover: body.embedCover !== false,
            writeTags: body.writeTags !== false,
            ekey: body.ekey || undefined,
          })
          enqueue(job)
          ids.push(job.id)
        }
        return send(res, 200, { ok: true, jobIds: ids, total: ids.length, outDir })
      },
    })

    // 查任务
    scope.webServer.register({
      name: 'dsh-audio-jobs', kind: 'exact', path: '/dsh-audio/jobs',
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) return send(res, 403, { error: 'forbidden' })
        const url = new URL(req.url, 'http://localhost')
        const id = url.searchParams.get('id')
        if (id) {
          const job = jobs.get(id)
          if (!job) return send(res, 404, { ok: false, error: '没有这个任务' })
          return send(res, 200, { ok: true, job: publicJob(job) })
        }
        const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
        const running = list.filter((j) => j.status === 'running' || j.status === 'queued').length
        return send(res, 200, { ok: true, jobs: list.map(publicJob), running, queued: queue.length })
      },
    })

    // 清任务与上传缓存
    scope.webServer.register({
      name: 'dsh-audio-clear', kind: 'exact', path: '/dsh-audio/clear',
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) return send(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        const body = await readJson(req)
        if (body.jobs === 'all') {
          for (const j of jobs.values()) if (j.status === 'done' || j.status === 'failed') jobs.delete(j.id)
        }
        if (body.incoming === 'all') {
          try { rmSync(incomingDir(), { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
        return send(res, 200, { ok: true })
      },
    })
  })
}

/** 对外暴露的 job 视图（不泄露内部字段） */
function publicJob(job) {
  return {
    id: job.id,
    input: job.input,
    inputName: basename(job.input),
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null,
    output: job.result?.output ?? null,
    outputName: job.result?.output ? basename(job.result.output) : null,
    srcFormat: job.result?.srcFormat ?? null,
    format: job.result?.format ?? null,
    sizeBytes: job.result?.sizeBytes ?? null,
    outSizeBytes: job.result?.outSizeBytes ?? null,
    notes: job.notes,
    error: job.error,
  }
}

/* ------------------------------------------------------------------ *
 * 挂载
 * ------------------------------------------------------------------ */

function apply(ctx) {
  trace(`apply: 挂载中 DSH_HOME=${process.env.DSH_HOME ?? '(未设置)'}`)

  // 工具
  let registered = 0
  for (const tool of makeTools(ctx)) {
    try { ctx.tools.register(tool); registered++ } catch (error) {
      console.error(`[${name}] ${tool.name} 注册失败：${error}`)
    }
  }
  trace(`apply: 注册了 ${registered} 个工具`)

  // 界面路由
  registerHttpRoutes(ctx)

  ctx.logger?.info?.(`${name}: 已挂载（${registered} 个工具），输出默认到 ${defaultOutDir()}`)
}

/** 落盘诊断日志：区分「没 import」和「import 了但 apply 没跑」 */
function trace(message) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const dir = join(home, 'audio-converter')
    mkdirSync(dir, { recursive: true })
    const line = `${new Date().toISOString()} ${message}\n`
    writeFileSync(join(dir, 'debug.log'), line, { flag: 'a' })
  } catch { /* 诊断失败不影响主流程 */ }
}

export { apply, name, inject }
export { detectFormat, decryptionSupport, capabilityMatrix, ACCEPT_EXTS, defaultOutDir }
export const __test = { jobs, enqueue, createJob, publicJob, enhancePreset }
export default { apply, name, inject }
