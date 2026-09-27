# 第三方参考与声明

本项目的**代码全部为独立实现**，没有直接复制任何第三方代码。
下面列出的是算法层面的参考资料，以及关于随包数据的说明。

---

## 解密算法的参考资料

各加密格式的算法细节来自公开的技术分析文章和 MIT 协议的开源项目。
每个源文件头部都注明了具体出处。

| 格式 | 参考来源 |
|---|---|
| 网易云 NCM | manalogues《NCM文件的加解密笔记》(CC BY 4.0)；博客园 chuyaoxin《网易云音乐 ncm 格式分析》 |
| 酷我 KWM / 酷狗 KGM / QQ音乐 QMC | [HRuiCcc/music-geshizhuanhuan](https://github.com/HRuiCcc/music-geshizhuanhuan) (MIT) —— 用于**对照算法与常量表**，代码为本项目独立实现 |
| QMC v1 静态密钥 | unlock-music 项目公开的常量（该上游已因 DMCA 下架，仅保留算法事实） |

**验证方式**：本项目的 KGM / QMC 测试用一份**独立写的 Python 参考实现**算出黄金值，
硬编码进 JS 测试做跨语言对拍（见 `test-kgm-qmc.mjs` / `test-qmc2.mjs`）。
这样能证明实现与公开规范一致，而不是「自己和自己对得上」。

---

## 关于 `lib/crypto/assets/kugou_key.bin`

**这是什么**：酷狗音乐 KGM 格式解密所需的公钥表（每 1 字节对应 16 字节音频）。
没有它就无法解密 `.kgm` 文件。

**来源**：从 [HRuiCcc/music-geshizhuanhuan](https://github.com/HRuiCcc/music-geshizhuanhuan)
的 `assets/kugou_key.xz` 解压而来。

**性质说明**：这是一张**公开的技术常量表**，不是从酷狗客户端提取的私密数据。
多个开源解密项目都包含同一份数据。它**不含**任何账号、设备或用户信息。

**随包发布的是截断版**：完整表解压后 69.77 MB（覆盖约 1.1 GB 音频），
随包的是前 8 MB（覆盖 128 MB 音频）。需要完整版请跑：

```bash
npm run expand-kugou-key
```

**如果你认为这份数据不应被分发**，可以删除 `lib/crypto/assets/kugou_key.bin` ——
程序其余部分照常工作，只是 `.kgm` 会明确报「缺少酷狗公钥表」而不是静默失败。

---

## FFmpeg

本项目的转码、增强、标签功能通过**调用外部 ffmpeg 程序**实现，
**没有链接或修改 FFmpeg 的代码**。

- 单独安装时：FFmpeg 由用户自行安装，遵循其自身的 LGPL/GPL 许可
- 单文件 exe：内嵌的是 [BtbN](https://github.com/BtbN/FFmpeg-Builds) 构建的
  GPL 版 ffmpeg 二进制。因此**分发的 exe 整体按 GPL 对待**（源码在 `exe/build.mjs`，
  可自行构建）。npm 包和源码仓库不含 ffmpeg 二进制。

---

## 本项目不包含

- 任何音乐平台的专有代码
- 任何账号凭据、设备指纹或用户数据
- 任何音频内容（测试素材需用户自行提供，见 CONTRIBUTING.md）
