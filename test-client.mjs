/**
 * 浏览器半边测试
 *
 * stub 掉 window.__ModuleLoader__ / document / React，真执行一遍 client.js，
 * 检查模块协议、slot 注册位置、样式（顺便检查它自己有没有 AI 味）、卸载。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

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

/* ---------------- 桩 ---------------- */
let loadCall = null
const styleTags = []

const windowStub = { __ModuleLoader__: { load(spec) { loadCall = spec } } }
const documentStub = {
  head: { appendChild(el) { styleTags.push(el) } },
  createElement(tag) {
    return {
      tagName: tag, attrs: {}, textContent: '',
      setAttribute(k, v) { this.attrs[k] = v },
      remove() { this.removed = true },
    }
  },
}
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  Fragment: Symbol('Fragment'),
}

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) })

/* ================================================================== *
 * 1. 模块协议
 * ================================================================== */
section('1. 模块协议')
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(windowStub, documentStub)
} catch (error) {
  console.log('  ❌ 源码执行抛错: ' + error.message)
  process.exit(1)
}
check('调用了 window.__ModuleLoader__.load', loadCall !== null)
check('id 是 dsh-audio-converter', loadCall?.id === 'dsh-audio-converter', String(loadCall?.id))
check('factory 是函数', typeof loadCall?.factory === 'function')

const moduleExports = loadCall.factory((n) => {
  if (n === 'react') return reactStub
  throw new Error('客户端不该 require 别的包，但拿到了: ' + n)
})
check('exports.name 正确', moduleExports?.name === 'dsh-audio-converter')
check('exports.inject 声明了 slots', Array.isArray(moduleExports?.inject) && moduleExports.inject.includes('slots'))
check('exports.apply 是函数', typeof moduleExports?.apply === 'function')

/* ================================================================== *
 * 2. slot 注册
 * ================================================================== */
section('2. slot 注册位置')
const registrations = []
let injectCalls = 0
const ctx = {
  slots: {
    inject(name, fn) { injectCalls++; const d = fn(); return typeof d === 'function' ? d : () => {} },
    register(spec, render) { registrations.push({ spec, render }); return () => {} },
  },
}

const dispose = moduleExports.apply(ctx)
check('调用了 1 次 slots.inject', injectCalls === 1, String(injectCalls))
check('注册了 1 个 slot', registrations.length === 1)
check('插入了 1 个 <style>', styleTags.length === 1)
check('style 带 data-dsh-plugin 标记', styleTags[0]?.attrs?.['data-dsh-plugin'] === 'dsh-audio-converter')

const spec = registrations[0]?.spec
// 会话视图页签行的实测占用：
//   chat=0 / trajectory=10 / context=20 / auto-task=30 → 本插件用 40
check('slot 名是 conversation.view', spec?.name === 'conversation.view', String(spec?.name))
check('slot id 是 audio-converter', spec?.id === 'audio-converter', String(spec?.id))
check('order 是 40', spec?.order === 40, String(spec?.order))
check('label 是「音频转换」', spec?.label === '音频转换', String(spec?.label))
check('order 40 > 定时任务 的 order 30 → 排在它后面', spec.order > 30)
check('order 40 > 上下文 的 order 20', spec.order > 20)
check('render 是函数', typeof registrations[0]?.render === 'function')

// 视图组件要能渲染出来
const viewElement = registrations[0].render({})
check('render 返回 React 元素', !!viewElement && typeof viewElement.type === 'function')
const rendered = viewElement.type(viewElement.props)
check('渲染出整页根节点（dac-root）', rendered?.props?.className === 'dac-root',
  String(rendered?.props?.className))

/* ================================================================== *
 * 3. 样式（顺便检查它自己有没有 AI 味）
 * ================================================================== */
section('3. 样式表')
const css = styleTags[0]?.textContent ?? ''
check('声明了 prefers-reduced-motion 守卫', /prefers-reduced-motion/.test(css))
check('用宿主主题变量而不是硬编码颜色', /var\(--dsh-/.test(css))
check('强调色走宿主变量', /--dac-accent:\s*var\(--dsh-accent/.test(css))
check('没有 emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(css))
check('正文限制了行宽（65ch）', /65ch/.test(css))
check('没有遮罩层（是页签视图不是浮层）', !/dac-scrim/.test(css))
// 唯一一处动画是 loading 进度条，且只动 transform（不触发布局）
const keyframes = css.match(/@keyframes[^{]+\{[\s\S]*?\}\s*\}/g) ?? []
check('关键帧动画只动 transform', keyframes.every((k) => !/(width|height|top|left):/.test(k)),
  keyframes.join(' | ').slice(0, 100))
check('进度条用 transform 平移（不触发重排）', /translateX/.test(css))

/* ================================================================== *
 * 4. 源码级检查：界面必须给出诚实的能力说明
 * ================================================================== */
section('4. 诚实性检查（源码级）')
// 这几条是产品要求，不是样式要求：不能让用户以为「什么都能解」
check('界面上写了「无法恢复有损编码已丢失的信息」', /无法恢复有损编码/.test(source))
check('界面上写了「离线在原理上做不到」', /离线在原理上做不到/.test(source))
check('界面上说明了「文件在本机处理，不上传服务器」', /不上传任何服务器/.test(source))
check('界面上提示了 ffmpeg 的安装方式', /winget install Gyan\.FFmpeg/.test(source))
check('界面提供了 EKey 输入框（STag/MusicEx 尾包需要）',
  /QQ音乐 EKey/.test(source) && /setEkey/.test(source) && /ekey: ekey\.trim\(\)/.test(source))

/* ================================================================== *
 * 5. 卸载
 * ================================================================== */
section('5. 卸载')
let threw = null
try { dispose() } catch (e) { threw = e }
check('卸载函数不抛错', threw === null, String(threw))
check('样式标签被移除', styleTags[0]?.removed === true)

section('结果')
console.log(`  通过 ${pass}    失败 ${fail}`)
if (fails.length) fails.forEach((f) => console.log('    ❌ ' + f))
console.log('')
console.log(fail === 0 ? '  ✅ 全部通过' : '  ❌ 有失败项')
process.exit(fail === 0 ? 0 : 1)
