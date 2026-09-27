# 参与开发

欢迎提交 issue 和 PR。这个项目最看重的不是功能多，而是**说的和做的一致** ——
支持的说支持，做不到的说做不到，并且有测试证明。

---

## 本地跑起来

```bash
git clone https://github.com/yousj666/dsh-audio-converter.git
cd dsh-audio-converter
node test-client.mjs      # 不需要任何外部依赖，先确认环境没问题
npm test                  # 跑全部 8 个测试文件
```

**只需 Node ≥ 22.19。** 没有构建步骤，`lib/client.js` 是手写的（浏览器半边在
`window.__ModuleLoader__.load` 协议里，不需要打包）。

**ffmpeg 是可选依赖**：只有跑到真实转码的测试才会用到。
没装的话相关测试会跳过（不会失败）。

```bash
# Windows
winget install Gyan.FFmpeg
# macOS
brew install ffmpeg
# Debian/Ubuntu
apt install ffmpeg
```

---

## 关于测试素材

`test-ncm.mjs` 的第 4 节需要**你自己的 `.ncm` 文件**和一份**已知正确**的转换结果做锚点。
这些文件不会有版权问题地随仓库分发，所以：

```bash
export DSH_TEST_NCM_A=/path/to/song.ncm
export DSH_TEST_KNOWN_A=/path/to/known-good.mp3
export DSH_TEST_NCM_B=...
export DSH_TEST_KNOWN_B=...
```

**没设也能跑** —— 那一节会整节跳过，其余断言照常。

---

## 两条硬规矩

### 1. 解密正确性必须用外部锚点证明

自己加密再自己解密**只能证明两者互逆**，证明不了算法跟真实格式一致。

所以：
- 要么用**真实文件**对比一个**外部产生的**已知正确结果
- 要么用**跨语言对拍**：黄金值由另一份独立实现（Python）算出，硬编码进测试

```
参考实现（Python，独立写的）
        ↓ 算出黄金值
   JS 测试里的硬编码常量
        ↓ 对比
   被测的 JS 实现
```

翻译错一位就会在某个黄金值上暴露。已经这样验证了：
TEA 的 float32 语义、Map 流的 `compress_key`、RC4 的分段跳过、QMC 的 `0x7FFF` 边界。

### 2. 做不到的要如实标注

拿不准能不能解的时候，**宁可报错也不要吐出损坏文件**。

```js
// ❌ 假装成功
return { ok: true, output: garbage }

// ✅ 说清为什么
throw new Error(
  '这是 STag 类型的 QMC v2 文件，尾包里没有内嵌密钥。\n' +
  '可行的办法：\n' +
  '  · 用 QQ 音乐客户端（19.51 及以下）重新下载\n' +
  '  · 或者从安卓端的 player_process_db 里取出 EKey')
```

界面上也是 —— `lib/client.js` 里有一条源码级断言盯着「必须写明无法恢复有损信息」。

---

## 新增一个加密格式的步骤

1. **先找权威资料**，确认算法和常量表来源（在文件头注释里写清出处和许可）
2. 写 `lib/crypto/<格式>.js`，导出 `decrypt<格式>()`
3. **造合法的合成样本**做往返测试（`test-<格式>.mjs`）
4. **尽量做跨语言对拍** —— 用 Python 按公开规范另写一遍，把输出硬编码进测试
5. 接进 `lib/pipeline.js`：`detectFormat()` 识别、`decryptionSupport()` 表态、`decryptToFile()` 解密
6. 更新 `lib/index.js` 的 `capabilityMatrix()`（这是界面和工具显示的能力表，**必须与实现一致**）
7. 更新 README 和 CHANGELOG

**第 6 步最容易漏** —— 改完实现忘了改能力表，用户会看到「显示支持、实际报错」。
`test-host.mjs` 里有断言盯着矩阵内容。

---

## 提交 PR 前

```bash
npm test          # 必须全绿
```

- 测试数量只增不减（除非有充分理由）
- 新增的「回退路径」「错误路径」都要有断言 —— 只测 happy path 的 PR 会被要求补
- 中文注释可以，本项目主要面向中文用户；变量名和 API 用英文

---

## 代码风格

- 注释写**为什么**，不写**是什么** —— 代码本身能说清「是什么」
- 踩过的坑写在注释里，避免后人再踩一次
- 错误信息要**可操作**：告诉用户下一步能做什么，而不是只说「失败了」

---

## 许可

提交 PR 即表示你同意以 MIT 许可发布你的贡献。
