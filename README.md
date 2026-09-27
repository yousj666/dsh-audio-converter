# dsh-audio-converter

**音频转换器：解密各平台加密音乐，常规格式互转，并提供真实的音质增强。带拖拽界面。**

拖进去，出来就是能播的文件。

```
网易云 .ncm  ─┐
酷我   .kwm  ─┤
mp3 / flac   ─┼─→  解密 → 增强 → 转码 → 打标签 → 输出
m4a / wav    ─┤
ogg / opus   ─┘
```

---

## 加密格式支持情况（诚实版）

| 平台 | 扩展名 | 状态 | 说明 |
|---|---|---|---|
| **网易云音乐** | `.ncm` | ✅ **已支持** | 与已知正确结果**逐字节一致**（32 个断言验证） |
| **酷我音乐** | `.kwm` | ✅ **已支持** | 密钥恢复 + 容器嗅探验证（15 个断言） |
| **酷狗音乐** | `.kgm` `.kgma` `.vpr` | ✅ **已支持** | v1~v4 已实现（272 字节 MEND 表 + 17/16/272 三重异或），与独立参考实现跨语言对拍 |
| **QQ音乐 v1（老格式）** | `.tkm` `.bkc*` | ✅ **已支持** | 128 字节公开静态密钥；含 0x7FFF 边界规则，已跨语言对拍 |
| **QQ音乐 v2（mflac/mgg）** | `.mflac` `.mgg` `.qmcflac` | ✅ **已支持** | 尾包内嵌 EKey 的（QTag / PcV1Legacy）直接解；已跨语言对拍 |
| QQ音乐 v2（无内嵌密钥） | STag / MusicEx 尾包 | ⚠️ 需外部 EKey | 尾包里**只有资源元数据、没有密钥**，得从客户端数据库取 |
| **QQ音乐 v3（新版）** | `.mgg1/.mgg2/.mmp4` | ❌ **离线不可能** | 见下 |
| 酷狗 KGG | 加密版本 5 | ❌ 不可能 | 密钥在客户端密钥库里 |
| 虾米音乐 | `.xm` | ❌ 不可能 | 虾米已停止服务 |

### QMC v2 的四种尾包

QQ 音乐 v2 的密钥**跟着文件走**，藏在文件末尾的「尾包」里。四种形态：

| 尾包 | 有 EKey？ | 能不能离线解 |
|---|---|---|
| `QTag` | ✅ 内嵌 | **能** —— 直接解 |
| `PcV1Legacy` | ✅ 内嵌 | **能** —— 直接解 |
| `STag` | ❌ 只有资源号 + mid | 需要外部 EKey |
| `MusicEx` | ❌ 只有文件名 | 需要外部 EKey |

后两种的密钥存在**客户端本地数据库**（安卓端 `player_process_db`）里，文件本身不含。
工具和界面上都有 **EKey 输入框**，把密钥填进去就能解。

> 判断「能不能解」用**尾包解析结果**，不是看标记名。
> 一开始我按 `STag`/`QTag` 标记判定，把 STag 误判成「新版无解」——
> 其实它和 QTag 一样都是 v2，区别只在**尾包里有没有密钥**。

### 为什么有两项是「不可能」而不是「还没做」

QQ 音乐新版采用**动态密钥分发 + 设备指纹绑定**：

```
播放请求 → 服务端验证账号与设备合法性 → 下发密钥 → 本地解密
```

**密钥根本不下发到本地文件里。** 所以拿到 `.mgg1` / `.mgg2` / `.mmp4` 之后，
本地**没有任何可用于解密的材料** —— 这不是实现难度问题，是设计上就不给。

**与其假装支持然后吐一个损坏文件，不如直接说清楚。**
界面和 `audio_capabilities` 工具都会明确告诉用户这一点，并给出可行替代方案
（用客户端重新下载为普通格式，或在客户端内导出）。

---

## 音质增强：会做什么、不会做什么

### 会做（真实有效的处理）

| 处理 | 效果 | 参数 |
|---|---|---|
| **响度归一化** | 让音量一致，避免忽大忽小 | EBU R128，默认 -16 LUFS / -1.5 dBTP |
| **夜间模式** | 压缩动态，小声也听得清 | `acompressor` ratio 4:1 |
| **暖声 EQ** | 减少刺耳感 | 200Hz +2dB / 4kHz -2dB |
| **明亮 EQ** | 提升清晰度 | 3kHz +3dB / 10kHz +2dB |
| **人声突出** | 播客/人声向 | 1kHz +2dB / 300Hz -2dB |
| **低频增强** | 补耳机低频 | 80Hz +5dB |
| **高通** | 去超低频浑浊 | 30Hz |
| **重采样 / 声道** | 匹配设备 | 任意采样率、单/立体声 |
| **位深** | 匹配设备或做后续处理 | 16 / 24 / 32 位（**只对 flac/wav 这类无损容器有意义**） |

### **不会**做

> **无法恢复有损编码已经丢掉的信息。**
> 128kbps 的 mp3 转成 FLAC **不会变好听** —— 它只是把同样的信息用更大的容器装起来。
> 界面和工具描述里都明确写了这一点，不做「一键变无损」这种假承诺。

---

## 常规格式互转

`mp3` · `flac` · `m4a` · `aac` · `wav` · `ogg` · `opus`

三档质量：体积优先 / 标准 / 质量优先。

---

## 装

```bash
dsh plugin --profile <profile> add dsh-audio-converter
# 或本地开发
dsh plugin --profile <profile> add link:/path/to/dsh-audio-converter
```

**依赖 ffmpeg**（必需）。程序会**按「能不能跑起来」**自动探测，不依赖任何固定路径：

```bash
winget install Gyan.FFmpeg        # Windows
brew install ffmpeg               # macOS
apt install ffmpeg                # Debian/Ubuntu
```

> ⚠️ 探测用的是「试跑 `-version`」而不是 `existsSync` —— 因为
> **WinGet 的应用执行别名（App Execution Alias）Node 的 `existsSync` 解析不了**，
> 而且 winget 有时会留下「清单还在、文件已删」的幽灵安装（本机就遇到了）。
> 详见知识库 P-017。

---

## 用

### 界面上用（推荐）

会话视图多一个 **「音频转换」** 页签，排在 **「上下文」「定时任务」** 后面
（`conversation.view`，order 40）。

```
把文件拖进虚线框  →  选格式/质量/增强  →  点「开始转换」
```

- **拖拽** 或 **选择文件**
- 任务走 job 模型，界面不卡；实时显示状态、耗时、输出体积
- 底部有**诚实的能力矩阵**，哪些能解、哪些不可能，一目了然
- **文件全程在本机处理，不上传任何服务器**

### 让模型帮你转

```
「把 G:\CloudMusic\VipSongsDownload 里的 ncm 全转成 mp3」
「看一下这个 .mgg 文件到底是什么格式，能不能解」
「把这批 flac 做响度归一化，再转成 m4a」
```

三个工具：

| 工具 | 作用 |
|---|---|
| `audio_convert` | 转换/解密文件或**整个目录**，可指定格式、质量、增强预设 |
| `audio_inspect` | 看一个文件到底是什么（**按 magic 不按后缀**）、能不能解 |
| `audio_capabilities` | 查支持矩阵与 ffmpeg 状态，处理前先确认 |

---

## 设计说明

### 格式识别：先看 magic，再看后缀

有些人只是把 FLAC 改成了 `.ncm` 后缀。只看后缀会把普通文件当加密文件处理，
白白报错。所以**先按文件头识别**：

```
CTENFDAM            → NCM
7C D5 32 EB …       → KGM
05 28 BC 96 …       → VPR
fLaC / ID3 / OggS / ftyp / RIFF  → 普通音频，无需解密
STag / QTag / musicex            → QQ音乐新版
```

### 结果结构必须一致

`processFile` 有两条返回路径（只解密 / 解密+转码）。第一版里提前返回那条
**漏了 `srcInfo` 和 `meta`** —— 调用方得按分支处理，很容易漏字段。
现在两条路径返回完全相同的结构，并且**有测试盯着**这条约束。

### 解密正确性怎么验证的

**不是「自己加密再自己解密」** —— 那只证明两者互逆，证明不了跟真实格式一致。

- **NCM**：拿真实 `.ncm` 解密，跟一份已知正确的转换结果
  **在去掉 ID3 标签之后逐字节比对** → 完全一致
- **KWM**：自造样本往返（5 轮随机内容）+ 三条密钥恢复路径 + 认不出时必须抛错

> 顺带一个坑：直接比整个文件的哈希会**误判** —— 不同工具解密后会把封面
> **重新嵌进 ID3**，一个 1KB 的标签能变成 795KB，但**音频载荷是一样的**。
> 详见知识库 P-018。

---

## 测试

```bash
npm test                 # 一次跑完 8 个测试文件

node test-ncm.mjs        # NCM 解密器           32 个断言
node test-kwm.mjs        # KWM 解密器           15 个断言
node test-kgm-qmc.mjs    # KGM + QMC v1         41 个断言（跨语言对拍）
node test-qmc2.mjs       # QMC v2               46 个断言（跨语言对拍）
node test-ffmpeg.mjs     # ffmpeg 封装          75 个断言
node test-pipeline.mjs   # 格式识别与管线       57 个断言
node test-host.mjs       # host 半边            60 个断言
node test-client.mjs     # 浏览器半边          34 个断言
```

**合计 360 个断言。** 不需要装进 DSH、也不需要浏览器（除 host/client 用 mock ctx）。

**只需 Node ≥ 22.19，没有构建步骤。** ffmpeg 可选 —— 没装的话用到它的测试会跳过。

`test-ncm.mjs` 的第 4 节需要你自己的 `.ncm` 素材（用环境变量指定，见
[CONTRIBUTING.md](./CONTRIBUTING.md)）；没设就整节跳过，其余断言照常跑。

亮点：
- **真实素材 + 外部锚点**：真 `.ncm` 文件 → 与已知正确结果**在去掉 ID3 之后**逐字节比对
- **跨语言对拍**：黄金值由一份**独立写的 Python 参考实现**算出（不 import 原项目），
  JS 侧翻译错了就对不上。QMC 的 `0x7FFF` 边界、TEA 的 float32 语义、
  Map/RC4 的流密码全都靠这个办法验证
- **实测增强效果**：用 ffmpeg 的 `volumedetect` 量处理前后的响度，确认不是空转
- **回读产物校验**：转完再探测一遍输出，比对采样率/时长/编码 —— 采样率被滤镜悄悄改掉就是这么抓到的
- **回退路径也测**：没有 ffprobe 时解析 `ffmpeg -i` 的 stderr，22 个断言确保结果和 ffprobe 一致
- **安全栅栏**：非回环 Host / 跨站发起一律 403；上传时的路径穿越防护
- **诚实性断言**（源码级）：界面必须写明「无法恢复有损信息」「离线做不到」

---

## 已知边界

- **QMC v2 的 STag / MusicEx 尾包不含密钥** —— 需要用界面上的 EKey 输入框手动提供
- **酷狗 KGG（加密版本 5）不支持** —— 密钥在客户端密钥库
- **QQ音乐 v3（新版）离线无解** —— 不是实现问题，是密钥不下发到本地
- **酷狗公钥表是截断版**（8 MB，覆盖 128 MB 音频）。要处理更大的文件，跑 `node scripts/expand-kugou-key.mjs` 生成完整表（69.77 MB）
- 上传文件上限 512MB（拖拽走 HTTP，超大文件建议用工具传路径）
- 批量处理是**串行**的（避免一次转几十首把机器打满）；一次提交几十首会排队
- 解密后**立即写入 ffmpeg 能读的临时文件**，转换完不会自动清理临时目录
- **QMC/KGM 没有官方测试素材** —— 验证靠「自造合法样本 + 跨语言对拍」，
  不是靠真实文件。如果你手上有真实文件跑出问题，欢迎反馈
- Windows 路径分隔符按反斜杠处理；其他平台未实测

---

## 三种用法

### ① DSH 插件（本项目的主体）

会话视图里多一个「音频转换」页签（`conversation.view`，order 40），拖文件进去就行。
同时给模型注册 3 个工具，可以直接说「把某个文件夹里的 ncm 全转成 mp3」。

### ② 命令行（需要 Node + ffmpeg）

```bash
node convert.mjs <文件或文件夹...> [--format mp3] [--enhance loudness] [--out 目录]
node convert.mjs --list      # 看支持哪些格式
node convert.mjs --dry       # 只识别格式，不真转
```

Windows 上也可以双击 `convert.bat`，或者把文件拖到它上面。

### ③ 单文件 exe（不需要任何依赖）

```bash
npm run build-exe
```

打出一个约 **197 MB** 的独立 exe（内嵌 Node + ffmpeg）：

- **拖文件上去** → 直接转成 mp3
- **双击** → 本地网页设置界面，能选格式/质量/位深/增强

拷到任何 Windows 上都能跑，**不需要装 Node、不需要装 ffmpeg**。

> 体积构成：node 88 MB + ffmpeg 100 MB + 酷狗公钥表 8 MB。
> **不带 ffprobe** —— 它是另一个约 100 MB 的静态二进制，
> 而 `probe()` 已经能在没有它时解析 `ffmpeg -i` 的 stderr（22 个断言盯着这条路径）。

---

## 文件

```
lib/crypto/ncm.js               NCM 解密器（AES-128-ECB + RC4 变体）
lib/crypto/kwm.js               KWM 解密器（32 字节循环 XOR + 密钥恢复）
lib/crypto/kgm.js               KGM 解密器（MEND 表 + 三重异或）
lib/crypto/qmc.js               QMC v1（128 字节静态密钥 + 0x7FFF 边界规则）
lib/crypto/qmc2.js              QMC v2（尾包解析 + TEA + Map/RC4 流密码）
lib/crypto/assets/kugou_key.bin 酷狗公钥表（8 MB，覆盖 128 MB 音频）
lib/crypto/assets/kugou_key.xz  同一张表的完整版压缩源（94 KB）
lib/ffmpeg.js                   ffmpeg 封装：探测 / 转码 / 增强 / 打标签
lib/pipeline.js                 格式识别 → 解密 → 转换 → 增强 的调度
lib/resources.js                资源解析：磁盘文件 / exe 内嵌 两种模式
lib/index.js                    host 半边：3 个工具 + 5 条 HTTP 路由 + job 队列
lib/client.js                   浏览器半边：拖拽页签（手写，无构建）
convert.mjs                     命令行入口
convert.bat                        Windows 拖拽入口
exe/main.mjs                    单文件 exe 的入口（拖拽 + 本地界面）
exe/build.mjs                   打包脚本（esbuild → SEA → postject）
scripts/expand-kugou-key.mjs    从 .xz 生成完整公钥表
test-*.mjs                      8 个测试文件，360 个断言
diag-ncm.mjs                    NCM 诊断工具（排查"解出来对不对"用）
```

## 参与开发

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。两条硬规矩：

1. **解密正确性必须用外部锚点证明** —— 自己加密再自己解密只能证明互逆
2. **做不到的如实标注** —— 宁可报错也不要吐出损坏文件

## 许可

MIT。解密算法参考自公开的技术分析文章与 MIT 协议的开源实现（见各文件头部注释）。

## 免责声明

本项目仅用于**个人已购音乐**的格式转换 —— 把你花钱买的歌从专有容器里拿出来，
在你自己拥有的设备上播放。请勿用于传播受版权保护的内容。
