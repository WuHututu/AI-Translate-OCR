# AI Translate OCR

AI Translate OCR 是一个轻量级 Windows 截图翻译工具。应用通过全局快捷键唤出截图框选，本地 OCR 识别截图文字，并在悬浮结果窗中显示原文和译文。

> 本项目编码任务由 GPT-5.5 实现。

## 功能特性

- 全局快捷键唤出截图翻译，默认 `Ctrl+Shift+T`
- 托盘常驻，右键托盘可打开设置或退出
- 本地 OCR 识别，当前默认支持英文和简体中文：`eng+chi_sim`
- 原文和译文均可编辑
- 修改原文后可重试翻译
- 译文支持复制和手动修改
- 结果窗口支持原文/译文区域收起与边界拖拽调整
- 默认结果窗口大小：`492 x 388`
- 支持多翻译接口并可在结果窗口快速切换
- AI 兼容接口支持真实流式输出，包括 DeepSeek / OpenAI-compatible API
- 免费接口支持 LibreTranslate 和 MyMemory，一次性返回结果
- 设置中可编辑翻译 Prompt，并支持一键恢复默认 Prompt
- API Key 会保存到本机 Electron `userData` 目录，系统支持时使用 `safeStorage` 加密

## 翻译接口

当前支持三类 provider：

- OpenAI-compatible：可配置 `Base URL`、`API Key`、`Model`，支持流式传输
- LibreTranslate：可配置服务端点，一次性返回翻译结果
- MyMemory：免费翻译接口，一次性返回翻译结果

DeepSeek 可作为 OpenAI-compatible provider 配置，例如：

```text
Base URL: https://api.deepseek.com/v1
Model: deepseek-v4-flash
```

实际模型名以你的 DeepSeek 控制台可用模型为准。

## Prompt

默认 Prompt：

```text
Translate from {sourceLanguage} to {targetLanguage}. Return only the translated text. Preserve line breaks.
```

支持的占位符包括：

```text
{sourceLanguage}
{targetLanguage}
{source_language}
{target_language}
{源语言}
{目标语言}
```

## 开发环境

- Windows
- Node.js
- npm

安装依赖：

```powershell
npm install
```

开发运行：

```powershell
npm run start
```

仅构建 TypeScript 和静态资源：

```powershell
npm run build
```

## 打包

```powershell
npm run pack:win
```

`electron-builder` 默认输出到 `release/`。如果网络环境导致 Electron 运行时下载失败，可以先确认本地 `node_modules/electron/dist` 是否已存在，再使用本地运行时进行手动打包。

## 项目结构

```text
src/main       Electron 主进程、截图、OCR、配置、翻译接口
src/preload    安全暴露给渲染进程的 IPC API
src/renderer   结果窗口、设置窗口、截图遮罩 UI
src/shared     共享类型定义
scripts        构建辅助脚本
```

## 注意事项

- 当前 OCR 语言固定为 `eng+chi_sim`
- 免费翻译 API 不做流式传输
- AI 兼容接口会请求 `stream: true`，并兼容常见 SSE / JSONL 流格式
- 打包产物、`dist/` 和 `node_modules/` 不提交到 git

## License

未指定许可证。公开发布前建议补充合适的开源许可证。