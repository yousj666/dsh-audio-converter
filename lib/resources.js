// 运行时资源解析
//
// 同一份代码要跑在两种环境里：
//   1. 普通模式（作为 DSH 插件 / 直接 node 跑）—— 资源是磁盘上的文件
//   2. 单文件 exe（Node SEA）—— 资源内嵌在 exe 里，用 sea.getAsset() 取
//
// 打包 exe 时只嵌 ffmpeg 一个（ffprobe 是另一个约 100 MB 的静态二进制，
// 不嵌它，`probe()` 会走 ffmpeg stderr 回退）。所以：
//   · ffmpeg            —— 内嵌，首次用到时解压到用户目录缓存
//   · kugou_key.bin     —— 内嵌，直接读进内存（8 MB）
//
// @module dsh-audio-converter/resources
'use strict'

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 推导本模块所在目录。
 *
 * 难点：这份代码要跑在三种形态里
 *   1. ESM 源码（DSH 插件 / node 直接跑）—— `import.meta.url` 可用
 *   2. CJS bundle（esbuild 打包成 exe 用）—— **esbuild 会把 `import.meta` 清成空对象**，
 *      此时要用 CJS 的 `__dirname`
 *   3. SEA（单文件 exe）—— 资源都在 exe 里，这个路径基本用不上，给个兜底即可
 *
 * 直接写 `fileURLToPath(import.meta.url)` 会在形态 2 里炸：
 *   TypeError: The "path" argument must be of type string... Received undefined
 */
function computeHere() {
  try {
    const u = import.meta && import.meta.url
    if (typeof u === 'string' && u) return dirname(fileURLToPath(u))
  } catch { /* CJS 打包后 import.meta 是空对象，走下面 */ }
  try {
    // eslint-disable-next-line no-undef
    if (typeof __dirname === 'string' && __dirname) return __dirname
  } catch { /* 忽略 */ }
  return process.cwd()
}

/** 本模块所在目录。普通模式下资源就在附近；exe 模式下走内嵌资源。 */
export const HERE = computeHere()

// process.getBuiltinModule 是 Node 22.3+ 的同步内建模块获取方式。
// 用它而不是 await import()，是为了不让这一层变成异步 —— 打包后调用点太多。
const builtinSea = typeof process.getBuiltinModule === 'function'
  ? process.getBuiltinModule('node:sea')
  : null

/** 当前是不是跑在 SEA（单文件 exe）里。 */
export function isSea() {
  try { return !!(builtinSea && builtinSea.isSea && builtinSea.isSea()) } catch { return false }
}

/**
 * 运行时缓存目录。exe 模式下内嵌的 ffmpeg 会解压到这里。
 * 可以用 DSH_AUDIO_HOME 覆盖。
 */
export function runtimeDir() {
  const base = process.env.DSH_AUDIO_HOME || join(homedir(), '.dsh', 'audio-converter')
  return join(base, 'runtime')
}

/**
 * 取一个内嵌资源（exe 模式）或磁盘文件（普通模式）。
 *
 * @param {string} assetName SEA 里注册的资源名
 * @param {string} diskPath 普通模式下的磁盘路径
 * @returns {Buffer}
 */
export function readResource(assetName, diskPath) {
  if (isSea()) {
    const ab = builtinSea.getAsset(assetName)
    if (!ab) throw new Error(`内嵌资源缺失：${assetName}`)
    return Buffer.from(ab)
  }
  return readFileSync(diskPath)
}

/** 这个资源在当前环境下可不可用。 */
export function hasResource(assetName, diskPath) {
  if (isSea()) {
    try { return !!builtinSea.getAsset(assetName) } catch { return false }
  }
  return existsSync(diskPath)
}

/* ------------------------------------------------------------------ *
 * ffmpeg
 * ------------------------------------------------------------------ */

/** exe 模式下从内嵌资源解出来的 ffmpeg 路径（进程内缓存） */
let extractedFfmpeg = null

/**
 * exe 模式下把内嵌的 ffmpeg 解压出来，返回路径。普通模式返回 null。
 *
 * 解压到 `runtimeDir()`，第二次启动直接复用（校验文件大小，防半截文件）。
 *
 * @returns {string|null}
 */
export function extractEmbeddedFfmpeg() {
  if (!isSea()) return null
  if (extractedFfmpeg && existsSync(extractedFfmpeg)) return extractedFfmpeg

  const dir = runtimeDir()
  const target = join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  try {
    // 已经解过、大小正常就直接用
    if (existsSync(target) && statSync(target).size > 1024 * 1024) {
      extractedFfmpeg = target
      return target
    }
    mkdirSync(dir, { recursive: true })
    const buf = readResource('ffmpeg', join(HERE, 'ffmpeg'))
    // 先写临时文件再改名，避免多个进程同时解压时读到半截文件
    const tmp = target + '.tmp-' + process.pid
    writeFileSync(tmp, buf)
    try { writeFileSync(target, readFileSync(tmp)) } catch { /* 忽略 */ }
    try { require('node:fs').unlinkSync(tmp) } catch { /* 忽略 */ }
    extractedFfmpeg = target
    return target
  } catch (error) {
    // 解压失败不该直接崩 —— 让上层继续去 PATH 里找
    console.error('[dsh-audio-converter] 解压内嵌 ffmpeg 失败：' + (error?.message ?? error))
    return null
  }
}

/** 酷狗公钥表在磁盘上的路径 */
export function kugouKeyPath() {
  return join(HERE, 'crypto', 'assets', 'kugou_key.bin')
}

/** 读酷狗公钥表（内嵌或磁盘） */
export function readKugouKey() {
  return new Uint8Array(readResource('kugou_key', kugouKeyPath()))
}

/** 公钥表可不可用 */
export function hasKugouKey() {
  return hasResource('kugou_key', kugouKeyPath())
}
