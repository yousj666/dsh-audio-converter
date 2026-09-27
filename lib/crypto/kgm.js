// 酷狗音乐 .kgm / .kgma / .vpr 解密器
//
// 文件结构
//   0      16   magic：KGM 或 VPR（见下表）
//   0x10   4    音频数据起始偏移（小端）
//   0x14   4    加密版本（小端）。== 5 是 KGG，需要客户端密钥库 → 无法离线
//   0x1C   16   crypto_test：自检密钥材料，直接当私钥用
//   1024   余   音频数据
//
// 音频解密（按 16 字节一块）
//   own_key = crypto_test + 0x00          → 17 字节私钥
//   pub_key = 酷狗公钥表（每块 1 字节）    → 见 assets/kugou_key.bin
//
//   phase     = 块序号 % 17
//   pub_value = pub_key[块序号]
//   第 col 列（0..15）：
//     own_idx = (phase*16 + col) % 17
//     pub_idx = (phase*16 + col) % 272
//     明文 = scramble(密文 ^ own_key[own_idx]) ^ scramble(pub_value ^ MEND_TABLE[pub_idx])
//
//   scramble(v) = v ^ ((v & 0x0F) << 4)        ← 公开的字节变换
//
// 参考：HRuiCcc/music-geshizhuanhuan 的 kgm.py（MIT）+ unlock-music 的公开常量
//
// @module dsh-audio-converter/crypto/kgm
'use strict'

import { dirname, join } from 'node:path'
import { sniffAudioFormat } from './ncm.js'
import { readKugouKey, hasKugouKey, kugouKeyPath, HERE } from '../resources.js'

// HERE 从 resources.js 拿（exe 打包后 import.meta 不可用）

/** 两种 magic */
export const KGM_MAGIC = Buffer.from([0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b, 0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14])
export const VPR_MAGIC = Buffer.from([0x05, 0x28, 0xbc, 0x96, 0xe9, 0xe4, 0x5a, 0x43, 0x91, 0xaa, 0xbd, 0xd0, 0x7a, 0xf5, 0x36, 0x31])

const HEADER_LEN = 1024
const OWN_KEY_LEN = 17
const BLOCK = 16
/** 相位周期（与私钥长度一致） */
const PHASE_PERIOD = 17

/** 公开的 MEND 表（272 字节常量） */
export const MEND_TABLE = new Uint8Array([
  0xB8, 0xD5, 0x3D, 0xB2, 0xE9, 0xAF, 0x78, 0x8C, 0x83, 0x33, 0x71, 0x51, 0x76, 0xA0, 0xCD, 0x37,
  0x2F, 0x3E, 0x35, 0x8D, 0xA9, 0xBE, 0x98, 0xB7, 0xE7, 0x8C, 0x22, 0xCE, 0x5A, 0x61, 0xDF, 0x68,
  0x69, 0x89, 0xFE, 0xA5, 0xB6, 0xDE, 0xA9, 0x77, 0xFC, 0xC8, 0xBD, 0xBD, 0xE5, 0x6D, 0x3E, 0x5A,
  0x36, 0xEF, 0x69, 0x4E, 0xBE, 0xE1, 0xE9, 0x66, 0x1C, 0xF3, 0xD9, 0x02, 0xB6, 0xF2, 0x12, 0x9B,
  0x44, 0xD0, 0x6F, 0xB9, 0x35, 0x89, 0xB6, 0x46, 0x6D, 0x73, 0x82, 0x06, 0x69, 0xC1, 0xED, 0xD7,
  0x85, 0xC2, 0x30, 0xDF, 0xA2, 0x62, 0xBE, 0x79, 0x2D, 0x62, 0x62, 0x3D, 0x0D, 0x7E, 0xBE, 0x48,
  0x89, 0x23, 0x02, 0xA0, 0xE4, 0xD5, 0x75, 0x51, 0x32, 0x02, 0x53, 0xFD, 0x16, 0x3A, 0x21, 0x3B,
  0x16, 0x0F, 0xC3, 0xB2, 0xBB, 0xB3, 0xE2, 0xBA, 0x3A, 0x3D, 0x13, 0xEC, 0xF6, 0x01, 0x45, 0x84,
  0xA5, 0x70, 0x0F, 0x93, 0x49, 0x0C, 0x64, 0xCD, 0x31, 0xD5, 0xCC, 0x4C, 0x07, 0x01, 0x9E, 0x00,
  0x1A, 0x23, 0x90, 0xBF, 0x88, 0x1E, 0x3B, 0xAB, 0xA6, 0x3E, 0xC4, 0x73, 0x47, 0x10, 0x7E, 0x3B,
  0x5E, 0xBC, 0xE3, 0x00, 0x84, 0xFF, 0x09, 0xD4, 0xE0, 0x89, 0x0F, 0x5B, 0x58, 0x70, 0x4F, 0xFB,
  0x65, 0xD8, 0x5C, 0x53, 0x1B, 0xD3, 0xC8, 0xC6, 0xBF, 0xEF, 0x98, 0xB0, 0x50, 0x4F, 0x0F, 0xEA,
  0xE5, 0x83, 0x58, 0x8C, 0x28, 0x2C, 0x84, 0x67, 0xCD, 0xD0, 0x9E, 0x47, 0xDB, 0x27, 0x50, 0xCA,
  0xF4, 0x63, 0x63, 0xE8, 0x97, 0x7F, 0x1B, 0x4B, 0x0C, 0xC2, 0xC1, 0x21, 0x4C, 0xCC, 0x58, 0xF5,
  0x94, 0x52, 0xA3, 0xF3, 0xD3, 0xE0, 0x68, 0xF4, 0x00, 0x23, 0xF3, 0x5E, 0x0A, 0x7B, 0x93, 0xDD,
  0xAB, 0x12, 0xB2, 0x13, 0xE8, 0x84, 0xD7, 0xA7, 0x9F, 0x0F, 0x32, 0x4C, 0x55, 0x1D, 0x04, 0x36,
  0x52, 0xDC, 0x03, 0xF3, 0xF9, 0x4E, 0x42, 0xE9, 0x3D, 0x61, 0xEF, 0x7C, 0xB6, 0xB3, 0x93, 0x50,
])

/** 公开的字节变换 */
export function scramble(value) {
  return (value ^ ((value & 0x0f) << 4)) & 0xff
}

/** 公钥表路径与缓存 */
// 公钥表路径统一由 resources.js 提供（它会正确处理 exe 模式的基准目录）
const KEY_BIN = kugouKeyPath()
const KEY_XZ = join(dirname(kugouKeyPath()), 'kugou_key.xz')
let cachedPubKey = null

/**
 * 载入酷狗公钥表。
 *
 * 每 1 字节覆盖 16 字节音频，所以 8 MB 的表能覆盖 128 MB 音频 —— 远超任何单曲。
 * 完整的表解压后 69.77 MB（覆盖 1.1 GB），首发不带；需要时用
 * `scripts/expand-kugou-key.mjs` 从同目录的 .xz 重新生成完整版。
 *
 * @returns {Uint8Array} 公钥表
 */
export function loadKugouKey() {
  if (cachedPubKey) return cachedPubKey
  if (!hasKugouKey()) {
    throw new Error(
      `缺少酷狗公钥表：${kugouKeyPath()}\n` +
      `这个文件是从 assets/kugou_key.xz 解压出来的（8 MB，覆盖 128 MB 音频）。\n` +
      `重新生成：node scripts/expand-kugou-key.mjs`)
  }
  cachedPubKey = readKugouKey()
  return cachedPubKey
}

/** 这个 buffer 是不是 KGM / VPR。 */
export function isKgm(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN + 16) return false
  const head = buf.subarray(0, 16)
  return head.equals(KGM_MAGIC) || head.equals(VPR_MAGIC)
}

/**
 * 建一条「相位 + 列 → (own_idx, pub_idx)」的索引表。
 *
 * 这两个下标只跟 (phase, col) 有关，与块号无关，所以预先算好，
 * 避免每字节做两次取模（解密 50 MB 就是 3 亿次，省下来很值）。
 */
const PHASE_INDEX = (() => {
  const ownIdx = new Uint8Array(PHASE_PERIOD * BLOCK)
  const pubIdx = new Uint16Array(PHASE_PERIOD * BLOCK)
  for (let phase = 0; phase < PHASE_PERIOD; phase++) {
    for (let col = 0; col < BLOCK; col++) {
      const n = phase * BLOCK + col
      ownIdx[phase * BLOCK + col] = n % OWN_KEY_LEN
      pubIdx[phase * BLOCK + col] = n % MEND_TABLE.length
    }
  }
  return { ownIdx, pubIdx }
})()

/**
 * 解密一个 KGM / VPR 文件。
 * @param {Buffer} buf 完整文件内容
 * @param {{pubKey?: Uint8Array}} [opts]
 * @returns {{audio: Buffer, format: string|null, cryptoVersion: number, audioOffset: number}}
 */
export function decryptKgm(buf, opts = {}) {
  if (!isKgm(buf)) throw new Error('不是 KGM/VPR 文件（magic 不匹配）')

  const header = buf.subarray(0, HEADER_LEN)
  const audioOffset = header.readUInt32LE(0x10)
  const cryptoVersion = header.readUInt32LE(0x14)

  if (cryptoVersion === 5) {
    throw new Error('这是 KGG（加密版本 5）：密钥存在酷狗客户端的密钥库里，本地文件不含解密材料，离线无法解密')
  }
  if (audioOffset < HEADER_LEN || audioOffset >= buf.length) {
    throw new Error(`音频起始偏移异常：${audioOffset}（文件 ${buf.length} 字节）`)
  }

  // 私钥：自检材料 16 字节 + 一个 0x00
  const cryptoTest = header.subarray(0x1c, 0x2c)
  const ownKey = new Uint8Array(OWN_KEY_LEN)
  ownKey.set(cryptoTest, 0)
  ownKey[OWN_KEY_LEN - 1] = 0

  const pubKey = opts.pubKey ?? loadKugouKey()
  const audio = buf.subarray(audioOffset)
  const out = Buffer.allocUnsafe(audio.length)

  const blockCount = Math.ceil(audio.length / BLOCK)
  if (blockCount > pubKey.length) {
    throw new Error(
      `公钥表不够用：需要 ${blockCount} 字节，现有 ${pubKey.length} 字节` +
      `（只覆盖 ${(pubKey.length * BLOCK / 1048576).toFixed(0)} MB 音频）。` +
      `用 scripts/expand-kugou-key.mjs 生成完整表（69.77 MB，覆盖 1.1 GB）`)
  }

  const { ownIdx, pubIdx } = PHASE_INDEX
  const xormask = new Uint8Array(BLOCK)

  for (let blockIdx = 0; blockIdx < blockCount; blockIdx++) {
    const phase = blockIdx % PHASE_PERIOD
    const pubValue = pubKey[blockIdx]
    const base = phase * BLOCK
    // 这一块 16 列各自的公钥掩码
    for (let col = 0; col < BLOCK; col++) {
      xormask[col] = scramble(pubValue ^ MEND_TABLE[pubIdx[base + col]])
    }
    const start = blockIdx * BLOCK
    const end = Math.min(start + BLOCK, audio.length)
    for (let off = start; off < end; off++) {
      const col = off - start
      out[off] = scramble(audio[off] ^ ownKey[ownIdx[base + col]]) ^ xormask[col]
    }
  }

  return {
    audio: out,
    format: sniffAudioFormat(out.subarray(0, 64)),
    cryptoVersion,
    audioOffset,
  }
}

export const KGM_CONSTANTS = { HEADER_LEN, OWN_KEY_LEN, BLOCK, PHASE_PERIOD, KEY_BIN, KEY_XZ }
