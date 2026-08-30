const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, Tray } = require("electron");
const { paths, fileUrl } = require("./paths");
const { ChatGPTDriver } = require("./chatgptDriver");
const { QueueManager } = require("./queueManager");
const logger = require("./logger");

let mainWindow = null;
let tray = null;
let isQuitting = false;
let driver = null;
let queue = null;
let p = null;

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
      label: browserVisible ? "隐藏 ChatGPT 浏览器" : "显示 ChatGPT 浏览器",
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
  logger.info("browser.toggle.request", { notify });
  const result = await driver.toggleWindow();
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
  if (queue) queue.stop();
  if (driver) await driver.close();
  logger.info("app.shutdown.done");
}

function requestQuit() {
  logger.info("app.quit.request");
  isQuitting = true;
  setTimeout(() => app.quit(), 80);
}

function registerIpc() {
  ipcMain.handle("file-url", (_event, filePath) => fileUrl(filePath));
  ipcMain.handle("styles", () => loadStyles());
  ipcMain.handle("health", async () => ({
    ok: true,
    driver_ready: driver.hasLivePage(),
    initializing: driver.isInitializing(),
    logged_in: await driver.isLoggedIn({ start: false }),
    last_error: driver.lastInitError,
    login_url: driver.cfg.login_url,
    page_url: driver.pageUrl() || null,
  }));
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
    const visible = await driver.isWindowVisible();
    refreshTrayMenu().catch(() => {});
    return { ok: true, visible, managed_browser: true };
  });
  ipcMain.handle("browser-engine", async (_event, body) => {
    const engine = body && body.engine ? await driver.setBrowserEngine(body.engine) : driver.getBrowserEngine();
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
    }], { chatMode: req.chat_mode || "new", count: Math.max(1, Math.min(4, Number(req.count || 1))) });
    logger.info("queue.enqueue.single", { jobs: jobs.map((j) => j.job_id), count: jobs.length, chatMode: req.chat_mode || "new" });
    queue.start();
    return jobs.length > 1 ? { enqueued: jobs.length, jobs: jobs.map((j) => j.job_id) } : { job_id: jobs[0].job_id, status: jobs[0].status };
  });
  ipcMain.handle("generate-batch", (_event, req) => {
    const prompts = req && Array.isArray(req.prompts) ? req.prompts : [];
    if (!prompts.length) throw new Error("prompts 不能为空");
    const jobs = queue.enqueueMany(prompts, { chatMode: req.chat_mode || "new", count: Math.max(1, Math.min(4, Number(req.count || 1))) });
    logger.info("queue.enqueue.batch", { jobs: jobs.map((j) => j.job_id), count: jobs.length, chatMode: req.chat_mode || "new" });
    queue.start();
    return { enqueued: jobs.length, jobs: jobs.map((j) => j.job_id) };
  });
  ipcMain.handle("jobs", () => ({ jobs: queue.snapshot() }));
  ipcMain.handle("clear-completed-jobs", () => ({ jobs: queue.clearCompleted() }));
  ipcMain.handle("retry-job", (_event, jobId) => {
    const job = queue.retry(jobId);
    if (!job) throw new Error("任务不存在");
    return { job_id: job.job_id, status: job.status };
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
    driver = new ChatGPTDriver(p);
    driver.setPageHideWindowHandler(async () => {
      await refreshTrayMenu();
      sendBrowserStateEvent({ ok: true, visible: false, msg: "浏览器已完全隐藏，任务继续执行" });
    });
    queue = new QueueManager(driver, { stateFile: p.queueStateJson });
    queue.on("event", sendQueueEvent);
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
