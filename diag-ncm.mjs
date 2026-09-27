import { join } from 'node:path'
import { homedir } from 'node:os'
/**
 * NCM 解密结果诊断
 *
 * 目的：搞清楚「解出来的 MP3 为什么和已知文件不一样」。
 * 不猜，直接量：打印头部字节、定位 MPEG 帧同步、核对 ID3 大小、对比音频载荷。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { decryptNcm } from './lib/crypto/ncm.js'

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)

/** 十六进制 + ASCII 双栏打印 */
function dump(buf, offset, len, label) {
  console.log('  ' + label + '  (offset ' + offset + ')')
  for (let i = 0; i < len; i += 16) {
    const slice = buf.subarray(offset + i, Math.min(offset + i + 16, buf.length))
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    console.log('    ' + String(offset + i).padStart(6) + '  ' + hex.padEnd(47) + '  |' + ascii + '|')
  }
}

/** 解析 ID3v2 头 */
function parseId3(buf) {
  if (buf.subarray(0, 3).toString('ascii') !== 'ID3') return null
  const verMajor = buf[3], verMinor = buf[4], flags = buf[5]
  // synchsafe：每字节只用低 7 位
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  return { ver: `2.${verMajor}.${verMinor}`, flags, size, total: 10 + size }
}

/** 找第一个 MPEG 帧同步：0xFF 后面高 3 位全 1 */
function findMpegSync(buf, from = 0, limit = 200000) {
  const end = Math.min(buf.length - 1, from + limit)
  for (let i = from; i < end; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      // 排除 0xFF 0xFF 这种非法的
      const ver = (buf[i + 1] >> 3) & 0x03
      const layer = (buf[i + 1] >> 1) & 0x03
      if (ver !== 1 && layer !== 0) return i
    }
  }
  return -1
}

/** 找类似帧 ID 的 4 个大写字母 */
function asciiFrames(buf, offset, len) {
  const out = []
  for (let i = offset; i < Math.min(buf.length - 4, offset + len); i++) {
    const s = buf.subarray(i, i + 4).toString('ascii')
    if (/^[A-Z][A-Z0-9]{3}$/.test(s)) out.push(`${i - offset}:${s}`)
  }
  return out
}

const samples = [
  { ncm: process.env.DSH_TEST_NCM_A || 'G:\\CloudMusic\\VipSongsDownload\\The Little Dippers - Forever (Single Version).ncm',
    known: process.env.DSH_TEST_KNOWN_A || join(homedir(), 'Desktop', '转换输出', 'The Little Dippers - Forever (Single Version).mp3') },
  { ncm: process.env.DSH_TEST_NCM_B || 'G:\\CloudMusic\\VipSongsDownload\\The Little Dippers - Forever.ncm',
    known: process.env.DSH_TEST_KNOWN_B || join(homedir(), 'Desktop', '转换输出', 'The Little Dippers - Forever.mp3') },
]

for (const s of samples) {
  console.log('')
  console.log('═'.repeat(74))
  console.log('素材: ' + s.ncm.split('\\').pop())
  console.log('═'.repeat(74))
  if (!existsSync(s.ncm)) { console.log('  源文件不在，跳过'); continue }

  const out = decryptNcm(readFileSync(s.ncm))
  console.log('  解密后: ' + out.audio.length + ' 字节  sha=' + sha(out.audio))
  console.log('  元数据: ' + JSON.stringify(out.meta?.musicName) + '  format=' + out.meta?.format +
    '  duration=' + out.meta?.duration + 'ms  bitrate=' + out.meta?.bitrate)

  const id3 = parseId3(out.audio)
  console.log('  ID3 头: ' + (id3 ? JSON.stringify(id3) : '(没有)'))
  const sync = findMpegSync(out.audio, id3 ? id3.total : 0, 500000)
  console.log('  首个 MPEG 帧同步位置: ' + sync)
  const frames = asciiFrames(out.audio, 10, 120)
  console.log('  ID3 标签里的疑似帧 ID: ' + (frames.join(' ') || '(没有)'))

  dump(out.audio, 0, 64, '解密结果头部')

  if (existsSync(s.known)) {
    const known = readFileSync(s.known)
    console.log('')
    console.log('  ── 已知结果 ──')
    console.log('  大小: ' + known.length + ' 字节  sha=' + sha(known))
    const kid3 = parseId3(known)
    console.log('  ID3 头: ' + (kid3 ? JSON.stringify(kid3) : '(没有)'))
    const ksync = findMpegSync(known, kid3 ? kid3.total : 0, 500000)
    console.log('  首个 MPEG 帧同步位置: ' + ksync)
    const kframes = asciiFrames(known, 10, 120)
    console.log('  ID3 标签里的疑似帧 ID: ' + (kframes.join(' ') || '(没有)'))
    dump(known, 0, 64, '已知结果头部')

    // 长度差
    console.log('')
    console.log('  长度差: ' + (out.audio.length - known.length) + ' 字节')
    // 尝试不同偏移下寻找匹配：把解密结果整体平移，看能否与已知结果对齐
    if (sync >= 0 && ksync >= 0) {
      const a = out.audio.subarray(sync, sync + 4096)
      const b = known.subarray(ksync, ksync + 4096)
      console.log('  去掉 ID3 后的前 4096 字节是否一致: ' +
        (Buffer.compare(a, b) === 0 ? '✅ 一致' : '❌ 不一致'))
      if (Buffer.compare(a, b) !== 0) {
        // 在已知结果里搜解密结果的开头，判断是不是整体偏移
        const needle = out.audio.subarray(sync, sync + 32)
        const at = known.indexOf(needle)
        console.log('  解密结果的帧头在已知结果里的位置: ' + at)
        if (at >= 0) {
          console.log('  → 音频载荷一致，只是 ID3 头不同（位置差 ' + (at - ksync) + ' 字节）')
        } else {
          // 逐字节找第一个差异
          let d = -1
          const n = Math.min(a.length, b.length)
          for (let i = 0; i < n; i++) if (a[i] !== b[i]) { d = i; break }
          console.log('  去 ID3 后首个差异在第 ' + d + ' 字节')
          if (d >= 0) {
            console.log('    解密 ' + a.subarray(Math.max(0, d - 8), d + 16).toString('hex'))
            console.log('    已知 ' + b.subarray(Math.max(0, d - 8), d + 16).toString('hex'))
          }
        }
      }
    }
  }
}
