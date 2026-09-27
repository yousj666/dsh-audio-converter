/**
 * host 半边测试
 *
 * 用 mock ctx 把插件跑起来，抓出注册的工具和 HTTP 路由，然后：
 *   · 验证工具形状与安全栅栏
 *   · 真调 audio_capabilities / audio_inspect / audio_convert（真实 NCM）
 *   · 验证 job 模型（提交 → 轮询 → 完成）
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'dsh-audio-host-'))
process.env.DSH_HOME = work

const mod = await import('./lib/index.js')
const { apply, name, inject, detectFormat, decryptionSupport, capabilityMatrix } = mod

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

/* ---------------- mock ctx ---------------- */
const tools = []
const routes = []
let injectCalls = 0

const ctx = {
  get(key) {
    if (key === 'tools') return { register: (d) => { tools.push(d); return () => {} } }
    return undefined
  },
  inject(names, fn) {
    injectCalls++
    if (names.includes('webServer')) {
      const scope = { webServer: { register: (r) => { routes.push(r); return () => {} } } }
      const d = fn(scope)
      return typeof d === 'function' ? d : () => {}
    }
    const d = fn(ctx)
    return typeof d === 'function' ? d : () => {}
  },
  tools: { register: (d) => { tools.push(d); return () => {} } },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  logger: { info() {}, warn() {}, error() {} },
}

/* ================================================================== *
 * 1. 挂载
 * ================================================================== */
section('1. 挂载与注册')
console.log('  name=' + name + '  inject=' + JSON.stringify(inject))
apply(ctx)

const toolNames = tools.map((t) => t.name)
check('注册了 3 个工具', tools.length === 3, toolNames.join(','))
check('工具名正确', ['audio_convert', 'audio_inspect', 'audio_capabilities'].every((n) => toolNames.includes(n)),
  toolNames.join(','))
check('inject 只硬依赖 tools（其余走 ctx.get 软取）', inject.length === 1 && inject[0] === 'tools',
  JSON.stringify(inject))
for (const t of tools) {
  check(`  ${t.name} 形状完整`, typeof t.description === 'string' && t.description.length > 30 &&
    t.parameters?.type === 'object' && typeof t.execute === 'function' &&
    typeof t.output?.render === 'function' && !!t.output?.schema)
}

const routeNames = routes.map((r) => r.path)
check('注册了 5 条路由', routes.length === 5, routeNames.join(','))
check('路由路径正确', ['/dsh-audio/status', '/dsh-audio/upload', '/dsh-audio/submit', '/dsh-audio/jobs', '/dsh-audio/clear']
  .every((p) => routeNames.includes(p)), routeNames.join(','))
check('每条路由都是 exact + 有 handler', routes.every((r) => r.kind === 'exact' && typeof r.handler === 'function'))

/* ---------------- 路由调用脚手架 ---------------- */
async function callRoute(path, { method = 'GET', headers = {}, body, rawBody, query = {} } = {}) {
  const route = routes.find((r) => r.path === path)
  if (!route) throw new Error('没有这条路由: ' + path)
  const qs = new URLSearchParams(query).toString()
  const req = {
    method,
    url: path + (qs ? '?' + qs : ''),
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin', ...headers },
    on(event, fn) {
      if (event === 'data') {
        if (rawBody) fn(rawBody)
        else if (body) fn(Buffer.from(JSON.stringify(body)))
      }
      if (event === 'end') fn()
      return req
    },
  }
  let status = 0
  let payload = null
  const res = { writeHead(c) { status = c; return res }, end(t) { try { payload = JSON.parse(t) } catch { payload = t } } }
  await route.handler(req, res)
  return { status, payload }
}

/* ================================================================== *
 * 2. 安全栅栏
 * ================================================================== */
section('2. HTTP 安全栅栏')
const forbidden = await callRoute('/dsh-audio/status', { headers: { host: 'evil.example.com' } })
check('非回环 Host 被拒（403）', forbidden.status === 403, JSON.stringify(forbidden.payload))
const crossSite = await callRoute('/dsh-audio/status', { headers: { 'sec-fetch-site': 'cross-site' } })
check('跨站发起被拒（403）', crossSite.status === 403)
const wrongMethod = await callRoute('/dsh-audio/submit', { method: 'GET' })
check('GET 打 /submit 返回 405', wrongMethod.status === 405)

/* ================================================================== *
 * 3. /status
 * ================================================================== */
section('3. GET /status')
const st = await callRoute('/dsh-audio/status')
check('返回 200', st.status === 200)
check('带 ffmpeg 状态', typeof st.payload?.ffmpeg?.ok === 'boolean', JSON.stringify(st.payload?.ffmpeg))
check('带格式列表', Array.isArray(st.payload?.formats) && st.payload.formats.length === 7)
check('带能力矩阵', Array.isArray(st.payload?.capabilities) && st.payload.capabilities.length >= 5)
check('带可接受扩展名', Array.isArray(st.payload?.acceptExts) && st.payload.acceptExts.includes('.ncm'))
check('带默认输出目录', typeof st.payload?.defaultOutDir === 'string')
console.log('    ffmpeg: ' + (st.payload.ffmpeg.ok ? st.payload.ffmpeg.version.slice(0, 50) : st.payload.ffmpeg.error))

/* ================================================================== *
 * 4. 上传（拖拽）
 * ================================================================== */
section('4. POST /upload（模拟拖拽）')
const fakeBytes = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(2048, 0x5a)])
const up = await callRoute('/dsh-audio/upload', { method: 'POST', query: { name: '测试 歌曲.flac' }, rawBody: fakeBytes })
check('上传成功', up.status === 200 && up.payload?.ok === true, JSON.stringify(up.payload))
check('落盘字节数一致', up.payload?.sizeBytes === fakeBytes.length, String(up.payload?.sizeBytes))
check('文件名里的特殊字符被清理', !/[<>:"/\\|?*]/.test(up.payload?.name ?? ''), up.payload?.name)
check('文件真的写出来了', existsSync(up.payload?.path))

// 路径穿越防护
const evil = await callRoute('/dsh-audio/upload', { method: 'POST', query: { name: '../../../evil.exe' }, rawBody: fakeBytes })
check('路径穿越被挡（只取文件名）', evil.payload?.path && !evil.payload.path.includes('..'), evil.payload?.path)
check('穿越后的文件仍落在 incoming 目录里', evil.payload?.path?.includes('audio-converter'), evil.payload?.path)

// 空数据
const empty = await callRoute('/dsh-audio/upload', { method: 'POST', rawBody: Buffer.alloc(0) })
check('空数据被拒（400）', empty.status === 400)

/* ================================================================== *
 * 5. 工具：audio_capabilities
 * ================================================================== */
section('5. 工具 audio_capabilities')
const capTool = tools.find((t) => t.name === 'audio_capabilities')
const capRes = await capTool.execute({}, {})
check('返回 ok', capRes.ok === true)
check('带 formats 数组', Array.isArray(capRes.formats) && capRes.formats.length === 7)
check('带 capabilities 数组', Array.isArray(capRes.capabilities))
const matrix = capRes.capabilities
check('NCM 标为 supported', matrix.find((c) => c.ext.includes('ncm'))?.status === 'supported')
check('KWM 标为 supported', matrix.find((c) => c.ext.includes('kwm'))?.status === 'supported')
check('KGM 标为 supported 且说明 KGG 不支持', (() => {
  const c = matrix.find((x) => x.ext.includes('kgm'))
  return c?.status === 'supported' && /KGG/.test(c.note)
})())
check('QMC v1 标为 supported', (() => {
  const c = matrix.find((x) => x.platform.includes('v1'))
  return c?.status === 'supported'
})())
check('QMC v2 标为 supported 且说明尾包密钥的区别', (() => {
  const c = matrix.find((x) => x.platform.includes('v2'))
  return c?.status === 'supported' && /QTag|EKey/.test(c.note)
})())
check('新版 QMC 标为 impossible 且说明原因', (() => {
  const c = matrix.find((x) => /mgg1/.test(x.ext))
  return c?.status === 'impossible' && /动态密钥/.test(c.note)
})())
check('渲染文本里 ffmpeg 状态可见', /ffmpeg/.test(capRes.message))
console.log('    能力矩阵渲染：')
capRes.message.split('\n').slice(0, 14).forEach((l) => console.log('    ' + l))

/* ================================================================== *
 * 6. 工具：audio_inspect
 * ================================================================== */
section('6. 工具 audio_inspect')
const srcNcm = 'G:\\CloudMusic\\VipSongsDownload\\The Little Dippers - Forever.ncm'
const insp = tools.find((t) => t.name === 'audio_inspect')
if (existsSync(srcNcm)) {
  const r = await insp.execute({ inputs: [srcNcm] }, {})
  check('返回 ok', r.ok === true)
  check('识别为 ncm', r.results?.[0]?.kind === 'ncm', JSON.stringify(r.results?.[0]))
  check('标为可解密', r.results?.[0]?.decryptable === true)
  check('渲染文本里有文件名', r.message.includes('Forever'))
  console.log('    ' + r.message.split('\n').slice(0, 4).join('\n    '))
}
// 不在的文件
const missing = await insp.execute({ inputs: ['C:\\nope\\nothere.mp3'] }, {})
check('文件不存在时返回失败', missing.ok === false, JSON.stringify(missing).slice(0, 100))

/* ================================================================== *
 * 7. 工具：audio_convert（真实转换）
 * ================================================================== */
section('7. 工具 audio_convert（真实 NCM）')
const conv = tools.find((t) => t.name === 'audio_convert')
if (existsSync(srcNcm) && st.payload.ffmpeg.ok) {
  const outDir = join(work, 'out')
  const r = await conv.execute({
    inputs: [srcNcm], output_dir: outDir, format: 'flac', quality: 'standard',
    embed_cover: false, write_tags: true,
  }, {})
  check('转换成功', r.ok === true, r.message?.slice(0, 200))
  check('返回 results 数组', Array.isArray(r.results) && r.results.length === 1)
  if (r.results?.[0]?.ok) {
    const res = r.results[0]
    console.log('    ' + res.input.split('\\').pop() + ' → ' + res.output.split('\\').pop())
    console.log('    ' + (res.sizeBytes / 1048576).toFixed(2) + ' MB → ' + (res.outSizeBytes / 1048576).toFixed(2) + ' MB  ' +
      res.srcFormat + ' → ' + res.format)
    check('输出文件存在', existsSync(res.output))
    check('输出是 flac', res.format === 'flac')
    check('渲染文本里有箭头', r.message.includes('→'))
  }
  // EKey 参数得露出来 —— 否则 STag/MusicEx 尾包的 QMC v2 文件没法解
  const convParams = conv.parameters?.properties ?? {}
  check('工具声明了 ekey 参数', !!convParams.ekey)
  check('ekey 说明里点明了只有 STag/MusicEx 需要', /STag|MusicEx/.test(convParams.ekey?.description ?? ''),
    String(convParams.ekey?.description).slice(0, 60))
  // 能力矩阵里 QMC v2 要标成 supported
  check('能力矩阵里 QMC v2 是 supported', (() => {
    const c = matrix.find((x) => x.platform.includes('v2'))
    return c?.status === 'supported'
  })())
  // 批量：目录
  const dir = 'G:\\CloudMusic\\VipSongsDownload'
  const rb = await conv.execute({ inputs: [dir], output_dir: join(work, 'batch'), format: 'mp3', embed_cover: false, write_tags: false }, {})
  check('目录批量处理成功', rb.ok === true, rb.message?.slice(0, 150))
  check('处理了多个文件', (rb.results?.length ?? 0) >= 1, String(rb.results?.length))
  // 空输入
  const re = await conv.execute({ inputs: [] }, {})
  check('空 inputs 被拒', re.ok === false)
} else { console.log('  ⏭  素材或 ffmpeg 不可用，跳过') }

/* ================================================================== *
 * 8. job 模型
 * ================================================================== */
section('8. job 模型（提交 → 轮询）')
if (existsSync(srcNcm) && st.payload.ffmpeg.ok) {
  const sub = await callRoute('/dsh-audio/submit', {
    method: 'POST',
    body: { inputs: [srcNcm], outDir: join(work, 'jobs'), format: 'mp3', embedCover: false, writeTags: false },
  })
  check('提交返回 jobIds', sub.status === 200 && Array.isArray(sub.payload?.jobIds), JSON.stringify(sub.payload))
  const jobId = sub.payload.jobIds[0]
  check('提交返回 outDir', typeof sub.payload.outDir === 'string')

  // 轮询直到完成
  let job = null
  for (let i = 0; i < 60; i++) {
    const q = await callRoute('/dsh-audio/jobs', { query: { id: jobId } })
    job = q.payload?.job
    if (job && (job.status === 'done' || job.status === 'failed')) break
    await new Promise((r) => setTimeout(r, 250))
  }
  check('任务最终完成', job?.status === 'done', JSON.stringify({ status: job?.status, error: job?.error }))
  if (job?.status === 'done') {
    console.log('    ' + job.inputName + ' → ' + job.outputName + '  用时 ' + job.elapsedMs + 'ms')
    check('job 里带输出路径', typeof job.output === 'string' && existsSync(job.output))
    check('job 里带耗时', typeof job.elapsedMs === 'number' && job.elapsedMs >= 0)
  }
  const list = await callRoute('/dsh-audio/jobs')
  check('任务列表可查', Array.isArray(list.payload?.jobs) && list.payload.jobs.length >= 1)
  check('列表带 running 计数', typeof list.payload.running === 'number')
  const notFound = await callRoute('/dsh-audio/jobs', { query: { id: 'nope' } })
  check('查不存在的 job 返回 404', notFound.status === 404)
} else { console.log('  ⏭  跳过') }

/* ================================================================== *
 * 9. 清理
 * ================================================================== */
section('9. 清理接口')
const cl = await callRoute('/dsh-audio/clear', { method: 'POST', body: { jobs: 'all', incoming: 'all' } })
check('清理成功', cl.status === 200 && cl.payload?.ok === true)

section('结果')
console.log(`  通过 ${pass}    失败 ${fail}`)
if (fails.length) fails.forEach((f) => console.log('    ❌ ' + f))
console.log('')
console.log(fail === 0 ? '  ✅ 全部通过' : '  ❌ 有失败项')

try { rmSync(work, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(fail === 0 ? 0 : 1)
