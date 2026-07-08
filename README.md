# Image-ChatGPT

> Codex 用户，别浪费ChatGpt网页版的额度，更便捷方便队列方式使用你的ChatGPT额度生成图片，自动保存在本地。
>
> Image-ChatGPT 是一个本地桌面工具，用 Electron + Node Playwright 控制你自己的 ChatGPT 网页版，让单图、批量出图和图生图排队自动跑起来。

Image-ChatGPT 不使用 OpenAI API，也不内置任何账号。它会启动本机 Chrome，打开 `chatgpt.com`，使用你自己的 ChatGPT 登录态完成图片生成。

## 特性

- 桌面应用：纯 Electron 桌面窗口，支持托盘运行。
- 隐藏浏览器：后台 Chrome 默认隐藏，需要登录或检查时可手动显示。
- 单图生成：输入一个提示词，生成 1-4 张图片。
- 批量生成：一行一个提示词，自动加入任务队列。
- 图生图：支持上传参考图，每张参考图可写独立提示词，也可多图作为同一任务。
- 预设风格：内置风格选择面板，自动追加风格关键词。
- 任务队列：显示状态、进度、错误、缩略图、保存按钮、重试、复制提示词。
- 历史持久化：任务队列会保存到本地，重启后仍可查看。
- 本地输出：生成图片保存到 `output/`，可在应用内一键打开目录。
- 本地日志：关键运行日志写入 `logs/app.log`，方便排查浏览器启动、窗口控制和生成失败。

## 适合谁

- 经常用 ChatGPT 网页版生成图片的人。
- 想批量提交提示词，但不想一直盯着网页的人。
- 想在 Codex 工作流里维护一个本地自动化出图工具的人。
- 不想接 OpenAI API，只想复用自己 ChatGPT 网页登录态的人。

## 使用前提

- Windows。
- 已安装 Node.js 和 npm。
- 已安装 Google Chrome。
- 你有可正常使用图片生成功能的 ChatGPT 账号。

## 快速开始

```bat
npm.cmd install
npm.cmd start
```

或直接运行：

```bat
run.bat
```

首次启动后：

1. 点击应用里的 `显示浏览器`。
2. 在弹出的 ChatGPT 页面登录账号。
3. 登录完成后可点击 `隐藏浏览器`。
4. 回到应用输入提示词并加入队列。

关闭应用窗口只会隐藏到托盘，任务仍会继续运行。需要真正退出时，右键托盘图标，点击 `退出应用并停止服务`。

## 打包

默认构建目录版 Windows 应用：

```bat
npm.cmd run build
```

产物位置：

```text
dist-electron/Image-ChatGPT-win32-x64/Image-ChatGPT.exe
```

这是目录版便携应用，不能只拷贝单个 `Image-ChatGPT.exe` 给别人使用。需要把整个 `Image-ChatGPT-win32-x64/` 文件夹一起打包或压缩发送。

默认构建会保留打包目录里的运行态数据，适合本机继续使用：

- `browser_profile/`
- `output/`
- `config/`

如果要生成不带登录态、输出图片和队列历史的干净目录版：

```bat
npm.cmd run build:clean
```

如果需要单文件便携 exe，并且网络能访问 electron-builder 辅助二进制：

```bat
npm.cmd run build:portable
```

单文件便携 exe 会由 electron-builder 额外生成；如果没有执行这个命令，当前产物就是目录版。

## 本地数据

应用运行时会在 exe 同级目录保存这些数据：

```text
browser_profile/          ChatGPT 登录态
output/                   生成图片
config/chat_state.json    上次对话 URL 和保存目录
config/queue_state.json   任务队列历史
logs/app.log              本地运行日志
```

这些文件默认不会提交到 Git。

## 项目结构

```text
electron/                 Electron 主进程、Playwright 控制、队列、日志
renderer/index.html        UI 结构
renderer/app.css           UI 样式
renderer/app.js            UI 交互逻辑
config/selectors.json      ChatGPT 网页 DOM 选择器
config/styles.json         预设风格数据
tools/window-control/      Windows 原生窗口隐藏/显示工具
scripts/build-win-dir.js   目录版打包脚本
```

## 注意事项

- 本项目通过网页自动化控制 ChatGPT，ChatGPT 页面结构变化可能导致选择器失效。
- 选择器集中在 `config/selectors.json`，通常无需改代码即可维护。
- 请不要直接关闭后台 Chrome 窗口；需要隐藏时使用应用里的 `隐藏浏览器` 或托盘菜单。
- 本项目不是 OpenAI 官方项目，也不隶属于 OpenAI。

## 详细教程

完整使用说明见：

[使用说明教程.md](%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E%E6%95%99%E7%A8%8B.md)
