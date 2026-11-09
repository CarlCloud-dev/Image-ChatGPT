const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, Tray } = require("electron");
const { paths, fileUrl } = require("./paths");
const { ChatGPTDriver } = require("./chatgptDriver");
const { GeminiDriver } = require("./geminiDriver");
const { QueueManager } = require("./queueManager");
const { LocalApi } = require("./localApi");
const logger = require("./logger");

let mainWindow = null;
let tray = null;
let isQuitting = false;
let driver = null;
let queue = null;
let localApi = null;
let p = null;
let activeProvider = "chatgpt";
const providers = {};
const loginProbes = new WeakMap();

async function probeLogin(driverToCheck) {
  if (!driverToCheck.hasLivePage()) return null;
  const page = driverToCheck.page;
  let pending = loginProbes.get(page);
  if (!pending) {
    pending = Promise.resolve().then(() => driverToCheck.isLoggedIn({ start: false })).then(value => !!value, () => null);
    loginProbes.set(page, pending);
    pending.then(() => { if (loginProbes.get(page) === pending) loginProbes.delete(page); });
  }
  let timer;
  try {
    return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); })]);
  } finally { clearTimeout(timer); }
}

function sendQueueEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("queue-event", event);
  }
}

function sendBrowserStateEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("browser-state-event", event);
  }
}

function loadStyles() {
  const raw = JSON.parse(fs.readFileSync(p.stylesJson, "utf8"));
  const coversRoot = path.join(p.rendererDir, "style_covers");
  return raw.map((cat) => ({
    ...cat,
    items: cat.items.map((item) => {
      const rel = String(item.cover || "").replace(/^\/static\/style_covers\//, "").replace(/\//g, path.sep);
      return { ...item, cover: fileUrl(path.join(coversRoot, rel)) };
    }),
  }));
}

async function createWindow() {
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = Math.min(1280, Math.max(1100, Math.floor(workWidth * 0.82)));
  const windowHeight = Math.min(860, Math.max(720, Math.floor(workHeight * 0.86)));
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 1040,
    minHeight: 680,
    title: "Image-ChatGPT",
    icon: p.iconIco,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  await mainWindow.loadFile(p.rendererIndex);
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setTrayMenu(browserVisible = false) {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开界面", click: showWindow },
    {
      label: `${browserVisible ? "隐藏" : "显示"} ${activeProvider === "gemini" ? "Gemini" : "ChatGPT"} 浏览器`,
      click: () => {
        toggleBrowserWindow().catch((e) => {
          sendBrowserStateEvent({ ok: false, visible: browserVisible, msg: e.message || "切换失败" });
        });
      },
    },
    { label: "打开图片目录", click: () => shell.openPath(driver.outputDir()) },
    { type: "separator" },
    {
      label: "退出应用并停止服务",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

async function refreshTrayMenu() {
  if (!tray || !driver) return;
  let visible = false;
  try {
    visible = await driver.isWindowVisible();
  } catch {
    visible = false;
  }
  setTrayMenu(visible);
}

async function toggleBrowserWindow({ notify = true } = {}) {
  const current = driver;
  const provider = activeProvider;
  logger.info("browser.toggle.request", { notify });
  const result = { ...await current.toggleWindow(), provider };
  logger.info("browser.toggle.result", result);
  await refreshTrayMenu();
  if (notify) sendBrowserStateEvent(result);
  return result;
}

function createTray() {
  tray = new Tray(p.iconIco);
  tray.setToolTip("Image-ChatGPT");
  setTrayMenu(false);
  tray.on("click", showWindow);
  tray.on("right-click", () => {
    refreshTrayMenu().catch(() => {});
  });
}

async function shutdown() {
  logger.info("app.shutdown.start");
  for (const item of Object.values(providers)) item.queue.shutdown();
  if (localApi) await localApi.stop();
  await Promise.all(Object.values(providers).map(item => item.driver.close()));
  logger.info("app.shutdown.done");
}

function requestQuit() {
  logger.info("app.quit.request");
  isQuitting = true;
  setTimeout(() => app.quit(), 80);
}

function registerIpc() {
  ipcMain.handle("provider-select", (_event, value) => {
    const next = value === "gemini" ? "gemini" : "chatgpt";
    activeProvider = next;
    driver = providers[next].driver;
    queue = providers[next].queue;
    refreshTrayMenu().catch(() => {});
    return { ok: true, provider: next };
  });
  ipcMain.handle("local-api-status", () => localApi.status());
  ipcMain.handle("local-api-update", (_event, body) => localApi.update(body || {}));
  ipcMain.handle("file-url", (_event, filePath) => fileUrl(filePath));
  ipcMain.handle("styles", () => loadStyles());
  ipcMain.handle("health", async () => {
    const current = driver;
    const currentQueue = queue;
    const seen = new Set();
    const candidates = [current, ...currentQueue.healthWorkers()].filter(item => {
      if (!item.hasLivePage() || seen.has(item.page)) return false;
      seen.add(item.page);
      return true;
    });
    const states = await Promise.all(candidates.map(probeLogin));
    const loggedIn = states.some(state => state === true);
    return {
      ok: true,
      driver_ready: candidates.length > 0,
      browser_connected: !!(current.browser && current.browser.isConnected()),
      initializing: current.isInitializing(),
      logged_in: loggedIn,
      login_unknown: !loggedIn && candidates.length > 0,
      login_check_timeout: !loggedIn && states.some(state => state === null),
      last_error: current.lastInitError,
      login_url: current.cfg.login_url,
      page_url: current.pageUrl() || null,
    };
  });
  ipcMain.handle("open-output-dir", () => {
    fs.mkdirSync(driver.outputDir(), { recursive: true });
    shell.openPath(driver.outputDir());
    return { ok: true, dir: driver.outputDir() };
  });
  ipcMain.handle("output-dir", () => ({ dir: driver.outputDir(), default: p.outputDir }));
  ipcMain.handle("set-output-dir", (_event, body) => {
    try {
      const dir = driver.setOutputDir(body && body.dir);
      logger.info("output.dir.set", { dir });
      return { ok: true, dir };
    } catch (e) {
      logger.warn("output.dir.set.failed", e);
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle("pick-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择图片保存目录",
      defaultPath: driver.outputDir(),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, dir: result.filePaths[0] };
  });
  ipcMain.handle("login", async () => {
    await driver.openLogin();
    return { ok: true, msg: "已打开登录页" };
  });
  ipcMain.handle("browser-toggle", async () => toggleBrowserWindow({ notify: false }));
  ipcMain.handle("browser-state", async () => {
    const current = driver;
    const visible = await current.isWindowVisible();
    refreshTrayMenu().catch(() => {});
    return { ok: true, visible, managed_browser: true };
  });
  ipcMain.handle("browser-engine", async (_event, body) => {
    const current = driver;
    const currentQueue = queue;
    if (body && body.engine && body.engine !== current.getBrowserEngine()) {
      if (currentQueue.status().active) throw new Error("正在生成中，不能切换浏览器");
      return { ok: true, engine: await currentQueue.switchBrowserEngine(body.engine) };
    }
    const engine = body && body.engine ? await current.setBrowserEngine(body.engine) : current.getBrowserEngine();
    return { ok: true, engine };
  });
  ipcMain.handle("chat-new", async () => ({ ok: true, url: await driver.openNewChat(), msg: "已新建对话" }));
  ipcMain.handle("chat-open-last", async () => ({ ok: true, url: await driver.openLastChat() }));
  ipcMain.handle("chat-status", () => ({ last_chat_url: driver.lastChatUrl, has_memory: !!driver.lastChatUrl }));
  ipcMain.handle("generate", (_event, req) => {
    if (!req || !String(req.prompt || "").trim()) throw new Error("prompt 不能为空");
    const jobs = queue.enqueueMany([{
      prompt: req.prompt,
      display_prompt: req.display_prompt || req.prompt,
      input_images: Array.isArray(req.input_images) ? req.input_images : [],
      name: req.name || null,
    }], { chatMode: "reuse", count: Math.max(1, Math.min(4, Number(req.count || 1))) });
    logger.info("queue.enqueue.single", { jobs: jobs.map((j) => j.job_id), count: jobs.length, chatMode: "reuse" });
    queue.start();
    const state = queue.status();
    const result = jobs.length > 1 ? { enqueued: jobs.length, jobs: jobs.map((j) => j.job_id) } : { job_id: jobs[0].job_id, status: jobs[0].status };
    return { ...result, queue_paused: state.paused, pause_reason: state.pause_reason };
  });
  ipcMain.handle("generate-batch", (_event, req) => {
    const prompts = req && Array.isArray(req.prompts) ? req.prompts : [];
    if (!prompts.length) throw new Error("prompts 不能为空");
    const jobs = queue.enqueueMany(prompts, { chatMode: "reuse", count: Math.max(1, Math.min(4, Number(req.count || 1))) });
    logger.info("queue.enqueue.batch", { jobs: jobs.map((j) => j.job_id), count: jobs.length, chatMode: "reuse" });
    queue.start();
    const state = queue.status();
    return { enqueued: jobs.length, jobs: jobs.map((j) => j.job_id), queue_paused: state.paused, pause_reason: state.pause_reason };
  });
  ipcMain.handle("jobs", () => ({ jobs: queue.snapshot() }));
  ipcMain.handle("queue-status", (_event, body) => (providers[body?.provider]?.queue || queue).status());
  ipcMain.handle("queue-concurrency", (_event, body) => {
    const current = providers[body?.provider]?.queue || queue;
    current.setConcurrency(body && body.concurrency);
    return current.status();
  });
  ipcMain.handle("queue-resume", (_event, body) => (providers[body?.provider]?.queue || queue).resume());
  ipcMain.handle("clear-completed-jobs", () => ({ jobs: queue.clearCompleted() }));
  ipcMain.handle("retry-job", (_event, jobId) => {
    const job = queue.retry(jobId);
    if (!job) throw new Error("任务不存在");
    return { job_id: job.job_id, status: job.status };
  });
  ipcMain.handle("retry-all-jobs", (_event, body) => {
    const current = providers[body?.provider]?.queue;
    if (!current) throw new Error("生成平台无效");
    const jobs = current.retryAll();
    return { retried: jobs.length, jobs: current.snapshot() };
  });
  ipcMain.handle("cancel-running-job", (_event, body) => {
    const current = providers[body?.provider]?.queue;
    if (!current) throw new Error("生成平台无效");
    const job = current.cancelRunning(body?.job_id);
    if (!job) throw new Error("任务不存在");
    return { job_id: job.job_id, status: job.status, stop_requested: !!job.stop_requested };
  });
  ipcMain.handle("cancel-queued-job", (_event, jobId) => {
    const job = queue.cancelQueued(jobId);
    if (!job) throw new Error("仅可停止排队中的任务");
    return { job_id: job.job_id, status: job.status };
  });
  ipcMain.handle("remove-failed-job", (_event, jobId) => {
    const job = queue.removeFailed(jobId);
    if (!job) throw new Error("仅可清除失败任务");
    return { job_id: job.job_id };
  });
  ipcMain.handle("stop-queue", () => {
    queue.stopAll();
    return { ok: true, msg: "已清空排队中的任务(正在运行的会跑完)" };
  });
  ipcMain.handle("window-minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return { ok: true };
  });
  ipcMain.handle("window-toggle-maximize", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, maximized: false };
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return { ok: true, maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle("window-close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    return { ok: true, msg: "窗口已隐藏到托盘" };
  });
  ipcMain.handle("app-exit", () => {
    requestQuit();
    return { ok: true, msg: "应用正在退出" };
  });
}

// Electron 只负责本工具界面；Chrome / Edge 登录态写入应用同级独立资料目录。
p = paths();
app.setPath("userData", path.join(p.dataRoot, "electron_runtime"));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    p = paths();
    logger.init(p.logFile);
    logger.info("app.ready", { packaged: app.isPackaged, dataRoot: p.dataRoot });
    const chatDriver = new ChatGPTDriver(p);
    const geminiPaths = { ...p, stateJson: path.join(p.configDir, "gemini_state.json"), outputDir: path.join(p.outputDir, "Gemini") };
    const geminiDriver = new GeminiDriver(geminiPaths);
    providers.chatgpt = { driver: chatDriver, queue: new QueueManager(chatDriver, { stateFile: p.queueStateJson }) };
    providers.gemini = { driver: geminiDriver, queue: new QueueManager(geminiDriver, { stateFile: path.join(p.configDir, "gemini_queue_state.json") }) };
    driver = chatDriver;
    queue = providers.chatgpt.queue;
    localApi = new LocalApi(providers, p.configDir, { defaultPort: 8765, getActiveProvider: () => activeProvider });
    for (const [provider, item] of Object.entries(providers)) {
      item.queue.on("event", event => sendQueueEvent({ ...event, provider }));
      item.driver.setPageHideWindowHandler(async () => {
        if (activeProvider === provider) await refreshTrayMenu();
        sendBrowserStateEvent({ ok: true, visible: false, provider, msg: "浏览器已完全隐藏，任务继续执行" });
      });
    }
    registerIpc();
    await createWindow();
    createTray();
    driver.init({ headless: true }).catch((e) => {
      logger.error("browser.init.background.failed", e);
      console.error("System browser init failed:", e.message || e);
    });
  });
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    if (isQuitting === "done") return;
    event.preventDefault();
    isQuitting = true;
    shutdown().finally(() => {
      isQuitting = "done";
      app.quit();
    });
  });
}
