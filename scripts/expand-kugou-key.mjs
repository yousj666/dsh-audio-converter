#!/usr/bin/env node
/**
 * 从 assets/kugou_key.xz 生成完整的酷狗公钥表（kugou_key.bin）。
 *
 * 为什么需要它
 *   公钥表每 1 字节覆盖 16 字节音频。随包发布的是**截断版**（8 MB，覆盖 128 MB 音频），
 *   因为完整版解压后 69.77 MB（覆盖 1.1 GB），对插件包来说太重。
 *   要处理超过 128 MB 的单个文件时，跑这个脚本生成完整版。
 *
 * Node 没有内置 xz 解压，所以按可用性依次尝试外部工具。
 *
 * 用法：
 *   node scripts/expand-kugou-key.mjs            # 生成完整表
 *   node scripts/expand-kugou-key.mjs --size 16  # 只生成前 16 MB（覆盖 256 MB 音频）
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, '..', 'lib', 'crypto', 'assets')
const SRC = join(ASSETS, 'kugou_key.xz')
const DST = join(ASSETS, 'kugou_key.bin')

/** 目标大小（MB）。不指定则生成完整表。 */
const sizeArgIdx = process.argv.indexOf('--size')
const targetMB = sizeArgIdx >= 0 ? Number(process.argv[sizeArgIdx + 1]) : null

/** 已知的 Python 位置（DSH 桌面版自带） */
function pythonCandidates() {
  return [
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python3',
    'python',
  ]
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(cmd, args, { windowsHide: true, ...opts }) } catch (e) {
      resolve({ code: -1, err: String(e?.message ?? e) }); return
    }
    let out = ''
    let err = ''
    child.stdout?.on('data', (c) => { out += c })
    child.stderr?.on('data', (c) => { err += c })
    child.on('error', (e) => resolve({ code: -1, err: String(e?.message ?? e) }))
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }))
  })
}

async function main() {
  if (!existsSync(SRC)) {
    console.error('找不到 ' + SRC)
    process.exit(1)
  }
  const srcSize = statSync(SRC).size
  console.log('源文件  ' + SRC + '  (' + (srcSize / 1024).toFixed(1) + ' KB)')
  console.log('目标    ' + DST + (targetMB ? `  前 ${targetMB} MB` : '  完整表'))
  console.log('')

  const attempts = []

  // 1) Python 的 lzma（最可靠，DSH 自带）
  const limitExpr = targetMB ? `f.read(${targetMB} * 1024 * 1024)` : 'f.read()'
  const pyScript = `import lzma,sys\nf=lzma.open(r"${SRC}","rb")\ndata=${limitExpr}\nf.close()\nopen(r"${DST}","wb").write(data)\nprint(len(data))`
  for (const py of pythonCandidates()) {
    attempts.push({
      name: 'python lzma (' + py + ')',
      run: () => run(py, ['-c', pyScript]),
    })
  }

  // 2) xz -dc
  attempts.push({
    name: 'xz -dc',
    run: async () => {
      const tmp = join(tmpdir(), 'kugou_full.bin')
      const r = await run('xz', ['-dc', SRC], { stdio: ['ignore', 'pipe', 'pipe'] })
      if (r.code === 0 && r.out) {
        const buf = targetMB ? r.out.slice(0, targetMB * 1024 * 1024) : r.out
        writeFileSync(DST, Buffer.from(buf, 'binary'))
        return { code: 0 }
      }
      return r
    },
  })

  // 3) 7-Zip
  for (const z of ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe', '7z']) {
    attempts.push({
      name: '7z (' + z + ')',
      run: async () => {
        const tmp = join(tmpdir(), 'kugou_7z.bin')
        const r = await run(z, ['x', '-y', '-o' + tmpdir(), SRC])
        if (r.code === 0) {
          const produced = join(tmpdir(), 'kugou_key')
          if (existsSync(produced)) {
            const buf = readFileSync(produced)
            writeFileSync(DST, targetMB ? buf.subarray(0, targetMB * 1024 * 1024) : buf)
            try { unlinkSync(produced) } catch { /* 忽略 */ }
            return { code: 0 }
          }
        }
        return r
      },
    })
  }

  for (const a of attempts) {
    process.stdout.write('尝试 ' + a.name + ' … ')
    const r = await a.run()
    if (r.code === 0 && existsSync(DST)) {
      const size = statSync(DST).size
      console.log('✅')
      console.log('')
      console.log('生成成功：' + DST)
      console.log('  大小 ' + (size / 1048576).toFixed(2) + ' MB，可覆盖 ' + (size * 16 / 1048576).toFixed(0) + ' MB 音频')
      process.exit(0)
    }
    console.log('✗')
  }

  console.log('')
  console.error('所有解压方式都失败了。可以手工执行其一：')
  console.error('  xz -dc "' + SRC + '" > "' + DST + '"')
  console.error('  python -c "import lzma;open(r\\"' + DST + '\\",\\"wb\\").write(lzma.open(r\\"' + SRC + '\\",\\"rb\\").read())"')
  process.exit(1)
}

main()
