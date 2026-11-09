"use strict";
sessionStorage.removeItem("image_service_key");
const $ = id => document.getElementById(id);
const baseUrl = "https://img.888824.xyz";
let connected = false;
let status = null;
let apiKey = "";
const concurrencyChanged = new Set();
function notice(message) { $("notice").textContent = message; }
function post(value) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }; }
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store" });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) { const error = new Error(data.error || `请求失败 (${response.status})`); error.status = response.status; throw error; }
  return data;
}
function apiInstructions(includeKey) {
  const key = includeKey ? apiKey : "<API_KEY>";
  return [
    "# ChatGPT / Gemini 图片生成 API 接入说明（请直接交给 Agent）",
    "请通过以下异步 HTTP API 完成文生图或图生图；不要调用网页模拟操作。",
    "",
    `Base URL: ${baseUrl}`,
    `认证请求头: Authorization: Bearer ${key}`,
    "前提：管理员已登录对应的 ChatGPT 或 Gemini 账号，并在管理页面手动开启 API。服务重启后需重新开启。",
    "",
    `1. 健康状态：GET ${baseUrl}/api/health`,
    "queues.chatgpt 和 queues.gemini 分别包含 active、queued、paused、pause_reason 和 concurrency。两个平台独立调度，各自最多 5 个并发；异常任务会返回 failed 并自动重置对应标签。",
    "",
    `2. 可选：上传图生图参考图：POST ${baseUrl}/api/uploads`,
    "每次上传一张图片，HTTP 请求体直接放图片二进制，Content-Type 使用 image/png、image/jpeg、image/webp 或 image/gif；每张最多 20 MB。",
    "成功返回 HTTP 201，例如：{\"id\":\"上传返回的文件ID\",\"bytes\":12345}。多张图按顺序依次上传，保留返回 ID 的顺序；一组最多 20 张。",
    "上传文件 ID 最少保留 24 小时，正在排队或运行的任务所引用的参考图不会被过期清理。",
    "",
    `3. 提交任务：POST ${baseUrl}/api/generate`,
    "请求头另加 Content-Type: application/json。",
    "文生图示例：{\"model\":\"chatgpt\",\"prompt\":\"一只在窗边晒太阳的橘猫\",\"count\":1}",
    "图生图示例：{\"model\":\"chatgpt\",\"prompt\":\"保持人物外观并更换背景\",\"count\":1,\"reference_ids\":[\"第1张上传ID\",\"第2张上传ID\"]}",
    "Gemini 示例：{\"model\":\"gemini\",\"prompt\":\"保持人物外观并更换背景\",\"count\":1,\"reference_ids\":[\"上传返回的文件ID\"]}；文生图省略 reference_ids。",
    "prompt 必填，最多 50000 字符；count 为 1–4，默认 1。多张参考图属于同一任务，按 reference_ids 顺序提交给浏览器。远程调用不能使用本机文件路径 input_images。",
    "成功返回 HTTP 202，例如：{\"ok\":true,\"model\":\"chatgpt\",\"mode\":\"img2img\",\"jobs\":[\"任务ID\"]}。count 大于 1 时会返回多个任务 ID，分别跟踪。",
    "",
    `4. 查询任务：GET ${baseUrl}/api/jobs/<任务ID>`,
    "status 为 queued、running、done 或 failed，建议每 3–5 秒轮询。失败时查看 error；done 时 images 为可下载图片的相对路径，images_expire_at 为 UTC 到期时间。",
    "",
    "5. 下载：对 Base URL + images 中的路径发起 GET，仍需携带 Authorization 请求头。图片在任务完成后保留 2 小时；过期后接口返回 HTTP 410，后台每分钟清理过期文件，请及时保存。",
    "",
    "常见错误：401 密钥无效；409 浏览器忙或状态冲突；413 图片过大；415 格式不支持；429 上传繁忙，请稍后重试；503 API 未开启。不要将密钥写入公开代码或日志。",
    "每个并发环境独立保留对话；完成 30 个任务或满 2 小时后，在下一任务开始前切换新对话。单个任务最长运行 15 分钟，超时标记失败；服务重启后未完成任务标记为失败，不自动继续。",
  ].join("\n");
}
async function copy(value, success) {
  try { await navigator.clipboard.writeText(value); notice(success); }
  catch { notice("复制失败，请手动选择内容复制。"); }
}
function disconnect() {
  connected = false; apiKey = ""; status = null; concurrencyChanged.clear();
  $("api-key").value = ""; $("api-key").type = "password"; $("toggle-key").textContent = "显示"; $("api-guide").textContent = "";
  $("desktop").src = "about:blank"; $("desktop-section").hidden = true;
  $("login").hidden = false; $("dashboard").hidden = true; $("connection").textContent = "未连接";
}
async function refresh() {
  if (!connected) return;
  try {
    status = await json("/admin/status");
    if (!apiKey) apiKey = (await json("/admin/key")).api_key || "";
    $("dashboard").hidden = false; $("login").hidden = true; $("connection").textContent = "已连接";
    $("api-status").textContent = status.api_enabled ? "API 已开启" : "API 已关闭";
    $("toggle-api").textContent = status.api_enabled ? "关闭 API" : "开启 API";
    $("password-hint").textContent = status.password_configured ? "访问密码已设置，可以在这里更新。" : "请设置自己的访问密码，之后只需用该密码打开网页。";
    $("api-url").value = baseUrl; $("api-key").value = apiKey;
    $("api-guide").textContent = apiInstructions(false);
    for (const model of ["chatgpt", "gemini"]) {
      const info = status.providers[model];
      const browser = info.logged_in ? "已登录" : info.browser ? "浏览器已打开，等待登录" : "浏览器未打开";
      const login = $(`${model}-login`);
      login.textContent = browser;
      login.classList.toggle("is-ready", info.logged_in);
      $(`${model}-status`).textContent = `排队 ${info.queue.queued} · 运行 ${info.queue.active}${info.queue.paused ? " · 已暂停：" + (info.queue.pause_reason || "请检查浏览器") : ""}`;
      if (!concurrencyChanged.has(model)) {
        const select = $(`concurrency-${model}`);
        select.value = String(info.queue.concurrency);
        select.dataset.savedValue = select.value;
      }
    }
  } catch (error) {
    if (error.status === 401) disconnect();
    else { $("connection").textContent = "连接失败"; notice(error.message); }
  }
}
$("connect").addEventListener("click", async () => {
  const password = $("key").value;
  if (!password) return notice("请输入访问密码");
  try { await json("/auth/login", post({ password })); $("key").value = ""; connected = true; notice(""); await refresh(); }
  catch (error) { notice(error.message); }
});
$("toggle-api").addEventListener("click", async () => {
  try { await json("/admin/api", post({ enabled: !status.api_enabled })); await refresh(); }
  catch (error) { notice(error.message); }
});
document.querySelectorAll("[data-browser], [data-resume]").forEach(button => button.addEventListener("click", async () => {
  const model = button.dataset.browser || button.dataset.resume;
  button.disabled = true;
  try {
    await json(button.dataset.browser ? "/admin/browser" : "/admin/resume", post({ model }));
    if (button.dataset.browser) {
      $("desktop").src = "/desktop/vnc.html?autoconnect=1&resize=scale&path=desktop%2Fwebsockify";
      $("desktop-section").hidden = false;
    }
    notice(button.dataset.browser ? "浏览器已打开，可在页面中完成登录。" : "已请求恢复队列。");
    await refresh();
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
}));
document.querySelectorAll("[data-concurrency]").forEach(select => select.addEventListener("change", async () => {
  const model = select.dataset.concurrency;
  const previous = select.dataset.savedValue || String(status?.providers?.[model]?.queue?.concurrency || 1);
  const value = select.value;
  concurrencyChanged.add(model);
  select.disabled = true;
  try {
    await json("/admin/concurrency", post({ model, concurrency: Number(value) }));
    select.dataset.savedValue = value;
    if (status?.providers?.[model]) status.providers[model].queue.concurrency = Number(value);
    notice(`${model === "gemini" ? "Gemini" : "ChatGPT"} 并发已保存。`);
  } catch (error) {
    select.value = previous;
    notice(error.message);
  } finally {
    concurrencyChanged.delete(model);
    select.disabled = false;
    await refresh();
  }
}));
$("toggle-key").addEventListener("click", () => {
  const field = $("api-key"); field.type = field.type === "password" ? "text" : "password";
  $("toggle-key").textContent = field.type === "password" ? "显示" : "隐藏";
});
$("copy-url").addEventListener("click", () => copy(baseUrl, "API URL 已复制。"));
$("copy-api-key").addEventListener("click", () => copy(apiKey, "API Key 已复制。"));
$("copy-guide").addEventListener("click", () => copy(apiInstructions(true), "完整接入说明已复制，包含 API Key。"));
$("close-desktop").addEventListener("click", () => { $("desktop").src = "about:blank"; $("desktop-section").hidden = true; });
$("save-password").addEventListener("click", async () => {
  if ($("new-password").value !== $("confirm-password").value) return notice("两次输入的密码不一致");
  try { await json("/auth/password", post({ password: $("new-password").value })); $("new-password").value = ""; $("confirm-password").value = ""; notice("访问密码已更新。"); await refresh(); }
  catch (error) { notice(error.message); }
});
$("logout").addEventListener("click", async () => { try { await json("/auth/logout", post({})); } catch {} disconnect(); });
connected = true;
refresh();
setInterval(() => { if (connected) refresh(); }, 10000);
