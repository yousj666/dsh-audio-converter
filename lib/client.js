// dsh-audio-converter 的浏览器半边：会话视图里的「音频转换」页签。
//
// 手写在 lazy-CJS bundle 协议里（window.__ModuleLoader__.load + 一个返回
// cordis-plugin exports 的 factory），所以**不需要构建步骤**。
//
// 位置：conversation.view，order 40。
//   chat=0 / trajectory=10 / context=20 / auto-task=30 / 本插件=40
//
// 工作方式：
//   拖文件进来 → POST /dsh-audio/upload（原始字节）→ 拿到落盘路径
//              → POST /dsh-audio/submit → 拿到 job id
//              → 轮询 /dsh-audio/jobs 显示进度
// 长任务走 job 模型，界面不会卡住。
//
// 视觉上遵循「去 AI 味」那套：中性底色 + 单一强调色、无 emoji、65ch 行宽、
// 只动 transform/opacity、尊重 prefers-reduced-motion。
window.__ModuleLoader__.load({
  id: 'dsh-audio-converter',
  factory: (require) => {
    var module = { exports: {} }

    var react = require('react')
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useCallback = react.useCallback
    var useRef = react.useRef

    var API = '/dsh-audio'
    var NS = 'dsh-audio-converter'
    var PLUGIN_ID = 'audio-converter'

    var CSS = [
      '.dac-root{--dac-fg:var(--dsh-text,inherit);--dac-dim:var(--dsh-text-dim,rgba(127,127,127,.95));',
      '--dac-bg2:var(--dsh-surface-2,rgba(127,127,127,.07));',
      '--dac-line:var(--dsh-border,rgba(127,127,127,.28));--dac-accent:var(--dsh-accent,#a8551f);',
      '--dac-ok:#3f7a3a;--dac-bad:#c0563d;--dac-warn:#b8860b;',
      'color:var(--dac-fg);font-size:13px;line-height:1.6;height:100%;overflow:auto;padding:22px 26px 40px}',
      '.dac-inner{max-width:900px;margin:0 auto}',
      '.dac-hd{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}',
      '.dac-hd h2{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}',
      '.dac-sub{color:var(--dac-dim);font-size:12px}',
      '.dac-spacer{flex:1}',
      '.dac-btn{background:none;border:1px solid var(--dac-line);color:var(--dac-dim);',
      'border-radius:6px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer}',
      '.dac-btn:hover:not(:disabled){color:var(--dac-fg);border-color:var(--dac-dim)}',
      '.dac-btn:disabled{opacity:.45;cursor:default}',
      // 拖放区
      '.dac-drop{margin-top:16px;border:2px dashed var(--dac-line);border-radius:10px;',
      'padding:34px 20px;text-align:center;transition:border-color .15s,background-color .15s}',
      '.dac-drop[data-over="1"]{border-color:var(--dac-accent);background:var(--dac-bg2)}',
      '.dac-drop h3{margin:0 0 6px;font-size:14px;font-weight:650}',
      '.dac-drop p{margin:0;color:var(--dac-dim);font-size:12.5px;max-width:65ch;margin-inline:auto}',
      '.dac-drop .dac-acts{margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}',
      // 设置区
      '.dac-sec{margin-top:22px;padding-top:18px;border-top:1px solid var(--dac-line)}',
      '.dac-sec>h3{margin:0 0 12px;font-size:13px;font-weight:650;color:var(--dac-dim)}',
      '.dac-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}',
      '.dac-field{display:block}',
      '.dac-field>span{display:block;font-size:12px;color:var(--dac-dim);margin-bottom:5px}',
      '.dac-in{width:100%;box-sizing:border-box;background:var(--dac-bg2);color:var(--dac-fg);',
      'border:1px solid var(--dac-line);border-radius:6px;padding:7px 10px;font:inherit}',
      '.dac-in:focus{outline:2px solid var(--dac-accent);outline-offset:-1px}',
      '.dac-hint{font-size:12px;color:var(--dac-dim);margin-top:10px;max-width:65ch}',
      // 任务行
      '.dac-job{border:1px solid var(--dac-line);border-left:3px solid var(--dac-line);',
      'border-radius:7px;padding:9px 13px;margin-bottom:7px;background:var(--dac-bg2)}',
      '.dac-job[data-status="done"]{border-left-color:var(--dac-ok)}',
      '.dac-job[data-status="failed"]{border-left-color:var(--dac-bad)}',
      '.dac-job[data-status="running"]{border-left-color:var(--dac-accent)}',
      '.dac-job-row{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}',
      '.dac-job-name{font-weight:600;overflow-wrap:anywhere}',
      '.dac-tag{font-size:11px;padding:1px 7px;border-radius:3px;border:1px solid var(--dac-line);',
      'color:var(--dac-dim);white-space:nowrap}',
      '.dac-job-msg{color:var(--dac-dim);font-size:12px;margin-top:5px;overflow-wrap:anywhere}',
      '.dac-bar{height:3px;background:var(--dac-line);border-radius:2px;overflow:hidden;margin-top:7px}',
      '.dac-bar>i{display:block;width:40%;height:100%;background:var(--dac-accent);',
      'animation:dac-slide 1.1s ease-in-out infinite}',
      '@keyframes dac-slide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}',
      // 能力矩阵
      '.dac-cap{display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--dac-line)}',
      '.dac-cap:last-child{border-bottom:0}',
      '.dac-cap-mark{width:18px;flex:none;text-align:center}',
      '.dac-cap-platform{width:150px;flex:none}',
      '.dac-cap-note{color:var(--dac-dim);font-size:12px;flex:1}',
      '.dac-empty{color:var(--dac-dim);padding:14px 2px}',
      '.dac-msg{border-radius:6px;padding:9px 12px;margin-top:14px;font-size:12.5px}',
      '.dac-msg[data-kind="err"]{background:rgba(192,86,61,.13);color:var(--dac-bad)}',
      '.dac-msg[data-kind="ok"]{background:rgba(80,130,80,.15);color:var(--dac-ok)}',
      '@media (prefers-reduced-motion:reduce){.dac-root *{transition:none!important;animation:none!important}}',
    ].join('')

    function installStyles() {
      var el = document.createElement('style')
      el.setAttribute('data-dsh-plugin', NS)
      el.textContent = CSS
      document.head.appendChild(el)
      return function dispose() { try { el.remove() } catch (e) { /* 已移除 */ } }
    }

    function jsonReq(path, body) {
      var init = body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'GET' }
      return fetch(API + path, init).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status } })
      })
    }

    /** 上传一个 File，返回落盘路径。 */
    function uploadFile(file) {
      return fetch(API + '/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      }).then(function (r) { return r.json() })
    }

    /* ---------------------------------------------------------------- *
     * 主视图
     * ---------------------------------------------------------------- */
    function AudioView() {
      var [status, setStatus] = useState(null)
      var [jobs, setJobs] = useState([])
      var [running, setRunning] = useState(0)
      var [over, setOver] = useState(false)
      var [msg, setMsg] = useState(null)
      var [uploading, setUploading] = useState(0)

      var [rows, setRows] = useState([])          // 本次待处理的文件（已上传落盘）
      var [format, setFormat] = useState('')      // '' = 沿用源格式
      var [quality, setQuality] = useState('standard')
      var [bitDepth, setBitDepth] = useState('')
      var [enhance, setEnhance] = useState('none')
      var [embedCover, setEmbedCover] = useState(true)
      var [writeTags, setWriteTags] = useState(true)
      var [ekey, setEkey] = useState('')          // 只有 STag/MusicEx 尾包才需要

      var fileInput = useRef(null)
      var pollTimer = useRef(null)

      // 拉状态（ffmpeg / 能力矩阵）
      useEffect(function () {
        jsonReq('/status').then(function (r) {
          if (r && r.ok) setStatus(r)
          else setMsg({ kind: 'err', text: (r && r.error) || '读取状态失败' })
        }).catch(function (e) { setMsg({ kind: 'err', text: String(e && e.message || e) }) })
      }, [])

      // 轮询任务
      var refreshJobs = useCallback(function () {
        return jsonReq('/jobs').then(function (r) {
          if (r && r.ok) { setJobs(r.jobs || []); setRunning(r.running || 0) }
        }).catch(function () { /* 轮询失败不打扰用户 */ })
      }, [])

      useEffect(function () {
        refreshJobs()
        pollTimer.current = setInterval(refreshJobs, 1500)
        return function () { if (pollTimer.current) clearInterval(pollTimer.current) }
      }, [refreshJobs])

      // 只在有任务在跑时才需要高频轮询；这里保持常量间隔，简单可靠
      useEffect(function () {
        if (running > 0 && pollTimer.current) {
          clearInterval(pollTimer.current)
          pollTimer.current = setInterval(refreshJobs, 700)
        } else if (pollTimer.current) {
          clearInterval(pollTimer.current)
          pollTimer.current = setInterval(refreshJobs, 3000)
        }
        return function () { /* 下一轮 effect 会清 */ }
      }, [running, refreshJobs])

      /** 处理拖进来的文件 */
      var takeFiles = useCallback(function (fileList) {
        var files = Array.prototype.slice.call(fileList || [])
        if (!files.length) return
        setMsg(null)
        setUploading(files.length)
        var done = 0
        var uploaded = []
        var chain = Promise.resolve()
        files.forEach(function (f) {
          chain = chain.then(function () {
            return uploadFile(f).then(function (r) {
              done++
              setUploading(files.length - done)
              if (r && r.ok) uploaded.push({ name: r.name, path: r.path, sizeBytes: r.sizeBytes })
              else setMsg({ kind: 'err', text: f.name + ' 上传失败：' + ((r && r.error) || '未知') })
            }).catch(function (e) {
              done++
              setUploading(files.length - done)
              setMsg({ kind: 'err', text: f.name + ' 上传失败：' + String(e && e.message || e) })
            })
          })
        })
        chain.then(function () {
          if (uploaded.length) {
            setRows(function (prev) {
              var seen = {}
              prev.forEach(function (p) { seen[p.path] = 1 })
              return prev.concat(uploaded.filter(function (u) { return !seen[u.path] }))
            })
          }
        })
      }, [])

      /** 提交处理 */
      var submit = useCallback(function () {
        if (!rows.length) return
        setMsg(null)
        jsonReq('/submit', {
          inputs: rows.map(function (r) { return r.path }),
          format: format || undefined,
          quality: quality,
          bitDepth: bitDepth ? Number(bitDepth) : undefined,
          enhance: enhance === 'none' ? undefined : enhance,
          embedCover: embedCover,
          writeTags: writeTags,
          ekey: ekey.trim() || undefined,
        }).then(function (r) {
          if (r && r.ok) {
            setMsg({ kind: 'ok', text: '已提交 ' + r.total + ' 个任务，输出到 ' + r.outDir })
            setRows([])
            refreshJobs()
          } else {
            setMsg({ kind: 'err', text: (r && r.error) || '提交失败' })
          }
        }).catch(function (e) { setMsg({ kind: 'err', text: String(e && e.message || e) }) })
      }, [rows, format, quality, bitDepth, enhance, embedCover, writeTags, refreshJobs])

      var clearDone = useCallback(function () {
        jsonReq('/clear', { jobs: 'all' }).then(refreshJobs)
      }, [refreshJobs])

      var fmtList = (status && status.formats) || []
      var caps = (status && status.capabilities) || []
      var ff = status && status.ffmpeg
      var busy = uploading > 0

      function capMark(s) { return s === 'supported' ? '✅' : s === 'todo' ? '🔨' : '❌' }

      return h('div', { className: 'dac-root' },
        h('div', { className: 'dac-inner' },

          h('div', { className: 'dac-hd' },
            h('h2', null, '音频转换'),
            h('span', { className: 'dac-sub' },
              ff ? (ff.ok ? 'ffmpeg 就绪' : 'ffmpeg 不可用') : '读取中…'),
            h('span', { className: 'dac-spacer' }),
            h('button', { className: 'dac-btn', onClick: refreshJobs }, '刷新')),

          ff && !ff.ok
            ? h('div', { className: 'dac-msg', 'data-kind': 'err' },
                'ffmpeg 不可用，无法转换。安装：winget install Gyan.FFmpeg。' + (ff.error ? '（' + ff.error.split('\n')[0] + '）' : ''))
            : null,

          msg ? h('div', { className: 'dac-msg', 'data-kind': msg.kind }, msg.text) : null,

          // ── 拖放区 ──
          h('div', {
            className: 'dac-drop',
            'data-over': over ? '1' : '0',
            onDragOver: function (e) { e.preventDefault(); setOver(true) },
            onDragEnter: function (e) { e.preventDefault(); setOver(true) },
            onDragLeave: function (e) {
              if (e.currentTarget === e.target) setOver(false)
            },
            onDrop: function (e) {
              e.preventDefault(); setOver(false)
              takeFiles(e.dataTransfer && e.dataTransfer.files)
            },
          },
            h('h3', null, busy ? ('正在上传…还剩 ' + uploading + ' 个') : '把音频文件拖到这里'),
            h('p', null,
              '支持网易云 .ncm、酷我 .kwm，以及 mp3 / flac / m4a / aac / wav / ogg / opus 等常规格式。' +
              '文件会在本机处理，不上传任何服务器。'),
            h('div', { className: 'dac-acts' },
              h('button', { className: 'dac-btn', disabled: busy,
                onClick: function () { if (fileInput.current) fileInput.current.click() } }, '选择文件'),
              h('input', {
                ref: fileInput, type: 'file', multiple: true, style: { display: 'none' },
                accept: (status && status.acceptExts || []).join(','),
                onChange: function (e) { takeFiles(e.target.files); e.target.value = '' },
              }))),

          // ── 待处理列表 ──
          rows.length
            ? h('div', { className: 'dac-sec' },
                h('h3', null, '待处理（' + rows.length + ' 个）'),
                rows.map(function (r) {
                  return h('div', { className: 'dac-job', key: r.path, 'data-status': 'queued' },
                    h('div', { className: 'dac-job-row' },
                      h('span', { className: 'dac-job-name' }, r.name),
                      h('span', { className: 'dac-tag' }, (r.sizeBytes / 1048576).toFixed(2) + ' MB')))
                }))
            : null,

          // ── 设置 ──
          h('div', { className: 'dac-sec' },
            h('h3', null, '转换设置'),
            h('div', { className: 'dac-grid' },
              h('label', { className: 'dac-field' },
                h('span', null, '目标格式'),
                h('select', { className: 'dac-in', value: format, onChange: function (e) { setFormat(e.target.value) } },
                  h('option', { value: '' }, '沿用源格式（只解密）'),
                  fmtList.map(function (f) { return h('option', { key: f, value: f }, f.toUpperCase()) }))),
              h('label', { className: 'dac-field' },
                h('span', null, '质量'),
                h('select', { className: 'dac-in', value: quality, onChange: function (e) { setQuality(e.target.value) } },
                  h('option', { value: 'small' }, '体积优先'),
                  h('option', { value: 'standard' }, '标准'),
                  h('option', { value: 'best' }, '质量优先'))),
              h('label', { className: 'dac-field' },
                h('span', null, '位深（仅无损）'),
                h('select', { className: 'dac-in', value: bitDepth, onChange: function (e) { setBitDepth(e.target.value) } },
                  h('option', { value: '' }, '保持原样'),
                  h('option', { value: '16' }, '16 位'),
                  h('option', { value: '24' }, '24 位'),
                  h('option', { value: '32' }, '32 位'))),
              h('label', { className: 'dac-field' },
                h('span', null, 'QQ音乐 EKey（可选）'),
                h('input', {
                  className: 'dac-in', type: 'text', value: ekey, spellCheck: false,
                  placeholder: '仅 STag / MusicEx 尾包需要',
                  onChange: function (e) { setEkey(e.target.value) },
                })),
              h('label', { className: 'dac-field' },
                h('span', null, '音质增强'),
                h('select', { className: 'dac-in', value: enhance, onChange: function (e) { setEnhance(e.target.value) } },
                  h('option', { value: 'none' }, '不处理'),
                  h('option', { value: 'loudness' }, '响度归一化'),
                  h('option', { value: 'night' }, '夜间（压缩动态）'),
                  h('option', { value: 'warm' }, '暖声 EQ'),
                  h('option', { value: 'bright' }, '明亮 EQ'),
                  h('option', { value: 'vocal' }, '人声突出'),
                  h('option', { value: 'bass' }, '低频增强'),
                  h('option', { value: 'full' }, '全套处理'))),
              h('label', { className: 'dac-field' },
                h('span', null, '标签与封面'),
                h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', paddingTop: '6px' } },
                  h('label', { style: { display: 'flex', gap: '5px', alignItems: 'center', cursor: 'pointer' } },
                    h('input', { type: 'checkbox', checked: writeTags, onChange: function (e) { setWriteTags(e.target.checked) } }),
                    h('span', { style: { fontSize: '12px' } }, '写标签')),
                  h('label', { style: { display: 'flex', gap: '5px', alignItems: 'center', cursor: 'pointer' } },
                    h('input', { type: 'checkbox', checked: embedCover, onChange: function (e) { setEmbedCover(e.target.checked) } }),
                    h('span', { style: { fontSize: '12px' } }, '嵌封面'))))),
            h('div', { className: 'dac-hint' },
              '关于「音质增强」：它改变的是**听感**（响度更一致、动态更可控、频响更合口味），' +
              '但**无法恢复有损编码已经丢掉的信息** —— 128kbps 的 mp3 转成 FLAC 不会变好听。' +
              '输出目录：' + ((status && status.defaultOutDir) || '（读取中）')),
            h('div', { style: { marginTop: '14px' } },
              h('button', {
                className: 'dac-btn',
                disabled: !rows.length || busy || (ff && !ff.ok),
                onClick: submit,
                style: { padding: '8px 20px', borderColor: 'var(--dac-accent)', color: 'var(--dac-accent)', fontWeight: 600 },
              }, '开始转换（' + rows.length + ' 个）'))),

          // ── 任务列表 ──
          h('div', { className: 'dac-sec' },
            h('h3', null, '任务' + (running ? '（' + running + ' 个进行中）' : '')),
            jobs.length === 0
              ? h('div', { className: 'dac-empty' }, '还没有任务。拖文件进来试试。')
              : jobs.map(function (job) {
                  var statusText = {
                    queued: '排队中', running: '处理中', done: '完成', failed: '失败',
                  }[job.status] || job.status
                  return h('div', { className: 'dac-job', key: job.id, 'data-status': job.status },
                    h('div', { className: 'dac-job-row' },
                      h('span', { className: 'dac-job-name' }, job.inputName),
                      h('span', { className: 'dac-tag' }, statusText),
                      job.srcFormat && job.format
                        ? h('span', { className: 'dac-tag' }, job.srcFormat + ' → ' + job.format) : null,
                      job.outSizeBytes
                        ? h('span', { className: 'dac-tag' }, (job.outSizeBytes / 1048576).toFixed(2) + ' MB') : null,
                      job.elapsedMs != null
                        ? h('span', { className: 'dac-tag' }, job.elapsedMs + ' ms') : null),
                    job.status === 'running'
                      ? h('div', { className: 'dac-bar' }, h('i'))
                      : null,
                    job.status === 'done' && job.outputName
                      ? h('div', { className: 'dac-job-msg' }, '→ ' + job.outputName +
                          (job.notes && job.notes.length ? '   ' + job.notes.join(' · ') : ''))
                      : null,
                    job.status === 'failed'
                      ? h('div', { className: 'dac-job-msg' }, job.error || '未知错误')
                      : null)
                }),
            jobs.length
              ? h('div', { style: { marginTop: '10px' } },
                  h('button', { className: 'dac-btn', onClick: clearDone }, '清空已完成'))
              : null),

          // ── 能力矩阵（诚实版） ──
          h('div', { className: 'dac-sec' },
            h('h3', null, '加密格式支持情况'),
            caps.map(function (c) {
              return h('div', { className: 'dac-cap', key: c.ext },
                h('span', { className: 'dac-cap-mark' }, capMark(c.status)),
                h('span', { className: 'dac-cap-platform' }, c.platform),
                h('span', { className: 'dac-cap-note' }, c.ext + ' — ' + c.note))
            }),
            h('div', { className: 'dac-hint' },
              '❌ 的两项不是「还没做」，而是**离线在原理上做不到**：' +
              'QQ 音乐新版把密钥放在服务端、和设备指纹绑定，本地文件里根本没有解密的材料。' +
              '与其假装支持然后吐个坏文件，不如直接说清楚。'))
        ))
    }

    function apply(ctx) {
      var disposers = []
      disposers.push(installStyles())

      // 会话视图页签，order 40 —— 排在「定时任务」（order 30）后面
      disposers.push(ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({
          name: 'conversation.view',
          id: PLUGIN_ID,
          order: 40,
          label: '音频转换',
        }, function (props) { return h(AudioView, props) })
      }))

      return function dispose() {
        for (var i = 0; i < disposers.length; i++) {
          try { disposers[i]() } catch (e) { /* 已拆掉 */ }
        }
      }
    }

    module.exports = {
      name: 'dsh-audio-converter',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
