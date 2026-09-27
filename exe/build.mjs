#!/usr/bin/env node
/**
 * 把音频转换器打成单文件 exe。
 *
 * 三步：
 *   1. esbuild 把 exe/main.mjs（连同整个 lib/）bundle 成一个 CJS
 *   2. node --experimental-sea-config 生成 SEA blob（把 ffmpeg 和酷狗公钥表嵌进去）
 *   3. postject 把 blob 注入一份 node.exe 的副本
 *
 * 只嵌 ffmpeg，**不嵌 ffprobe** —— ffprobe 是另一个约 100 MB 的静态二进制，
 * 而 `probe()` 已经能在没有它时解析 `ffmpeg -i` 的 stderr（有测试盯着）。
 *
 * 用法：
 *   node build.mjs
 *   node build.mjs --keep-temp    保留中间产物（排查用）
 */
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
// 本脚本的位置：<插件根>/exe/build.mjs
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
// 构建工作区（放下载的 ffmpeg、bundle、blob、产物）。
// 默认在插件同级的 ../../工作室/音频转换器exe，可用 DSH_EXE_BUILD_DIR 覆盖。
const WORK = process.env.DSH_EXE_BUILD_DIR || resolve(PLUGIN, '..', '..', '工作室', '音频转换器exe')
const DIST = join(WORK, 'dist')
const TEMP = join(WORK, 'temp')

const KEEP_TEMP = process.argv.includes('--keep-temp')

// ffmpeg 路径：优先环境变量，否则找构建工作区里解压好的 essentials 版
const FFMPEG_SRC = process.env.FFMPEG_SRC ||
  join(WORK, 'download', 'extracted', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe')
const KUGOU_KEY = join(PLUGIN, 'lib', 'crypto', 'assets', 'kugou_key.bin')

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

function log(msg) { console.log('  ' + msg) }
function step(n, msg) { console.log(''); console.log(`── ${n}. ${msg} ${'─'.repeat(Math.max(0, 46 - msg.length))}`) }
function die(msg) { console.error('\n❌ ' + msg + '\n'); process.exit(1) }

function mb(n) { return (n / 1048576).toFixed(1) + ' MB' }

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { windowsHide: true, stdio: 'inherit', ...opts })
    c.on('error', rej)
    c.on('close', (code) => (code === 0 ? res() : rej(new Error(`${basename(cmd)} 退出码 ${code}`))))
  })
}

async function main() {
  console.log('')
  console.log('════════════════════════════════════════════')
  console.log('  打包「音频转换器」为单文件 exe')
  console.log('════════════════════════════════════════════')
  log('插件目录  ' + PLUGIN)
  log('工作目录  ' + WORK)
  log('node      ' + process.execPath)

  /* ── 0. 检查素材 ── */
  step(0, '检查素材')
  if (!existsSync(FFMPEG_SRC)) {
    die('找不到 ffmpeg：' + FFMPEG_SRC +
      '\n   下载 essentials 版并解压，或设 FFMPEG_SRC 环境变量指向 ffmpeg.exe')
  }
  if (!existsSync(KUGOU_KEY)) {
    die('找不到酷狗公钥表：' + KUGOU_KEY +
      '\n   先跑一次：node scripts/expand-kugou-key.mjs')
  }
  const ffSize = statSync(FFMPEG_SRC).size
  const keySize = statSync(KUGOU_KEY).size
  log(`ffmpeg       ${mb(ffSize)}   ${FFMPEG_SRC}`)
  log(`kugou_key    ${mb(keySize)}   ${KUGOU_KEY}`)
  log(`node.exe     ${mb(statSync(process.execPath).size)}`)
  log(`预计 exe 约  ${mb(statSync(process.execPath).size + ffSize + keySize + 2 * 1048576)}`)

  mkdirSync(DIST, { recursive: true })
  mkdirSync(TEMP, { recursive: true })

  /* ── 1. bundle ── */
  step(1, 'esbuild 打包（整个 lib/ 合成一个 CJS）')
  const esbuild = require(join(WORK, 'node_modules', 'esbuild'))
  const bundlePath = join(TEMP, 'bundle.cjs')
  const r = await esbuild.build({
    entryPoints: [join(PLUGIN, 'exe', 'main.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: bundlePath,
    // node: 内建的都别打进来
    external: ['node:*'],
    // SEA 里 __dirname 是 exe 所在目录，但我们的代码用 import.meta.url 推导，
    // 打包后会被 esbuild 换成 CJS 的写法 —— 交给它处理，不额外注入
    banner: { js: '/* dsh-audio-converter 单文件版 —— 由 build.mjs 生成 */' },
    legalComments: 'none',
    minify: false,
  })
  if (r.warnings?.length) r.warnings.forEach((w) => log('⚠️ ' + w.text))
  const bundleSize = statSync(bundlePath).size
  log('✅ bundle 完成  ' + mb(bundleSize) + '   ' + bundlePath)

  /* ── 2. SEA blob ── */
  step(2, '生成 SEA blob（嵌入 ffmpeg + 酷狗公钥表）')
  const seaConfigPath = join(TEMP, 'sea-config.json')
  writeFileSync(seaConfigPath, JSON.stringify({
    main: bundlePath,
    output: join(TEMP, 'sea-prep.blob'),
    assets: {
      ffmpeg: FFMPEG_SRC,
      kugou_key: KUGOU_KEY,
    },
    disableExperimentalSEAWarning: true,
  }, null, 2))

  await run(process.execPath, ['--experimental-sea-config', seaConfigPath])
  const blobPath = join(TEMP, 'sea-prep.blob')
  if (!existsSync(blobPath)) die('blob 没生成')
  log('✅ blob 生成  ' + mb(statSync(blobPath).size))
  log('   注意：blob 会比资源总和略小，因为 Node 会压缩')

  /* ── 3. 复制 node.exe ── */
  step(3, '复制 node.exe 作为宿主')
  const outExe = join(DIST, '音频转换器.exe')
  rmSync(outExe, { force: true })
  copyFileSync(process.execPath, outExe)
  log('✅ ' + mb(statSync(outExe).size) + '   ' + outExe)

  /* ── 4. postject 注入 ── */
  step(4, '注入 blob（postject）')
  const postjectCli = join(WORK, 'node_modules', 'postject', 'dist', 'cli.js')
  if (!existsSync(postjectCli)) die('找不到 postject：' + postjectCli)
  await run(process.execPath, [
    postjectCli, outExe, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', SEA_FUSE,
  ])
  const finalSize = statSync(outExe).size
  log('✅ 注入完成  最终 ' + mb(finalSize))

  /* ── 5. 自检 ── */
  step(5, '自检（跑一次 --help）')
  await new Promise((res) => {
    const c = spawn(outExe, ['--help'], { windowsHide: true })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { out += d })
    c.on('close', (code) => {
      if (code === 0 && /音频转换器/.test(out)) {
        log('✅ exe 能跑起来')
        out.split('\n').filter(Boolean).slice(0, 3).forEach((l) => log('   ' + l))
      } else {
        log('❌ exe 自检失败（退出码 ' + code + '）')
        out.split('\n').slice(0, 12).forEach((l) => log('   ' + l))
      }
      res()
    })
  })

  /* ── 清理 ── */
  if (!KEEP_TEMP) {
    step(6, '清理中间产物')
    try { rmSync(TEMP, { recursive: true, force: true }) } catch { /* 忽略 */ }
    log('✅ 已清理（--keep-temp 可保留）')
  }

  console.log('')
  console.log('════════════════════════════════════════════')
  console.log('  完成')
  console.log('════════════════════════════════════════════')
  console.log('  ' + outExe)
  console.log('  ' + mb(finalSize))
  console.log('')
  console.log('  拖文件上去 = 直接转成 mp3')
  console.log('  双击       = 打开设置界面')
  console.log('')
}

main().catch((e) => die(e?.stack || String(e)))
