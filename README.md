# Image-ChatGPT

> Codex 用户，别浪费ChatGpt网页版的额度，更便捷方便队列方式使用你的ChatGPT额度生成图片，自动保存在本地。
>
> Image-ChatGPT 是一个本地桌面工具，可选择系统安装的 Chrome 或 Edge 控制 ChatGPT 或 Gemini 网页版，让单图、批量出图和图生图排队自动运行。

Image-ChatGPT 不使用官方生成 API，也不内置账号。顶部标签切换 ChatGPT / Gemini，各平台独立选择 Chrome 或 Edge，使用应用同级的独立资料目录，不读取日常浏览器的默认资料；首次使用需在相应平台和浏览器中登录。

## 特性

- 桌面应用：纯 Electron 桌面窗口，支持托盘运行。
- 浏览器选择：ChatGPT 与 Gemini 各自选择 Chrome / Edge，两边可以同时运行；保留浏览器自身的标签栏和地址栏，以兼容登录验证。
- 完全隐藏：点击“隐藏浏览器”后，受控浏览器会从桌面和任务栏隐藏，但网页和队列继续运行；需要操作时点击“显示浏览器”恢复。
- 原生窗口：保留 Windows 标题栏，可直接拖动窗口；登录完成后的工作页顶部居中提供提示和“隐藏窗口”按钮。
- 单图生成：输入一个提示词，生成 1-4 张图片。
- 批量生成：一行一个提示词，自动加入任务队列。
- 图生图：全部参考图作为同一任务，统一使用图生图提示词；支持继续添加、拖动排序、预览和移除参考图。
- 本地 API：手动启用，齿轮打开配置；仅监听 `127.0.0.1`，默认端口 `8765`，配置与访问密钥保存在 `config/local_api.json`，每次启动默认关闭。请求可指定 ChatGPT 或 Gemini。
- 额外提示词：默认折叠，可统一追加到单图、每行批量提示词和图生图任务末尾。
- 预设风格：内置风格选择面板，自动追加风格关键词。
- 任务队列：显示状态、进度、错误、缩略图、保存按钮、重试、复制提示词。排队任务可直接停止；生成中的任务通过应用内确认弹窗停止，仅处理所选任务。右上角“全部重试”将所有失败及已停止任务重新排队，没有失败任务时禁用。
- 并发：每个平台可分别设置 1–5，默认 1；环境 1 使用主标签，其余环境按需新建标签。每个环境首次执行时新建独立对话，应用未退出期间后续任务复用该环境的会话。会话准备失败时仅隔离该环境，其他环境继续运行；发送或结果状态不确定时停止派发新任务，已经运行的任务继续完成，检查后可点击“继续队列”。
- 并发提交：生成最多 5 个环境，参考图上传独立限制为每次 1 个任务；上传通道保持到参考图就绪并确认发送后才交给下一任务，已经提交的图片生成继续并行。ChatGPT 发送后校验新的用户消息、完整提示词及输入区清空；应用自己的未发送残留可安全清理，无法确认归属的草稿保留并隔离对应环境。
- 上传恢复：识别网页上传失败、限额、授权错误和上传请求失败。普通网络或服务暂时错误，仅在旧附件清理及上传连接结束后冷却 8 秒重传 1 次；限额及授权错误暂停后续派发，检查网页后手动继续，服务提供的 Retry-After 尚未到期时不能继续。ChatGPT 参考图会预检查格式及单张 20 MB 上限。单通道不会增加账号的上传额度。
- 参考图上传：上传文件名过滤中文和特殊符号，保留英文数字并附加顺序号，例如 `image_001.png`，同名文件也不会覆盖。只生成上传临时副本，原图名称、图片内容、队列/API 路径和添加顺序保持不变；临时文件在上传及输入区不再使用后清理。请求被取消时继续检查网页附件状态，结合明确错误和等待超时判定结果。
- 历史持久化：任务队列会保存到本地，重启后仍可查看。真正退出应用后，排队中和生成中的未完成任务均标记为失败，不自动恢复；强制关闭或异常退出留下的未完成记录也会在下次启动时标为失败，可按需单独重试或全部重试。
- 本地输出：生成图片保存到 `output/`，可在应用内一键打开目录。
- 本地日志：关键运行日志写入 `logs/app.log`，方便排查浏览器启动、窗口控制和生成失败。

### 本地 API 调用

先在对应平台登录并手动打开本地 API，调用显示的地址和密钥。请求使用 `model: "chatgpt"` 或 `"gemini"` 指定平台；未指定时使用界面当前平台。所有请求带 `Authorization: Bearer <配置中的访问密钥>`；POST 请求使用 `Content-Type: application/json`。

- 文生图：`POST /api/generate`，请求 `{"prompt":"一只橘猫", "count":1}`。
- 图生图：`POST /api/generate/image`，请求 `{"prompt":"改为水彩风格", "input_images":["E:/images/ref.png"], "count":1}`。支持 1–20 张本机参考图绝对路径（PNG/JPEG/WebP/GIF），全部图片合并为同一任务。
- 提交返回 HTTP 202 和 `{"jobs":["任务ID"]}`；`count` 为 1–4，每张生成图对应一个队列任务。
- 查询：`GET /api/jobs/<任务ID>`，返回 `status`、`error`、`images` 等字段。状态为 `queued`、`running`、`done` 或 `failed`。
- 下载：状态为 `done` 后使用 `images` 中的相对地址，例如 `GET /api/jobs/<任务ID>/images/0`。图片索引从 0 开始，下载同样需要访问密钥。
- 健康检查：`GET /api/health`。API 与界面共用各平台的任务队列，并发数由界面分别设置；`queues` 提供每个平台的并发数、运行数、等待数及暂停状态。提交响应 `queue_paused: true` 表示任务已入队但暂停派发，`pause_reason` 说明原因，需要在检查浏览器后点击“继续队列”。API 关闭后已提交任务继续执行。端口被占用时开启失败，可关闭状态下修改端口。

## 适合谁

- 经常用 ChatGPT 或 Gemini 网页版生成图片的人。
- 想批量提交提示词，但不想一直盯着网页的人。
- 想在 Codex 工作流里维护一个本地自动化出图工具的人。
- 不想接官方生成 API，只想使用自己的网页版账号的人。

## 使用前提

- Windows。
- 已安装 Node.js 和 npm。
- 你有可正常使用图片生成功能的 ChatGPT 或 Gemini 账号。

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
2. 选择平台后，在弹出的对应网页中登录账号。
3. 登录完成后可点击 `隐藏浏览器`。
4. 回到应用输入提示词并加入队列。

关闭应用窗口只会隐藏到托盘，任务仍会继续运行。需要真正退出时，右键托盘图标，点击 `退出应用并停止服务`。

## 打包

双击项目根目录的 `build.bat` 即可构建目录版 Windows 便携应用。也可在命令行运行：

```bat
npm.cmd run build
```

如果本地没有依赖，构建脚本会自动执行 `npm.cmd install`。运行时需要已安装 Chrome 或 Edge 至少其中一个。

产物位置：

```text
dist-electron/Image-ChatGPT/Image-ChatGPT.exe
```

这是目录版便携应用，不能只拷贝单个 `Image-ChatGPT.exe` 给别人使用。需要把整个 `Image-ChatGPT/` 文件夹一起打包或压缩发送。

默认构建会保留打包目录里的运行态数据，适合本机继续使用：

- `browser_profile/`
- `browser_profile_edge/`
- `output/`
- `config/`

如果要生成不带登录态、输出图片和队列历史的干净目录版：

```bat
npm.cmd run build:clean
```

`build:clean` 同样会在缺少依赖时自动安装依赖。

如果需要单文件便携 exe，并且网络能访问 electron-builder 辅助二进制：

```bat
npm.cmd run build:portable
```

单文件便携 exe 会由 electron-builder 额外生成；如果没有执行这个命令，当前产物就是目录版。

## 本地数据

应用运行时会在 exe 同级目录保存这些数据：

```text
browser_profile/          Chrome 的 ChatGPT 登录态
browser_profile_edge/     Edge 的 ChatGPT 登录态
browser_profile_gemini_chrome/  Chrome 的 Gemini 登录态
browser_profile_gemini_edge/    Edge 的 Gemini 登录态
output/                   生成图片
config/chat_state.json    ChatGPT 浏览器及保存目录设置
config/queue_state.json   任务队列历史
config/gemini_state.json  Gemini 浏览器及保存目录设置
config/gemini_queue_state.json  Gemini 独立任务队列历史
config/local_api.json     本地 API 配置
logs/app.log              本地运行日志
```

这些文件默认不会提交到 Git。

## 项目结构

```text
electron/                 Electron 主进程、Chrome/Edge 驱动、队列、日志
renderer/index.html        UI 结构
renderer/app.css           UI 样式
renderer/app.js            UI 交互逻辑
config/selectors.json      ChatGPT 网页 DOM 选择器
config/styles.json         预设风格数据
scripts/build-win-dir.js   目录版打包脚本
```

## 注意事项

- 本项目通过网页自动化控制 ChatGPT 与 Gemini，网页结构变化可能导致识别失效。
- ChatGPT 选择器主要位于 `config/selectors.json`；Gemini 的网页适配逻辑位于 `electron/geminiDriver.js`。
- Chrome / Edge 的选择按平台保存；切换浏览器会关闭当前平台的受控浏览器，不影响另一个平台。各平台的浏览器资料需要分别登录一次。
- 可以直接关闭受控浏览器窗口；日常浏览器的默认资料不会受影响，但当前网页任务会中断。需要后台继续跑任务时，请使用应用里的 `隐藏浏览器`、网页顶部居中的 `隐藏窗口`，或托盘菜单。
- 本项目不是 OpenAI 官方项目，也不隶属于 OpenAI。

## 详细教程

完整使用说明见：

[使用说明教程.md](%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E%E6%95%99%E7%A8%8B.md)
