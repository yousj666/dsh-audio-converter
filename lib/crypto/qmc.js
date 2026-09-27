// QQ 音乐 QMC 解密器
//
// 这个格式有好几代，**必须分清**，否则会出现"看起来支持、实际解出垃圾"：
//
//   v1  老格式：.tkm / .bkcmp3 / .bkcm4a / .bkcflac / 十六进制扩展名
//       算法：128 字节**公开静态密钥**，按偏移循环异或
//       状态：✅ 本文件实现
//
//   v2  中期格式：.qmcflac / .qmcogg / .qmc0/.qmc2/.qmc3 / .mflac / .mgg
//       算法：文件尾部带 EKey → TEA 派生主密钥 → Map 或分段 RC4 流
//       状态：🔨 算法已知（TEA + Map/RC4 流），尚未实现
//
//   v3  新版：.mgg1 / .mgg2 / .mmp4 / 带 STag/QTag 标记
//       算法：**动态密钥分发 + 设备指纹绑定**，密钥在服务端
//       状态：❌ 离线在原理上无解
//
// v1 的边界规则（容易写错的地方）
//   绝对偏移 <= 0x7FFF 时，密钥索引 = 偏移 % 128。
//   超过 0x7FFF 后，先把偏移对 0x7FFF 取模，再 % 128。
//   **不是简单的 % 128** —— 直接循环异或整段会从 0x8000 起全错。
//
// 参考：HRuiCcc/music-geshizhuanhuan 的 qmc.py / ciphers.py（MIT），
//       以及 unlock-music 公开的 v1 静态密钥
//
// @module dsh-audio-converter/crypto/qmc
'use strict'

import { sniffAudioFormat } from './ncm.js'

/** 公开的 v1 静态密钥（128 字节） */
export const V1_STATIC_KEY = new Uint8Array([
  0xC3, 0x4A, 0xD6, 0xCA, 0x90, 0x67, 0xF7, 0x52, 0xD8, 0xA1, 0x66, 0x62, 0x9F, 0x5B, 0x09, 0x00,
  0xC3, 0x5E, 0x95, 0x23, 0x9F, 0x13, 0x11, 0x7E, 0xD8, 0x92, 0x3F, 0xBC, 0x90, 0xBB, 0x74, 0x0E,
  0xC3, 0x47, 0x74, 0x3D, 0x90, 0xAA, 0x3F, 0x51, 0xD8, 0xF4, 0x11, 0x84, 0x9F, 0xDE, 0x95, 0x1D,
  0xC3, 0xC6, 0x09, 0xD5, 0x9F, 0xFA, 0x66, 0xF9, 0xD8, 0xF0, 0xF7, 0xA0, 0x90, 0xA1, 0xD6, 0xF3,
  0xC3, 0xF3, 0xD6, 0xA1, 0x90, 0xA0, 0xF7, 0xF0, 0xD8, 0xF9, 0x66, 0xFA, 0x9F, 0xD5, 0x09, 0xC6,
  0xC3, 0x1D, 0x95, 0xDE, 0x9F, 0x84, 0x11, 0xF4, 0xD8, 0x51, 0x3F, 0xAA, 0x90, 0x3D, 0x74, 0x47,
  0xC3, 0x0E, 0x74, 0xBB, 0x90, 0xBC, 0x3F, 0x92, 0xD8, 0x7E, 0x11, 0x13, 0x9F, 0x23, 0x95, 0x5E,
  0xC3, 0x00, 0x09, 0x5B, 0x9F, 0x62, 0x66, 0xA1, 0xD8, 0x52, 0xF7, 0x67, 0x90, 0xCA, 0xD6, 0x4A,
])

/** v1 的偏移边界 */
const BOUNDARY = 0x7fff
const KEY128 = 128

/** v1 的扩展名（十六进制那几个是「把扩展名写成 hex」的老把戏） */
const V1_EXTS = new Set([
  '.tkm', '.bkcmp3', '.bkcm4a', '.bkcflac', '.bkcwav', '.bkcape', '.bkcogg', '.bkcwma',
  '.666c6163', '.6d7033', '.6f6767', '.6d3461', '.776176',
])

/** v2 的扩展名 */
const V2_EXTS = new Set([
  '.mflac', '.mflac0', '.mgg', '.mgg0', '.mgg1', '.mggl', '.mmp4',
  '.qmcflac', '.qmcogg', '.qmc0', '.qmc2', '.qmc3', '.qmc4', '.qmc6', '.qmc8',
])

/** v2 文件尾部的标记（STag/QTag 是更新一代，说明拿不到离线密钥） */
const NEW_GEN_MARKERS = ['STag', 'QTag', 'musicex']
/** v2 尾部 EKey 包的标记 */
const EKEY_MARKERS = ['QTag', 'STag']

/**
 * 按 QMC v1 规则变换整段数据（异或自反，加密解密同一个函数）。
 *
 * @param {Uint8Array} data 数据
 * @param {Uint8Array} key 128 字节密钥
 * @param {number} [offsetStart] 这段数据在整段音频里的起始偏移
 * @returns {Buffer} 变换后的数据
 */
export function qmc1Transform(data, key, offsetStart = 0) {
  const out = Buffer.from(data)
  const total = out.length
  let pos = offsetStart
  let i = 0
  while (i < total) {
    let take
    let phase
    if (pos <= BOUNDARY) {
      take = Math.min(BOUNDARY + 1 - pos, total - i)
      phase = pos % KEY128
    } else {
      const r = pos % BOUNDARY
      take = Math.min(BOUNDARY - r, total - i)
      phase = r % KEY128
    }
    // out[i + k] ^= key[(phase + k) % 128]
    for (let k = 0; k < take; k++) {
      out[i + k] ^= key[(phase + k) % KEY128]
    }
    i += take
    pos += take
  }
  return out
}

/**
 * 判断一个文件的 QMC 世代。
 *
 * **先看内容再看后缀** —— 后缀在实际文件里经常被改。
 *
 * @param {Buffer} buf 文件内容
 * @param {string} filename 原始文件名
 * @returns {{gen: 'v1'|'v2'|'v3'|null, reason: string}}
 */
export function detectQmcGeneration(buf, filename = '') {
  const ext = (filename.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()

  // 1) 新版标记：直接看尾部/头部有没有 STag/QTag/musicex
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1')
  const tailStart = Math.max(0, buf.length - 4096)
  const tail = buf.subarray(tailStart).toString('latin1')
  for (const marker of NEW_GEN_MARKERS) {
    if (tail.includes(marker) || head.includes(marker)) {
      // STag/QTag 既可能是 v2 的 ekey 包标记，也可能是新一代
      // 用「尾部有没有可解析的 ekey 包」来区分 —— 这里先按 ekey 存在与否粗判
      if (tail.includes('QTag') && tail.includes('EKey')) {
        return { gen: 'v2', reason: '尾部有 QTag + EKey 包（v2）' }
      }
      return { gen: 'v3', reason: `文件里出现 ${marker} 标记（新版加密）` }
    }
  }

  // 2) 后缀判定
  if (V1_EXTS.has(ext)) return { gen: 'v1', reason: `后缀 ${ext} 属于 v1` }
  if (V2_EXTS.has(ext)) {
    // qmc0/qmc2/qmc3 这些早期后缀有可能是 v1（那时还没有 ekey）
    if (['.qmc0', '.qmc2', '.qmc3', '.qmc4', '.qmc6', '.qmc8', '.qmcflac', '.qmcogg'].includes(ext)) {
      return { gen: 'v2', reason: `后缀 ${ext} 属于 v2 家族（尾部可能有 EKey）` }
    }
    return { gen: 'v2', reason: `后缀 ${ext} 属于 v2` }
  }

  return { gen: null, reason: '看不出是 QMC' }
}

/**
 * 解密一个 QMC v1 文件。
 *
 * v1 没有文件头也没有校验，所以**解完必须靠内容验证**：
 * 解出来得是能认出的音频容器，否则宁可报错也不吐垃圾。
 *
 * @param {Buffer} buf 文件内容
 * @param {{verify?: boolean}} [opts] verify=false 可跳过容器校验（调试用）
 * @returns {{audio: Buffer, format: string|null}}
 */
export function decryptQmcV1(buf, opts = {}) {
  const audio = qmc1Transform(buf, V1_STATIC_KEY, 0)
  const format = sniffAudioFormat(audio.subarray(0, 64))
  if (!format && opts.verify !== false) {
    throw new Error(
      'QMC v1 解密后认不出音频容器。可能原因：\n' +
      '  · 这其实是 v2（尾部带 EKey），v1 静态密钥解不开 → 需要 v2 支持\n' +
      '  · 或者是新版加密（v3），离线无解\n' +
      '  · 或者文件本身不是 QMC')
  }
  return { audio, format }
}

export const QMC_CONSTANTS = { BOUNDARY, KEY128, V1_EXTS, V2_EXTS }
