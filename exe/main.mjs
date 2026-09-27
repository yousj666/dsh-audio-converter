#!/usr/bin/env node
/**
 * 单文件 exe 的入口。
 *
 * 两种用法：
 *   拖文件/文件夹到 exe 上   → 直接转成 mp3，输出到桌面
 *   双击（无参数）           → 起一个本地设置界面，浏览器里选文件、选格式
 *
 * 为什么要区分：拖拽是最快的路径（日常批量转），但格式/增强这些选项得有地方选。
 * 双击开界面，拖拽走默认值。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { basename, extname, join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { processFile, detectFormat, decryptionSupport } from '../lib/pipeline.js'
import { ffmpegAvailable, supportedFormats } from '../lib/ffmpeg.js'
import { capabilityMatrix } from '../lib/index.js'
import { isSea, runtimeDir } from '../lib/resources.js'

// HERE 不再需要（资源走 resources.js）

const ACCEPT = ['.ncm', '.kwm', '.kgm', '.kgma', '.vpr',
  '.qmc0', '.qmc2', '.qmc3', '.qmcflac', '.qmcogg', '.tkm',
  '.mflac', '.mflac0', '.mflac2', '.mgg', '.mgg0', '.mgg1', '.mgg2', '.mmp4', '.xm',
  '.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma', '.aiff', '.ape']
const ACCEPT_SET = new Set(ACCEPT)

const ENHANCE_PRESETS = {
  none: null,
  loudness: { loudness: -16, truePeak: -1.5 },
  night: { dynamics: 'night', loudness: -18, truePeak: -1.5 },
  warm: { highpass: true, eq: 'warm' },
  bright: { highpass: true, eq: 'bright' },
  vocal: { highpass: true, eq: 'vocal' },
  bass: { highpass: true, eq: 'bass' },
  full: { highpass: true, eq: 'warm', dynamics: 'night', loudness: -16, truePeak: -1.5 },
}

const defaultOutDir = () => join(homedir(), 'Desktop', '音频转换输出')
const mb = (n) => (n / 1048576).toFixed(2) + ' MB'

/* ================================================================== *
 * 一、拖拽模式：直接转
 * ================================================================== */
function expandInputs(inputs) {
  const files = []
  for (const p of inputs) {
    const full = resolve(p)
    if (!existsSync(full)) { files.push({ path: full, missing: true }); continue }
    let st
    try { st = statSync(full) } catch { files.push({ path: full, missing: true }); continue }
    if (st.isDirectory()) {
      let entries = []
      try { entries = readdirSync(full) } catch { /* 读不了就跳过 */ }
      for (const f of entries) {
        const fp = join(full, f)
        try { if (statSync(fp).isFile() && ACCEPT_SET.has(extname(f).toLowerCase())) files.push({ path: fp }) } catch { /* 跳过 */ }
      }
    } else {
      files.push({ path: full })
    }
  }
  return files
}

async function runDropMode(inputs) {
  const ff = await ffmpegAvailable()
  if (!ff.ok) {
    console.error('❌ ffmpeg 不可用')
    console.error('   ' + String(ff.error || '').split('\n')[0])
    return 1
  }

  const files = expandInputs(inputs)
  const missing = files.filter((f) => f.missing)
  const real = files.filter((f) => !f.missing)

  console.log('')
  console.log('════════════════════════════════════════════')
  console.log('  音频转换器')
  console.log('════════════════════════════════════════════')
  console.log('  找到 ' + real.length + ' 个文件' + (missing.length ? '，' + missing.length + ' 个路径不存在' : ''))
  console.log('  输出到 ' + defaultOutDir())
  console.log('  默认转成 mp3（想要别的格式请双击本程序打开设置界面）')
  console.log('')
  missing.forEach((m) => console.log('  ⚠️ 找不到：' + m.path))
  if (!real.length) {
    console.log('')
    console.log('  按任意键退出…')
    await waitKey()
    return 1
  }

  const outDir = defaultOutDir()
  mkdirSync(outDir, { recursive: true })

  let ok = 0
  let bad = 0
  for (let i = 0; i < real.length; i++) {
    const f = real[i]
    process.stdout.write(`  [${i + 1}/${real.length}] ${basename(f.path)} … `)
    const t0 = Date.now()
    const r = await processFile({
      input: f.path, outDir, format: 'mp3', quality: 'standard',
      embedCover: true, writeTags: true,
    })
    if (r.ok) {
      ok++
      console.log('✅  ' + mb(r.sizeBytes) + ' → ' + mb(r.outSizeBytes) + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')
    } else {
      bad++
      console.log('❌')
      console.log('        ' + String(r.error || '').replace(/\n/g, '\n        '))
    }
  }

  console.log('')
  console.log('════════════════════════════════════════════')
  console.log(`  完成 ${ok} 个${bad ? '，失败 ' + bad + ' 个' : ''}`)
  console.log('  输出目录：' + outDir)
  console.log('════════════════════════════════════════════')
  console.log('')
  console.log('  按任意键退出…')
  await waitKey()
  return bad === 0 ? 0 : 1
}

function waitKey() {
  return new Promise((res) => {
    if (!process.stdin.isTTY) return setTimeout(res, 8000)
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.once('data', () => { try { process.stdin.setRawMode(false) } catch { /* 忽略 */ } ; res() })
    } catch { setTimeout(res, 8000) }
  })
}

/* ================================================================== *
 * 二、界面模式：本地网页
 * ================================================================== */
function htmlPage() {
  const caps = capabilityMatrix()
  const capRows = caps.map((c) => {
    const mark = c.status === 'supported' ? '支持' : c.status === 'todo' ? '待实现' : '不可能'
    const cls = c.status === 'supported' ? 'ok' : c.status === 'todo' ? 'todo' : 'no'
    return `<tr><td class="mark ${cls}">${mark}</td><td>${c.platform}</td><td class="ext">${c.ext}</td><td class="note">${c.note}</td></tr>`
  }).join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>音频转换器</title>
<style>
:root{--fg:#1c1c1c;--dim:#6b6b6b;--bg:#faf9f7;--bg2:#f1efec;--line:#dcd8d2;--accent:#a8551f;
--ok:#3f7a3a;--bad:#c0563d;--warn:#b8860b}
@media (prefers-color-scheme:dark){:root{--fg:#e8e6e3;--dim:#9a9793;--bg:#1b1a19;--bg2:#242322;
--line:#3a3836;--accent:#d98a4f;--ok:#7fb069;--bad:#e07856;--warn:#d4a72c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:34px 24px 60px}
h1{font-size:20px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:12.5px;margin-bottom:22px}
h2{font-size:13px;font-weight:650;color:var(--dim);margin:26px 0 12px;letter-spacing:.02em}
#drop{border:2px dashed var(--line);border-radius:10px;padding:38px 20px;text-align:center;
transition:border-color .15s,background-color .15s}
#drop.over{border-color:var(--accent);background:var(--bg2)}
#drop h3{margin:0 0 6px;font-size:15px;font-weight:650}
#drop p{margin:0;color:var(--dim);font-size:12.5px;max-width:62ch;margin-inline:auto}
.btns{margin-top:16px;display:flex;gap:9px;justify-content:center;flex-wrap:wrap}
button{font:inherit;font-size:12.5px;padding:7px 16px;border-radius:6px;border:1px solid var(--line);
background:none;color:var(--fg);cursor:pointer}
button:hover:not(:disabled){border-color:var(--dim)}
button.primary{border-color:var(--accent);color:var(--accent);font-weight:600}
button:disabled{opacity:.45;cursor:default}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:13px}
label.f{display:block}
label.f>span{display:block;font-size:12px;color:var(--dim);margin-bottom:5px}
select,input[type=text]{width:100%;background:var(--bg2);color:var(--fg);border:1px solid var(--line);
border-radius:6px;padding:7px 10px;font:inherit}
.hint{font-size:12px;color:var(--dim);margin-top:12px;max-width:66ch;line-height:1.7}
.list{margin-top:10px}
.item{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--line);
border-radius:6px;margin-bottom:6px;background:var(--bg2);font-size:12.5px}
.item .nm{flex:1;overflow-wrap:anywhere}
.tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:3px;padding:1px 7px;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:12.5px}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.mark{width:64px;white-space:nowrap;font-weight:600}
td.mark.ok{color:var(--ok)}td.mark.todo{color:var(--warn)}td.mark.no{color:var(--bad)}
td.ext{color:var(--dim);white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
td.note{color:var(--dim)}
.bar{height:3px;background:var(--line);border-radius:2px;overflow:hidden;margin-top:6px}
.bar>i{display:block;width:36%;height:100%;background:var(--accent);animation:sl 1.1s ease-in-out infinite}
@keyframes sl{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}
.msg{border-radius:6px;padding:10px 13px;margin:14px 0;font-size:12.5px;white-space:pre-wrap}
.msg.err{background:rgba(192,86,61,.12);color:var(--bad)}
.msg.ok{background:rgba(63,122,58,.12);color:var(--ok)}
a.dl{color:var(--accent);font-weight:600}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body><div class="wrap">
<h1>音频转换器</h1>
<div class="sub" id="ffline">检查 ffmpeg…</div>

<div id="drop">
  <h3>把音频文件拖到这里</h3>
  <p>支持网易云 .ncm、酷我 .kwm、酷狗 .kgm、QQ音乐 .qmc/.mflac/.mgg，以及 mp3 / flac / m4a / aac / wav / ogg / opus 等常规格式。<b>文件只在本机处理，不上传任何服务器。</b></p>
  <div class="btns">
    <button id="pick">选择文件</button>
    <input type="file" id="file" multiple accept="${ACCEPT.join(',')}" style="display:none">
  </div>
</div>

<div id="msg"></div>
<div class="list" id="list"></div>

<h2>转换设置</h2>
<div class="grid">
  <label class="f"><span>目标格式</span><select id="format">
    <option value="mp3">MP3</option><option value="flac">FLAC（无损）</option>
    <option value="m4a">M4A</option><option value="aac">AAC</option>
    <option value="wav">WAV</option><option value="ogg">OGG</option><option value="opus">OPUS</option>
    <option value="">沿用源格式（只解密）</option></select></label>
  <label class="f"><span>质量</span><select id="quality">
    <option value="standard">标准</option><option value="best">质量优先</option><option value="small">体积优先</option></select></label>
  <label class="f"><span>位深（仅无损）</span><select id="bitDepth">
    <option value="">保持原样</option><option value="16">16 位</option><option value="24">24 位</option><option value="32">32 位</option></select></label>
  <label class="f"><span>音质增强</span><select id="enhance">
    <option value="none">不处理</option><option value="loudness">响度归一化</option>
    <option value="night">夜间（压缩动态）</option><option value="warm">暖声 EQ</option>
    <option value="bright">明亮 EQ</option><option value="vocal">人声突出</option>
    <option value="bass">低频增强</option><option value="full">全套处理</option></select></label>
  <label class="f"><span>QQ音乐 EKey（可选）</span><input type="text" id="ekey" placeholder="仅 STag / MusicEx 尾包需要" spellcheck="false"></label>
</div>
<div class="hint">
  <b>关于「音质增强」</b>：它改变的是<b>听感</b>（响度更一致、动态更可控、频响更合口味），
  但<b>无法恢复有损编码已经丢掉的信息</b> —— 128kbps 的 mp3 转成 FLAC 不会变好听。
</div>
<div class="btns" style="justify-content:flex-start;margin-top:16px">
  <button class="primary" id="go" disabled>开始转换</button>
</div>
<div class="hint" id="outdir"></div>

<h2>加密格式支持情况</h2>
<table>${capRows}</table>
<div class="hint">
  「不可能」不是「还没做」—— QQ 音乐新版把密钥放在服务端、和设备指纹绑定，
  本地文件里根本没有解密的材料。与其假装支持然后吐个坏文件，不如直接说清楚。
</div>
</div>
<script>
const $=s=>document.querySelector(s);
let files=[];
function fmtBytes(n){return (n/1048576).toFixed(2)+' MB'}
function show(kind,text){const m=$('#msg');m.className='msg '+kind;m.textContent=text}

fetch('/api/status').then(r=>r.json()).then(s=>{
  $('#ffline').textContent = s.ffmpeg.ok ? ('ffmpeg 就绪 · '+s.ffmpeg.version.split(' ').slice(0,3).join(' ')) : 'ffmpeg 不可用';
  $('#outdir').textContent = '输出目录：'+s.defaultOutDir;
}).catch(()=>{$('#ffline').textContent='无法连接本地服务'});

function addFiles(list){
  for(const f of list){
    if(files.some(x=>x.name===f.name&&x.size===f.size))continue;
    files.push(f);
  }
  render();
}
function render(){
  const el=$('#list');el.innerHTML='';
  files.forEach((f,i)=>{
    const d=document.createElement('div');d.className='item';
    d.innerHTML='<span class="nm"></span><span class="tag">'+fmtBytes(f.size)+'</span>';
    d.querySelector('.nm').textContent=f.name;
    const b=document.createElement('button');b.textContent='移除';
    b.onclick=()=>{files.splice(i,1);render()};
    d.appendChild(b);el.appendChild(d);
  });
  $('#go').disabled=!files.length;
  $('#go').textContent='开始转换'+(files.length?('（'+files.length+' 个）'):'');
}
$('#pick').onclick=()=>$('#file').click();
$('#file').onchange=e=>{addFiles(e.target.files);e.target.value=''};
const drop=$('#drop');
drop.ondragover=e=>{e.preventDefault();drop.classList.add('over')};
drop.ondragenter=e=>{e.preventDefault();drop.classList.add('over')};
drop.ondragleave=e=>{if(e.target===drop)drop.classList.remove('over')};
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');addFiles(e.dataTransfer.files)};

$('#go').onclick=async()=>{
  if(!files.length)return;
  $('#go').disabled=true;
  show('ok','正在上传…');
  const paths=[];
  for(const f of files){
    try{
      const r=await fetch('/api/upload?name='+encodeURIComponent(f.name),{method:'POST',body:f});
      const j=await r.json();
      if(j.ok)paths.push(j.path); else show('err',f.name+' 上传失败：'+j.error);
    }catch(e){show('err',f.name+' 上传失败：'+e.message)}
  }
  if(!paths.length){$('#go').disabled=false;return}
  const body={
    inputs:paths,
    format:$('#format').value||undefined,
    quality:$('#quality').value,
    bitDepth:$('#bitDepth').value?Number($('#bitDepth').value):undefined,
    enhance:$('#enhance').value==='none'?undefined:$('#enhance').value,
    ekey:$('#ekey').value.trim()||undefined,
  };
  const sub=await (await fetch('/api/convert',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
  if(!sub.ok){show('err',sub.error||'提交失败');$('#go').disabled=false;return}
  poll(sub.jobId);
};

async function poll(id){
  try{
    const s=await (await fetch('/api/job?id='+id)).json();
    if(!s.ok){show('err','任务查不到');$('#go').disabled=false;return}
    const j=s.job;
    if(j.status==='running'||j.status==='queued'){
      show('ok','处理中…'+(j.stage?('  ['+j.stage+']'):''));
      setTimeout(()=>poll(id),400);return;
    }
    $('#go').disabled=false;files=[];render();
    if(j.status==='done'){
      show('ok','完成：'+j.outputName+'\\n'+fmtBytes(j.sizeBytes)+' → '+fmtBytes(j.outSizeBytes)+'  用时 '+j.elapsedMs+' ms\\n\\n'+(j.notes||[]).join('\\n'));
    }else{
      show('err','失败：'+(j.error||'未知错误'));
    }
  }catch(e){show('err','轮询失败：'+e.message);$('#go').disabled=false}
}
</script></body></html>`
}

function startUiServer() {
  const jobs = new Map()
  const incoming = join(runtimeDir(), 'incoming')

  const readBytes = (req, limit = 512 * 1024 * 1024) => new Promise((res, rej) => {
    const chunks = []; let total = 0
    req.on('data', (c) => { total += c.length; if (total > limit) return rej(new Error('文件过大')); chunks.push(c) })
    req.on('end', () => res(Buffer.concat(chunks)))
    req.on('error', rej)
  })
  const readJson = (req) => new Promise((res) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) raw = raw.slice(0, 2e6) })
    req.on('end', () => { try { res(raw ? JSON.parse(raw) : {}) } catch { res({}) } })
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    // 只服务本机
    const ra = req.socket.remoteAddress || ''
    if (!/^(127\.|::1|::ffff:127\.)/.test(ra)) return json(403, { error: 'forbidden' })

    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(htmlPage())
      }
      if (url.pathname === '/api/status') {
        const ff = await ffmpegAvailable()
        return json(200, {
          ok: true,
          ffmpeg: { ok: ff.ok, version: ff.version ?? '', error: ff.error ?? null },
          formats: supportedFormats(),
          defaultOutDir: defaultOutDir(),
        })
      }
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        const rawName = url.searchParams.get('name') || 'upload.bin'
        const safe = basename(rawName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'upload.bin'
        mkdirSync(incoming, { recursive: true })
        const target = join(incoming, Date.now() + '-' + safe)
        const bytes = await readBytes(req)
        if (!bytes.length) return json(400, { ok: false, error: '没有收到数据' })
        writeFileSync(target, bytes)
        return json(200, { ok: true, path: target, sizeBytes: bytes.length, name: safe })
      }
      if (url.pathname === '/api/convert' && req.method === 'POST') {
        const body = await readJson(req)
        const inputs = Array.isArray(body.inputs) ? body.inputs : [body.inputs].filter(Boolean)
        if (!inputs.length) return json(400, { ok: false, error: '缺少 inputs' })
        const id = randomUUID()
        const job = { id, status: 'queued', stage: 'queued', createdAt: Date.now() }
        jobs.set(id, job)
        // 后台跑，不阻塞响应
        ;(async () => {
          job.status = 'running'
          const outDir = defaultOutDir()
          mkdirSync(outDir, { recursive: true })
          const results = []
          for (const input of inputs) {
            job.stage = basename(input)
            const r = await processFile({
              input, outDir,
              format: body.format, quality: body.quality || 'standard',
              bitDepth: body.bitDepth, enhance: ENHANCE_PRESETS[body.enhance] ?? null,
              embedCover: true, writeTags: true, ekey: body.ekey,
            })
            results.push(r)
          }
          const first = results[0] || {}
          job.status = results.every((r) => r.ok) ? 'done' : 'failed'
          job.outputName = results.map((r) => (r.ok ? basename(r.output) : basename(r.input))).join('、')
          job.sizeBytes = first.sizeBytes ?? null
          job.outSizeBytes = results.reduce((a, r) => a + (r.outSizeBytes ?? 0), 0)
          job.elapsedMs = Date.now() - job.createdAt
          job.notes = results.flatMap((r) => r.notes ?? [])
          job.error = results.find((r) => !r.ok)?.error ?? null
        })().catch((e) => { job.status = 'failed'; job.error = String(e?.message ?? e) })
        return json(200, { ok: true, jobId: id })
      }
      if (url.pathname === '/api/job') {
        const job = jobs.get(url.searchParams.get('id'))
        if (!job) return json(404, { ok: false, error: '没有这个任务' })
        return json(200, { ok: true, job })
      }
      return json(404, { error: 'not found' })
    } catch (error) {
      return json(500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const url = `http://127.0.0.1:${port}/`
      console.log('')
      console.log('════════════════════════════════════════════')
      console.log('  音频转换器')
      console.log('════════════════════════════════════════════')
      console.log('')
      console.log('  设置界面已启动：' + url)
      console.log('  浏览器应该自动打开了。没打开就手动复制上面这个地址。')
      console.log('')
      console.log('  输出目录：' + defaultOutDir())
      console.log('  关掉这个窗口即停止。')
      console.log('')
      // 打开默认浏览器
      try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
        else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
        else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
      } catch { /* 打不开就让用户手点 */ }
      res({ server, url, port })
    })
  })
}

/* ================================================================== *
 * 入口
 * ================================================================== */
async function main() {
  const argv = process.argv.slice(2)

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
音频转换器${isSea() ? '（单文件版）' : ''}

  拖文件/文件夹到本程序上   直接转成 mp3
  双击本程序               打开设置界面（选格式、增强等）
  命令行                   本程序 <文件或文件夹...> [--format mp3]

  支持解密：网易云 .ncm / 酷我 .kwm / 酷狗 .kgm / QQ音乐 .qmc .mflac .mgg
  常规互转：mp3 / flac / m4a / aac / wav / ogg / opus
`)
    return 0
  }

  const ff = await ffmpegAvailable()
  if (!ff.ok) {
    console.error('❌ ffmpeg 不可用，无法转换。')
    console.error(String(ff.error || '').split('\n').slice(0, 3).join('\n'))
    return 1
  }

  if (argv.length) return runDropMode(argv)

  // 无参数 → 界面模式，挂着不退出
  const { server } = await startUiServer()
  await new Promise(() => { void server })
  return 0
}

main().then((c) => { if (c !== undefined) process.exitCode = c }).catch((e) => {
  console.error('')
  console.error('❌ 出错了：' + (e?.stack || e))
  console.error('')
  process.exitCode = 1
})
