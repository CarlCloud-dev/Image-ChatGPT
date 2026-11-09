"use strict";

// Linux service entry point. The desktop application continues to use main.js.
process.umask(0o077);
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { ChatGPTDriver } = require("../electron/chatgptDriver");
const { GeminiDriver } = require("../electron/geminiDriver");
const { QueueManager } = require("../electron/queueManager");
const { LocalApi } = require("../electron/localApi");
const { validateReferences } = require("../electron/uploadManager");
const { trackCompletedSessions } = require("./queue-policy");
const logger = require("../electron/logger");

const root = path.resolve(process.env.IMAGE_DATA_DIR || "/data");
const configDir = path.join(root, "config");
const uploads = path.join(root, "uploads");
const out = path.join(root, "output");
for (const dir of [configDir, uploads, out, path.join(root, "logs")]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
logger.init(path.join(root, "logs", "app.log"));
const paths = {
  sourceRoot: path.resolve(__dirname, ".."), dataRoot: root, configDir,
  selectorsJson: path.resolve(__dirname, "../config/selectors.json"),
  stateJson: path.join(configDir, "chat_state.json"),
  queueStateJson: path.join(configDir, "queue_state.json"),
  profileDir: path.join(root, "browser_profile"), outputDir: out,
};
const drivers = {
  chatgpt: new ChatGPTDriver(paths),
  gemini: new GeminiDriver({ ...paths, stateJson: path.join(configDir, "gemini_state.json"), outputDir: path.join(out, "Gemini") }),
};
const providers = {};
const MAX_PROVIDER_CONCURRENCY = 5;
const SESSION_TASK_LIMIT = 30;
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const IMAGE_RETENTION_MS = 2 * 60 * 60 * 1000;
for (const [name, driver] of Object.entries(drivers)) {
  // Xvfb provides the display; keep the browser visible inside that display.
  const init = driver.init;
  driver.init = function () { return init.call(this, { headless: false }); };
  // The browser lives inside the web page, so the Windows-only hide-window
  // overlay and its close-warning are unnecessary on the server.
  driver.ensureAuthenticatedPageWindowControls = async () => false;
  driver.setupPageWindowControls = async () => {};
  driver.installPageWindowControls = async () => false;
  // Each server task gets an isolated tab that can be discarded without
  // closing the browser's login page or disturbing other active workers.
  driver.isolatedWorkersUseNewPages = true;
  // Fatal upload errors belong to the current job; they must not permanently
  // block every later upload on this unattended service.
  driver.uploadCoordinator.block = () => {};
  const queue = new QueueManager(driver, { stateFile: name === "chatgpt" ? paths.queueStateJson : path.join(configDir, "gemini_queue_state.json"), resetFailedWorkers: true, taskTimeoutMs: 15 * 60 * 1000 });
  const sessionStats = new WeakMap();
  const acquireWorker = queue.acquireWorker.bind(queue);
  queue.acquireWorker = async (slotId, progress, signal) => {
    const record = await acquireWorker(slotId, progress, signal);
    let state = sessionStats.get(record);
    if (!state) { state = { startedAt: Date.now(), completed: 0 }; sessionStats.set(record, state); }
    const due = record.used && (state.completed >= SESSION_TASK_LIMIT || Date.now() - state.startedAt >= SESSION_MAX_AGE_MS);
    if (!due) return record;
    if (signal?.aborted) throw signal.reason;
    if (progress) await progress("ready", "正在切换到新对话");
    await record.worker.assertPrimaryComposerClear({ requireComposer: true });
    try {
      await record.worker.openNewChat();
      if (record.worker.conversationKey(record.worker.pageUrl())) throw new Error("未能确认新对话页面");
    } catch (error) {
      // If navigation happened but readiness failed, do not retain an old URL.
      if (!record.worker.conversationKey(record.worker.pageUrl())) {
        record.conversationKey = null;
        record.used = false;
      }
      throw error;
    }
    record.conversationKey = null;
    record.used = false;
    record.stopped = false;
    state.startedAt = Date.now();
    state.completed = 0;
    logger.info("remote.conversation.rotated", { provider: name, slot: slotId + 1, taskLimit: SESSION_TASK_LIMIT, maxAgeHours: 2 });
    return record;
  };
  trackCompletedSessions(queue, driver, sessionStats);
  providers[name] = { driver, queue };
}

const safeUploadId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/;
let apiEnabled = false;
let uploading = false;

class RemoteApi extends LocalApi {
  async body(req) {
    const body = await super.body(req);
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (req.method === "POST" && ["/api/generate", "/api/generate/image"].includes(pathname)) {
      if (!body || typeof body !== "object" || Array.isArray(body)) return body;
      if (body.input_images !== undefined) this.fail("远程图生图请先上传参考图，并通过 reference_ids 传入文件 ID");
      if (body.name !== undefined && body.name !== null && (typeof body.name !== "string" || body.name.length > 80 || /[\\/\x00-\x1f]/.test(body.name))) this.fail("name 须为最多 80 字符的名称，不能包含路径分隔符或控制字符");
      const ids = body.reference_ids === undefined ? [] : body.reference_ids;
      if (!Array.isArray(ids) || ids.length > 20) this.fail("reference_ids 须为最多 20 个文件 ID 的数组");
      body.input_images = ids.map(id => {
        if (typeof id !== "string" || !safeUploadId.test(id)) this.fail("参考图 ID 无效");
        const file = path.join(uploads, id);
        try { if (!fs.statSync(file).isFile()) this.fail("参考图不存在"); }
        catch { this.fail("参考图不存在，请重新上传"); }
        return file;
      });
      delete body.reference_ids;
    }
    return body;
  }
  json(res, status, data) {
    // Local API job snapshots include server-side paths; remote callers need
    // only the job id, status and authenticated image URLs.
    const scrub = value => {
      if (Array.isArray(value)) return value.map(scrub);
      if (!value || typeof value !== "object") return value;
      const result = Object.fromEntries(Object.entries(value).filter(([key]) => !["image_paths", "input_images", "api_key"].includes(key)).map(([key, item]) => [key, scrub(item)]));
      if (value.job_id && value.status === "done" && value.finished_at && Array.isArray(value.image_paths) && value.image_paths.length) {
        const expiresAt = Number(value.finished_at) * 1000 + IMAGE_RETENTION_MS;
        if (Number.isFinite(expiresAt)) {
          result.images_expire_at = new Date(expiresAt).toISOString();
          result.images_expired = Date.now() >= expiresAt;
        }
      }
      return result;
    };
    return super.json(res, status, scrub(data));
  }
}
const api = new RemoteApi(providers, configDir);
const sameOrigin = "https://img.888824.xyz";
const webPasswordPath = path.join(configDir, "web-access.json");
const sessions = new Map();
const desktopSockets = new Map();
let failedLogins = 0;
let lockedUntil = 0;
let browserMutation = false;
function cleanupGeneratedImages() {
  const cutoff = Date.now();
  const protection = new Map();
  for (const { queue } of Object.values(providers)) {
    for (const job of queue.jobs) {
      const expiry = ["queued", "running"].includes(job.status) ? Infinity
        : job.finished_at ? Number(job.finished_at) * 1000 + IMAGE_RETENTION_MS : 0;
      for (const file of job.image_paths || []) if (typeof file === "string") protection.set(path.resolve(file), expiry);
    }
  }
  // Only date folders inside the service's own output directory are eligible.
  for (const parent of [out, path.join(out, "Gemini")]) {
    try {
      if (fs.lstatSync(parent).isSymbolicLink() || !fs.lstatSync(parent).isDirectory()) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
        const folder = path.join(parent, entry.name);
        if (fs.lstatSync(folder).isSymbolicLink()) continue;
        for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
          if (!file.isFile() || !/^[1-9]\d*(?:-[1-9]\d*)?_.+\.(?:png|jpe?g|webp)$/i.test(file.name)) continue;
          const target = path.join(folder, file.name);
          try {
            const info = fs.lstatSync(target);
            if (!info.isFile() || info.isSymbolicLink()) continue;
            const expiry = protection.get(path.resolve(target)) || info.mtimeMs + IMAGE_RETENTION_MS;
            if (cutoff >= expiry) fs.unlinkSync(target);
          } catch (error) { if (error.code !== "ENOENT") logger.warn("remote.image.cleanup_failed", { code: error.code }); }
        }
      }
    } catch (error) { if (error.code !== "ENOENT") logger.warn("remote.image.cleanup_failed", { code: error.code }); }
  }
}
cleanupGeneratedImages();
setInterval(cleanupGeneratedImages, 60 * 1000).unref();
function cleanExpiredUploads() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(uploads)) {
    if (!safeUploadId.test(name)) continue;
    const file = path.join(uploads, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs >= cutoff) continue;
      // Recheck immediately before unlink without yielding to a new enqueue.
      const inUse = Object.values(providers).some(({ queue }) => queue.jobs.some(job =>
        (job.status === "queued" || job.status === "running") && (job.input_images || []).includes(file)));
      if (!inUse) fs.unlinkSync(file);
    } catch (error) { if (error.code !== "ENOENT") logger.warn("remote.upload.cleanup_failed", { code: error.code }); }
  }
}
setInterval(() => { try { cleanExpiredUploads(); } catch (error) { logger.warn("remote.upload.cleanup_failed", { code: error.code }); } }, 60 * 60 * 1000).unref();
function authorized(req) {
  const expected = Buffer.from(`Bearer ${api.config.api_key}`);
  const actual = Buffer.from(req.headers.authorization || "");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function sessionId(req) {
  const match = String(req.headers.cookie || "").match(/(?:^|;\s*)__Host-image_session=([a-f0-9]{64})(?:;|$)/);
  if (!match) return null;
  const expiry = sessions.get(match[1]);
  if (!expiry || expiry <= Date.now()) { sessions.delete(match[1]); return null; }
  return match[1];
}
function sessionAuthorized(req) { return !!sessionId(req); }
function verifyWebPassword(password) {
  if (typeof password !== "string" || password.length > 256) return false;
  if (!fs.existsSync(webPasswordPath)) {
    const actual = Buffer.from(password);
    const expected = Buffer.from(api.config.api_key);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  try {
    const stored = JSON.parse(fs.readFileSync(webPasswordPath, "utf8"));
    if (!/^[a-f0-9]{32}$/.test(stored.salt) || !/^[a-f0-9]{128}$/.test(stored.hash)) return false;
    const expected = Buffer.from(stored.hash, "hex");
    return crypto.timingSafeEqual(crypto.scryptSync(password, Buffer.from(stored.salt, "hex"), 64), expected);
  } catch { return false; }
}
function setWebPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) throw Object.assign(new Error("访问密码须为 8–128 个字符"), { status: 400 });
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  const temp = `${webPasswordPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ salt: salt.toString("hex"), hash: hash.toString("hex") }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, webPasswordPath);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function createSession(res) {
  for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
  if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
  const session = crypto.randomBytes(32).toString("hex");
  sessions.set(session, Date.now() + 8 * 60 * 60 * 1000);
  res.setHeader("Set-Cookie", `__Host-image_session=${session}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`);
}
function json(res, code, obj) { api.json(res, code, obj); }
async function upload(req, res) {
  if (uploading) return json(res, 429, { error: "正在上传其他参考图，请稍后重试" });
  const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  if (!extensions[mime]) return json(res, 415, { error: "仅支持 PNG、JPEG、GIF 和 WebP 图片" });
  uploading = true;
  const id = `${crypto.randomUUID()}.${extensions[mime]}`;
  const target = path.join(uploads, id);
  let file;
  try {
    file = await fs.promises.open(target, "wx", 0o600);
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 20 * 1024 * 1024) throw Object.assign(new Error("参考图不能超过 20 MB"), { status: 413 });
      await file.writeFile(chunk);
    }
    await file.close();
    file = null;
    const metadata = validateReferences([target]);
    const actual = metadata[0].format === "jpeg" ? "jpg" : metadata[0].format;
    if (actual !== extensions[mime]) throw Object.assign(new Error("图片内容与 Content-Type 不一致"), { status: 400 });
    return json(res, 201, { id, bytes: total });
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await fs.promises.unlink(target).catch(() => {});
    return json(res, error.status || 400, { error: error.message || "图片上传失败" });
  } finally { uploading = false; }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
  }
  if (req.method === "GET" && ["/app.js", "/app.css"].includes(url.pathname)) {
    res.writeHead(200, { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return fs.createReadStream(path.join(__dirname, "public", path.basename(url.pathname))).pipe(res);
  }
  if (req.headers.origin && req.headers.origin !== sameOrigin) return json(res, 403, { error: "来源不受信任" });
  if (url.pathname === "/auth/login" && req.method === "POST") {
    if (req.headers.origin !== sameOrigin) return json(res, 403, { error: "来源不受信任" });
    if (Date.now() < lockedUntil) return json(res, 429, { error: "尝试次数过多，请稍后再试" });
    const body = await api.body(req);
    if (!verifyWebPassword(body?.password)) {
      if (++failedLogins >= 10) { lockedUntil = Date.now() + 30000; failedLogins = 0; }
      return json(res, 401, { error: "访问密码错误" });
    }
    failedLogins = 0;
    createSession(res);
    return json(res, 200, { ok: true, password_configured: fs.existsSync(webPasswordPath) });
  }
  const session = sessionAuthorized(req);
  const bearer = authorized(req);
  if (!session && !bearer) return json(res, 401, { error: "请先输入访问密码" });
  if (session && !bearer && req.method !== "GET" && req.method !== "HEAD" && req.headers.origin !== sameOrigin) return json(res, 403, { error: "来源不受信任" });
  if (url.pathname === "/auth/password" && req.method === "POST") {
    if (!session) return json(res, 403, { error: "请使用网页登录后设置密码" });
    const body = await api.body(req);
    setWebPassword(body?.password);
    const current = sessionId(req);
    for (const id of sessions.keys()) {
      if (id === current) continue;
      sessions.delete(id);
      for (const socket of desktopSockets.get(id) || []) socket.destroy();
      desktopSockets.delete(id);
    }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    const id = sessionId(req);
    if (id) {
      sessions.delete(id);
      for (const socket of desktopSockets.get(id) || []) socket.destroy();
      desktopSockets.delete(id);
    }
    res.setHeader("Set-Cookie", "__Host-image_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
    return json(res, 200, { ok: true });
  }
  if (url.pathname.startsWith("/desktop/")) {
    if (!session || !["GET", "HEAD"].includes(req.method)) return json(res, 403, { error: "请先网页登录" });
    const proxy = http.request({ host: "127.0.0.1", port: 6080, method: req.method, path: req.url.slice("/desktop".length), headers: { host: "127.0.0.1:6080" } }, upstream => {
      res.writeHead(upstream.statusCode || 502, { ...upstream.headers, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      upstream.pipe(res);
    });
    proxy.on("error", () => { if (!res.headersSent) json(res, 502, { error: "浏览器桌面尚未就绪" }); else res.destroy(); });
    proxy.end();
    return;
  }
  if (url.pathname === "/admin/key" && req.method === "GET") {
    if (!session) return json(res, 403, { error: "请使用网页登录" });
    return LocalApi.prototype.json.call(api, res, 200, { api_key: api.config.api_key });
  }
  if (url.pathname === "/admin/status" && req.method === "GET") {
    const states = {};
    for (const [name, item] of Object.entries(providers)) {
      states[name] = { browser: item.driver.hasLivePage(), logged_in: item.driver.hasLivePage() ? await item.driver.isLoggedIn({ start: false }) : false, queue: item.queue.status() };
    }
    return json(res, 200, { api_enabled: apiEnabled, providers: states, max_concurrency_per_provider: MAX_PROVIDER_CONCURRENCY, image_retention_seconds: IMAGE_RETENTION_MS / 1000, session_task_limit: SESSION_TASK_LIMIT, session_max_age_seconds: SESSION_MAX_AGE_MS / 1000, password_configured: fs.existsSync(webPasswordPath) });
  }
  if (url.pathname === "/admin/api" && req.method === "POST") {
    const body = await api.body(req);
    if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled 须为布尔值" });
    apiEnabled = body.enabled;
    return json(res, 200, { enabled: apiEnabled });
  }
  if (url.pathname === "/admin/concurrency" && req.method === "POST") {
    const body = await api.body(req);
    const count = Number(body?.concurrency);
    const model = body?.model || "chatgpt";
    if (!["chatgpt", "gemini"].includes(model)) return json(res, 400, { error: "平台须为 chatgpt 或 gemini" });
    if (!Number.isInteger(count) || count < 1 || count > MAX_PROVIDER_CONCURRENCY) return json(res, 400, { error: "并发数须为 1 至 5" });
    try { providers[model].queue.setConcurrency(count); }
    catch (error) { return json(res, 409, { error: error.message }); }
    return json(res, 200, { model, concurrency: count });
  }
  if (["/admin/browser", "/admin/resume"].includes(url.pathname) && req.method === "POST") {
    const body = await api.body(req);
    const item = providers[body.model];
    if (!item) return json(res, 400, { error: "平台须为 chatgpt 或 gemini" });
    if (url.pathname === "/admin/browser") {
      if (browserMutation || item.queue.activeRuns.size) return json(res, 409, { error: "该平台任务或浏览器操作进行中，请稍后重试" });
      browserMutation = true;
      try {
        await item.driver.init({ headless: false });
        await item.driver.showWindow();
        await item.driver.page?.bringToFront();
      } finally { browserMutation = false; }
    } else item.queue.resume();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/admin/import-cookies" && req.method === "POST") {
    const body = await api.body(req);
    if (!Array.isArray(body?.cookies) || !body.cookies.length || body.cookies.length > 200) return json(res, 400, { error: "Cookie 数据无效" });
    if (browserMutation || Object.values(providers).some(p => p.queue.activeRuns.size)) return json(res, 409, { error: "任务或浏览器操作进行中，请稍后重试" });
    const cookies = body.cookies.map(c => {
      const host = typeof c?.domain === "string" ? c.domain.replace(/^\./, "") : "";
      if (!/^(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)$/i.test(host) || typeof c.name !== "string" || !c.name || typeof c.value !== "string" || typeof c.path !== "string" || !c.path.startsWith("/")) throw Object.assign(new Error("Cookie 不属于 ChatGPT 或格式无效"), { status: 400 });
      const item = { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: !!c.secure, httpOnly: !!c.httpOnly };
      if (c.name.startsWith("__Host-")) {
        if (c.domain.startsWith(".") || c.path !== "/" || !c.secure) throw Object.assign(new Error("Cookie 安全属性无效"), { status: 400 });
        delete item.domain;
        delete item.path;
        item.url = `https://${host}/`;
      }
      if (Number.isFinite(c.expires) && c.expires > 0) item.expires = c.expires;
      if (["Strict", "Lax", "None"].includes(c.sameSite)) item.sameSite = c.sameSite;
      return item;
    });
    browserMutation = true;
    try {
      const driver = providers.chatgpt.driver;
      if (driver.hasLivePage() && await driver.isLoggedIn({ start: false })) return json(res, 409, { error: "服务器已有 ChatGPT 登录，请先确认账号后再导入" });
      await driver.init({ headless: false });
      let imported = 0;
      for (const cookie of cookies) {
        try { await driver.context.addCookies([cookie]); imported += 1; } catch { /* Some browser-specific cookies cannot be transferred. */ }
      }
      if (!imported) return json(res, 400, { error: "浏览器无法接受快照中的 Cookie，请在网页内登录" });
      await driver.goto("https://chatgpt.com/");
      let loggedIn = false;
      for (let attempt = 0; attempt < 4 && !loggedIn; attempt += 1) {
        if (attempt) await driver.page.waitForTimeout(1500);
        loggedIn = await driver.isLoggedIn({ start: false });
      }
      return json(res, 200, { imported, skipped: cookies.length - imported, logged_in: loggedIn });
    } catch (error) {
      // Browser exceptions can contain cookie values. Never print the exception.
      logger.warn("remote.cookie_import.failed", { name: String(error?.name || "Error").slice(0, 60) });
      return json(res, 500, { error: "账号导入或浏览器启动失败，请在网页打开浏览器检查登录状态" });
    } finally { browserMutation = false; }
  }
  if (url.pathname.startsWith("/api/")) {
    if (!apiEnabled) return json(res, 503, { error: "API 尚未在管理页面手动开启" });
    if (browserMutation && ["/api/generate", "/api/generate/image"].includes(url.pathname)) return json(res, 409, { error: "正在处理浏览器登录，请稍后重试" });
    if (url.pathname === "/api/uploads" && req.method === "POST") return upload(req, res);
    const imageMatch = /^\/api\/jobs\/([^/]+)\/images\/(\d+)$/.exec(url.pathname);
    if (imageMatch && req.method === "GET") {
      const found = api.findJobAcrossQueues(imageMatch[1]);
      const job = found?.job;
      const file = job?.status === "done" && Array.isArray(job.image_paths) && job.image_paths[Number(imageMatch[2])];
      if (file && job.finished_at && Date.now() >= Number(job.finished_at) * 1000 + IMAGE_RETENTION_MS) {
        return json(res, 410, { error: "图片已超过两小时保留期限" });
      }
    }
    delete req.headers.origin; // Already checked against the configured HTTPS origin.
    if (session && !bearer) req.headers.authorization = `Bearer ${api.config.api_key}`;
    return api.handle(req, res);
  }
  return json(res, 404, { error: "接口不存在" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    logger.error("remote.request.failed", { message: error.message });
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "服务内部错误" });
    else res.destroy();
  });
});
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const id = sessionId(req);
  if (url.pathname !== "/desktop/websockify" || req.headers.origin !== sameOrigin || !id) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  if (!desktopSockets.has(id)) desktopSockets.set(id, new Set());
  desktopSockets.get(id).add(socket);
  const timer = setTimeout(() => socket.destroy(), Math.max(1, sessions.get(id) - Date.now()));
  timer.unref();
  socket.on("close", () => {
    clearTimeout(timer);
    const items = desktopSockets.get(id);
    if (items) { items.delete(socket); if (!items.size) desktopSockets.delete(id); }
  });
  const upstream = net.connect(6080, "127.0.0.1", () => {
    const forwarded = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      if (["host", "cookie", "authorization", "proxy-authorization"].includes(key.toLowerCase())) continue;
      forwarded.push(`${key}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`GET /websockify${url.search} HTTP/1.1\r\nHost: 127.0.0.1:6080\r\n${forwarded.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.requestTimeout = 120000;
server.headersTimeout = 15000;
server.listen(8765, "0.0.0.0", () => logger.info("remote.service.ready", { port: 8765 }));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  for (const item of Object.values(providers)) item.queue.shutdown();
  await Promise.all(Object.values(drivers).map(driver => driver.close().catch(() => {})));
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
