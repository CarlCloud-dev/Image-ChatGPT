const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { spawn, execFile } = require("child_process");
const { chromium } = require("playwright-core");
const logger = require("./logger");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(text, maxLen = 30) {
  return String(text || "image")
    .replace(/[\\/:*"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, "_")
    .trim()
    .slice(0, maxLen) || "image";
}

function normalizeInputImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  const seen = new Set();
  for (const item of images) {
    const filePath = String(item || "").trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    out.push(filePath);
  }
  return out;
}

function pathExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function parseLastJsonLine(text) {
  const line = String(text || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function waitForPort(port, timeoutMs = 30000, options = {}) {
  const deadline = Date.now() + timeoutMs;
  const { child, getLaunchError, onPoll } = options;
  let lastPollAt = 0;
  while (Date.now() < deadline) {
    const launchError = getLaunchError ? getLaunchError() : null;
    if (launchError) {
      throw new Error(`Chrome 启动失败: ${launchError.message || String(launchError)}`);
    }
    if (child && child.exitCode !== null) {
      throw new Error(`Chrome 进程已退出,调试端口 ${port} 未就绪`);
    }
    if (await isPortOpen(port)) {
      await sleep(1000);
      return;
    }
    if (onPoll && Date.now() - lastPollAt > 500) {
      lastPollAt = Date.now();
      await onPoll().catch(() => {});
    }
    await sleep(300);
  }
  throw new Error(`Chrome 调试端口 ${port} 在 ${timeoutMs / 1000}s 内未就绪`);
}

async function getPortPid(port) {
  if (process.platform !== "win32") return 0;
  try {
    const { stdout } = await execFilePromise("netstat", ["-ano"], { timeout: 8000 });
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.includes(`:${port}`) || !/LISTENING/i.test(trimmed)) continue;
      const parts = trimmed.split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {
    // ignore
  }
  return 0;
}

async function findAvailablePort(startPort) {
  const base = Number(startPort) > 0 ? Number(startPort) : 9222;
  for (let offset = 0; offset < 60; offset += 1) {
    const port = base + offset;
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`未找到可用的 Chrome 调试端口(从 ${base} 开始尝试)`);
}

function detectChromePath(configured) {
  if (configured && pathExists(configured)) return configured;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  ];
  return candidates.find(pathExists) || "";
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // ignore
  }
}

function resetChromeProfileCrashFlags(profileDir) {
  const prefsPath = path.join(profileDir, "Default", "Preferences");
  const data = readJson(prefsPath, null);
  if (!data || typeof data !== "object") return;
  let changed = false;
  if (data.profile && typeof data.profile === "object") {
    if (data.profile.exit_type === "Crashed") {
      data.profile.exit_type = "Normal";
      changed = true;
    }
    if (data.profile.exited_cleanly === false) {
      data.profile.exited_cleanly = true;
      changed = true;
    }
  }
  if (changed) writeJson(prefsPath, data);
}

async function runChromeProfileScript(profileDir, action) {
  if (process.platform !== "win32") return { ok: false, pids: [] };
  const script = path.join(__dirname, "scripts", "chrome-profile.ps1");
  try {
    const { stdout } = await execFilePromise("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-ProfileDir",
      profileDir,
      "-Action",
      action,
    ], { timeout: 15000 });
    const text = stdout.trim().split(/\r?\n/).pop() || "{}";
    return JSON.parse(text);
  } catch (e) {
    return { ok: false, pids: [], error: e.message || String(e) };
  }
}

async function listChromeProfileProcesses(profileDir) {
  const result = await runChromeProfileScript(profileDir, "list");
  return {
    ...result,
    pids: Array.isArray(result.pids) ? result.pids.map((x) => Number(x)).filter(Boolean) : [],
  };
}

async function killChromeProfileProcesses(profileDir) {
  return runChromeProfileScript(profileDir, "kill");
}

async function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

class ChatGPTDriver {
  constructor(paths) {
    this.paths = paths;
    this.cfg = readJson(paths.selectorsJson, {});
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromeProc = null;
    this.chromePid = 0;
    this.cdpPort = 0;
    this.spawnedChrome = false;
    this.busy = false;
    this.windowVisible = false;
    this.outputDirValue = paths.outputDir;
    this.lastChatUrl = null;
    this.initPromise = null;
    this.lastInitError = null;
    this.browserVisibleWanted = false;
    this.hideTimers = [];
    this.loadState();
  }

  loadState() {
    const state = readJson(this.paths.stateJson, {});
    this.lastChatUrl = state.last_chat_url || null;
    if (state.output_dir && path.dirname(state.output_dir)) {
      this.outputDirValue = state.output_dir;
    }
  }

  saveState() {
    writeJson(this.paths.stateJson, {
      last_chat_url: this.lastChatUrl || null,
      output_dir: this.outputDirValue === this.paths.outputDir ? null : this.outputDirValue,
    });
  }

  setLastChatUrl(url) {
    this.lastChatUrl = url || null;
    this.saveState();
  }

  outputDir() {
    return this.outputDirValue;
  }

  setOutputDir(dir) {
    if (!dir || !String(dir).trim()) {
      this.outputDirValue = this.paths.outputDir;
    } else {
      const raw = String(dir).trim();
      this.outputDirValue = path.isAbsolute(raw) ? raw : path.join(this.paths.dataRoot, raw);
    }
    fs.mkdirSync(this.outputDirValue, { recursive: true });
    this.saveState();
    return this.outputDirValue;
  }

  list(key) {
    const block = this.cfg[key] || {};
    return Array.isArray(block.selectors) ? block.selectors : [];
  }

  timing(name, fallback) {
    return Number((this.cfg.timing || {})[name] || fallback);
  }

  hasLivePage() {
    try {
      return !!(this.browser && this.browser.isConnected() && this.context && this.page && !this.page.isClosed());
    } catch {
      return false;
    }
  }

  isInitializing() {
    return !!this.initPromise;
  }

  resetRuntimeRefs() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.windowVisible = false;
    if (this.chromeProc && this.chromeProc.exitCode !== null) {
      this.chromeProc = null;
      this.spawnedChrome = false;
    }
  }

  clearHideTimers() {
    for (const timer of this.hideTimers) {
      clearTimeout(timer);
    }
    this.hideTimers = [];
  }

  scheduleHiddenEnforcement() {
    this.clearHideTimers();
    for (const delay of [800, 2000, 4000, 7000]) {
      const timer = setTimeout(() => {
        if (!this.browserVisibleWanted && this.hasLivePage()) {
          this.hideWindow().catch(() => {});
        }
      }, delay);
      this.hideTimers.push(timer);
    }
  }

  async init({ headless = true } = {}) {
    if (this.hasLivePage()) return;
    if (this.initPromise) return this.initPromise;
    logger.info("browser.init.start", { headless });
    this.initPromise = this._init({ headless }).then(() => {
      this.lastInitError = null;
      logger.info("browser.init.done", { cdpPort: this.cdpPort, chromePid: this.chromePid });
    }).catch(async (e) => {
      this.lastInitError = e.message || String(e);
      logger.error("browser.init.failed", e);
      await this.cleanupFailedLaunch();
      throw e;
    }).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async _init({ headless = true } = {}) {
    this.resetRuntimeRefs();
    fs.mkdirSync(this.paths.profileDir, { recursive: true });
    fs.mkdirSync(this.outputDirValue, { recursive: true });

    const browserCfg = this.cfg.browser || {};
    const preferredPort = Number(browserCfg.cdp_port || 9222);
    let port = preferredPort;
    const profileProcesses = await listChromeProfileProcesses(this.paths.profileDir);
    const preferredPortOpen = await isPortOpen(preferredPort);
    logger.info("browser.port.check", {
      preferredPort,
      preferredPortOpen,
      profileProcessCount: profileProcesses.pids.length,
    });
    if (preferredPortOpen) {
      const portPid = await getPortPid(preferredPort);
      if (!profileProcesses.pids.includes(portPid)) {
        port = await findAvailablePort(preferredPort + 1);
        logger.warn("browser.port.occupied", { preferredPort, portPid, selectedPort: port });
      }
    } else if (profileProcesses.pids.length) {
      logger.warn("browser.profile.stale_processes", { count: profileProcesses.pids.length });
      await killChromeProfileProcesses(this.paths.profileDir);
      resetChromeProfileCrashFlags(this.paths.profileDir);
      await sleep(800);
    }
    this.cdpPort = port;
    if (!(await isPortOpen(port))) {
      const chromePath = detectChromePath(browserCfg.chrome_path);
      if (!chromePath) {
        throw new Error("未找到系统 Chrome。请在 config/selectors.json 配置 browser.chrome_path。");
      }
      resetChromeProfileCrashFlags(this.paths.profileDir);
      const args = [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.paths.profileDir}`,
        "--new-window",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=TranslateUI",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--disable-restore-tab-session",
        "--window-size=1280,900",
      ];
      if (headless) {
        args.push("--window-position=-32000,-32000");
      } else {
        args.push("--window-position=0,0");
      }
      let launchError = null;
      this.chromeProc = spawn(chromePath, args, {
        detached: false,
        stdio: "ignore",
        windowsHide: false,
      });
      logger.info("browser.chrome.spawned", { pid: this.chromeProc.pid || 0, port });
      this.spawnedChrome = true;
      this.chromePid = this.chromeProc.pid || 0;
      this.chromeProc.once("exit", () => {
        this.resetRuntimeRefs();
      });
      this.chromeProc.once("error", (e) => {
        launchError = e;
      });
      await waitForPort(port, Number(browserCfg.cdp_timeout_ms || 30000), {
        child: this.chromeProc,
        getLaunchError: () => launchError,
        onPoll: headless ? () => this.runWindowControl("hide") : null,
      });
      this.chromePid = await getPortPid(port) || this.chromePid;
    } else {
      this.chromePid = await getPortPid(port);
    }

    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    this.browser.on("disconnected", () => {
      this.resetRuntimeRefs();
    });
    this.context = this.browser.contexts()[0] || await this.browser.newContext();
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.on("close", () => {
      this.resetRuntimeRefs();
    });
    this.page.setDefaultTimeout(this.timing("page_load_timeout", 60) * 1000);
    const current = this.page.url() || "";
    if (!current.includes("chatgpt.com")) {
      await this.page.goto(this.lastChatUrl || this.cfg.chatgpt_url || "https://chatgpt.com/", {
        waitUntil: "domcontentloaded",
      }).catch(() => {});
    }
    if (headless) {
      this.browserVisibleWanted = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (await this.hideWindow()) break;
        await sleep(500);
      }
      this.scheduleHiddenEnforcement();
    }
  }

  async cleanupFailedLaunch() {
    logger.warn("browser.cleanup_failed_launch.start", { chromePid: this.chromePid, spawnedChrome: this.spawnedChrome });
    this.clearHideTimers();
    if (this.spawnedChrome && this.chromeProc && this.chromeProc.pid) {
      killProcessTree(this.chromeProc.pid);
    }
    await killChromeProfileProcesses(this.paths.profileDir).catch(() => {});
    resetChromeProfileCrashFlags(this.paths.profileDir);
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromeProc = null;
    this.chromePid = 0;
    this.spawnedChrome = false;
    this.windowVisible = false;
    logger.warn("browser.cleanup_failed_launch.done");
  }

  async close() {
    logger.info("browser.close.start", { chromePid: this.chromePid, spawnedChrome: this.spawnedChrome });
    this.clearHideTimers();
    try {
      if (this.context && this.page && !this.page.isClosed()) {
        const cdp = await this.context.newCDPSession(this.page);
        await cdp.send("Browser.close").catch(() => {});
      }
    } catch {
      // ignore
    }
    try {
      if (this.browser) await this.browser.close();
    } catch {
      // CDP close may fail if Chrome already exited
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    if (this.spawnedChrome && this.chromeProc) {
      const exited = await waitForProcessExit(this.chromeProc, 3000);
      if (!exited) {
        killProcessTree(this.chromeProc.pid);
      }
    }
    await killChromeProfileProcesses(this.paths.profileDir).catch(() => {});
    resetChromeProfileCrashFlags(this.paths.profileDir);
    this.chromeProc = null;
    this.chromePid = 0;
    this.spawnedChrome = false;
    this.windowVisible = false;
    logger.info("browser.close.done");
  }

  async ensurePage({ headless = true } = {}) {
    if (!this.hasLivePage()) {
      await this.init({ headless });
    }
    return this.page;
  }

  async isLoggedIn({ start = true } = {}) {
    try {
      const page = start ? await this.ensurePage() : (this.hasLivePage() ? this.page : null);
      if (!page) return false;
      const url = page.url() || "";
      return url.includes("chatgpt.com") && !url.includes("/auth/") && !url.toLowerCase().includes("login");
    } catch {
      return false;
    }
  }

  async openLogin() {
    if (this.busy) return;
    const page = await this.ensurePage({ headless: false });
    await page.goto(this.cfg.login_url || "https://chatgpt.com/auth/login", { waitUntil: "domcontentloaded" });
    await this.showWindow();
  }

  async openNewChat() {
    if (this.busy) throw new Error("正在生成中,无法新建对话");
    const page = await this.ensurePage({ headless: false });
    const url = this.cfg.new_chat_url || "https://chatgpt.com/?model=auto";
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(this.timing("after_send_settle", 2) * 1000);
    return page.url();
  }

  async openLastChat() {
    if (this.busy) throw new Error("正在生成中,无法切换对话");
    const page = await this.ensurePage();
    await page.goto(this.lastChatUrl || this.cfg.new_chat_url || "https://chatgpt.com/?model=auto", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(this.timing("after_send_settle", 2) * 1000);
    this.setLastChatUrl(page.url());
    return this.lastChatUrl;
  }

  async setChromeWindow(bounds) {
    try {
      const page = await this.ensurePage();
      const cdp = await this.context.newCDPSession(page);
      const win = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId: win.windowId, bounds });
      return true;
    } catch {
      return false;
    }
  }

  async runWindowControl(action) {
    if (process.platform !== "win32") return { ok: false, visible: false };
    if (!this.chromePid && this.cdpPort) {
      this.chromePid = await getPortPid(this.cdpPort);
    }
    const exe = path.join(__dirname, "bin", "WindowControl.exe");
    if (pathExists(exe)) {
      try {
        const { stdout } = await execFilePromise(exe, [
          "--target-pid",
          String(this.chromePid || 0),
          "--action",
          action,
        ], { timeout: 5000 });
        const result = parseLastJsonLine(stdout) || { ok: false, visible: this.windowVisible };
        if (result.ok) this.windowVisible = !!result.visible;
        return result;
      } catch (e) {
        const result = parseLastJsonLine(e.stdout);
        if (result) {
          if (result.ok) this.windowVisible = !!result.visible;
          return result;
        }
        logger.warn("window_control.exe.failed", { action, error: e.message || String(e) });
        return { ok: false, visible: this.windowVisible, error: e.message || String(e) };
      }
    }
    const script = path.join(__dirname, "scripts", "window-control.ps1");
    try {
      const { stdout } = await execFilePromise("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-TargetPid",
        String(this.chromePid || 0),
        "-ProfileDir",
        this.paths.profileDir,
        "-Action",
        action,
      ]);
      const result = parseLastJsonLine(stdout) || { ok: false, visible: this.windowVisible };
      if (result.ok) this.windowVisible = !!result.visible;
      return result;
    } catch {
      logger.warn("window_control.ps1.failed", { action });
      return { ok: false, visible: this.windowVisible };
    }
  }

  async showWindow() {
    this.browserVisibleWanted = true;
    this.clearHideTimers();
    await this.ensurePage({ headless: false });
    await this.runWindowControl("show").catch(() => {});
    await sleep(150);
    await this.setChromeWindow({ left: 0, top: 0, width: 1280, height: 900, windowState: "normal" });
    await sleep(250);
    const native = await this.runWindowControl("show");
    if (native.ok) {
      this.windowVisible = true;
      return true;
    }
    return false;
  }

  async hideWindow() {
    this.browserVisibleWanted = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const native = await this.runWindowControl("hide");
      if (native.ok) {
        await sleep(120);
        const state = await this.runWindowControl("visible");
        if (!state.ok || !state.visible) {
          this.windowVisible = false;
          return true;
        }
      }
      await sleep(180);
    }
    return false;
  }

  async isWindowVisible() {
    const native = await this.runWindowControl("visible");
    return native.ok ? !!native.visible : this.windowVisible;
  }

  async toggleWindow() {
    const currentlyVisible = await this.isWindowVisible();
    const targetVisible = !currentlyVisible;
    const ok = targetVisible ? await this.showWindow() : await this.hideWindow();
    let visible = this.windowVisible;
    const state = await this.runWindowControl("visible");
    if (state.ok) {
      visible = !!state.visible;
    } else if (ok) {
      visible = targetVisible;
    }
    this.windowVisible = visible;
    return {
      ok: ok && visible === targetVisible,
      visible,
      msg: ok && visible === targetVisible ? (visible ? "已显示浏览器窗口" : "已隐藏浏览器窗口") : "切换失败",
    };
  }

  async trySelectors(selectors, { visibleOnly = true, timeout = 4000 } = {}) {
    const page = await this.ensurePage();
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        await loc.waitFor({ state: "attached", timeout });
        if (visibleOnly) await loc.waitFor({ state: "visible", timeout });
        return { sel, loc };
      } catch {
        // try next
      }
    }
    throw new Error(`无选择器命中,试过: ${selectors.join(", ")}`);
  }

  async assertChatReady() {
    const page = await this.ensurePage();
    const url = page.url() || "";
    if (!url.includes("chatgpt.com")) {
      throw new Error(`当前页面不在 chatgpt.com(实际 URL: ${url})。请显示浏览器检查验证状态。`);
    }
    if (url.includes("/auth/") || url.toLowerCase().includes("login")) {
      throw new Error("当前在登录页,登录态已失效。请先登录 ChatGPT。");
    }
    const cf = await page.evaluate(() => {
      const text = (document.body && document.body.innerText) || "";
      return /just a moment|checking your browser|cloudflare/i.test(text) ||
        /just a moment/i.test(document.title || "");
    }).catch(() => false);
    if (cf) throw new Error("检测到 Cloudflare 验证页面。请显示浏览器手动完成验证。");
  }

  async fillComposer(text) {
    const page = await this.ensurePage();
    const cleaned = String(text || "").replace(/[\r\n]+/g, " ").replace(/ {2,}/g, " ").trim();
    if (!cleaned) throw new Error("清洗后 prompt 为空");
    const { loc } = await this.trySelectors(this.list("composer"), { timeout: 15000 });
    await loc.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Delete");
    for (let i = 0; i < cleaned.length; i += 50) {
      await page.keyboard.type(cleaned.slice(i, i + 50), { delay: 3 });
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);
  }

  async findUploadInput() {
    const page = await this.ensurePage();
    const inputSelectors = this.list("attachment_file_input").length
      ? this.list("attachment_file_input")
      : ["input[type='file'][accept*='image']", "input[type='file']"];

    for (const sel of inputSelectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) return loc;
      } catch {
        // try next
      }
    }

    for (const sel of this.list("attachment_button")) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 1000 })) {
          await loc.click();
          await page.waitForTimeout(500);
          for (const inputSel of inputSelectors) {
            const input = page.locator(inputSel).first();
            if (await input.count()) return input;
          }
        }
      } catch {
        // try next
      }
    }

    throw new Error(`找不到 ChatGPT 图片上传控件,试过: ${inputSelectors.join(", ")}`);
  }

  async waitUploadSettled(timeoutSec = 45) {
    const page = await this.ensurePage();
    const busySelectors = this.list("attachment_uploading");
    const deadline = Date.now() + timeoutSec * 1000;
    let quietRounds = 0;
    while (Date.now() < deadline) {
      let busy = false;
      for (const sel of busySelectors) {
        try {
          if (await page.locator(sel).first().isVisible({ timeout: 300 })) {
            busy = true;
            break;
          }
        } catch {
          // ignore
        }
      }
      if (!busy) {
        quietRounds += 1;
        if (quietRounds >= 2) return;
      } else {
        quietRounds = 0;
      }
      await page.waitForTimeout(700);
    }
  }

  async uploadInputImages(inputImages, progress) {
    const files = normalizeInputImages(inputImages);
    if (!files.length) return [];
    for (const filePath of files) {
      if (!path.isAbsolute(filePath) || !pathExists(filePath)) {
        throw new Error(`参考图不存在或路径不可访问: ${filePath}`);
      }
    }
    if (progress) await progress("uploading", `上传参考图 ${files.length} 张`);
    const page = await this.ensurePage();
    const input = await this.findUploadInput();
    await input.setInputFiles(files);
    await page.waitForTimeout(this.timing("after_upload_settle", 3) * 1000);
    await this.waitUploadSettled(this.timing("upload_timeout", 45));
    return files;
  }

  async clickSend() {
    const page = await this.ensurePage();
    await page.waitForTimeout(300);
    try {
      const { loc } = await this.trySelectors(this.list("send_button"), { timeout: 8000 });
      await loc.evaluate((el) => el.click());
      await page.waitForTimeout(500);
      return;
    } catch {
      await page.keyboard.press("Enter");
    }
  }

  async collectImageSrcs() {
    const page = await this.ensurePage();
    const selectors = [...this.list("image_in_message"), "img[src]"];
    const srcs = new Set();
    const seen = new Set();
    for (const sel of selectors) {
      try {
        const locs = page.locator(sel);
        const count = await locs.count();
        for (let i = 0; i < count; i += 1) {
          const src = await locs.nth(i).getAttribute("src").catch(() => "");
          if (!src || seen.has(src)) continue;
          seen.add(src);
          if (src.startsWith("data:image/svg") || src.includes("avatar") || src.includes("icon")) continue;
          if (src.startsWith("blob:") || src.startsWith("http")) srcs.add(src);
        }
      } catch {
        // ignore
      }
    }
    return srcs;
  }

  async imageLoaded(src) {
    const page = await this.ensurePage();
    const res = await page.evaluate((imageSrc) => {
      for (const img of document.querySelectorAll("img")) {
        if (img.src === imageSrc || img.getAttribute("src") === imageSrc) {
          const r = img.getBoundingClientRect();
          return { nw: img.naturalWidth, rw: Math.round(r.width) };
        }
      }
      return null;
    }, src).catch(() => null);
    return !!(res && res.nw > 0 && res.rw > 50);
  }

  async waitGeneratingDone(timeoutSec = 240) {
    const page = await this.ensurePage();
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      let visible = false;
      for (const sel of this.list("generating_indicator")) {
        try {
          if (await page.locator(sel).first().isVisible({ timeout: 500 })) {
            visible = true;
            break;
          }
        } catch {
          // ignore
        }
      }
      if (!visible) return;
      await page.waitForTimeout(this.timing("image_appear_poll_interval", 1.5) * 1000);
    }
  }

  async isGenerationFinished() {
    const page = await this.ensurePage();
    for (const sel of this.list("generating_indicator")) {
      try {
        if (await page.locator(sel).first().isVisible({ timeout: 400 })) return false;
      } catch {
        // ignore
      }
    }
    return true;
  }

  async getLastAiText() {
    const page = await this.ensurePage();
    return page.evaluate(() => {
      const selectors = [
        '[data-message-author-role="assistant"]',
        '[data-message-author="assistant"]',
        'article [class*="markdown"]',
        'div[class*="markdown"]',
        'div[class*="message"] [class*="content"]',
      ];
      let blocks = [];
      for (const s of selectors) {
        blocks = Array.from(document.querySelectorAll(s));
        if (blocks.length) break;
      }
      if (!blocks.length) blocks = Array.from(document.querySelectorAll("div"));
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const t = (blocks[i].innerText || "").trim();
        if (t.length > 15) return t.slice(0, 500);
      }
      return "";
    }).catch(() => "");
  }

  async waitForNewImage(prevSrcs) {
    const page = await this.ensurePage();
    const deadline = Date.now() + this.timing("generation_timeout", 300) * 1000;
    const noImgCheckAfter = Date.now() + 5000;
    let noImgConfirm = 0;
    while (Date.now() < deadline) {
      const srcs = await this.collectImageSrcs();
      const fresh = [...srcs].filter((s) => !prevSrcs.has(s));
      for (const src of fresh.sort()) {
        if (await this.imageLoaded(src)) {
          await this.waitGeneratingDone();
          const still = await this.collectImageSrcs();
          if (still.has(src)) return src;
        }
      }
      if (Date.now() > noImgCheckAfter) {
        const anyLoaded = await fresh.reduce(async (prev, src) => (await prev) || await this.imageLoaded(src), Promise.resolve(false));
        if (!anyLoaded && await this.isGenerationFinished()) {
          noImgConfirm += 1;
          if (noImgConfirm >= 2) {
            const aiText = await this.getLastAiText();
            if (aiText && aiText.length > 5) {
              throw new Error(`ChatGPT 未生成图片(可能提示词违规或被拒绝)。ChatGPT 回复: ${aiText.slice(0, 200)}`);
            }
          }
        } else {
          noImgConfirm = 0;
        }
      }
      await page.waitForTimeout(this.timing("image_appear_poll_interval", 1.5) * 1000);
    }
    throw new Error(`等待图片生成超时(${this.timing("generation_timeout", 300)}s)。请显示浏览器查看实际情况。`);
  }

  async downloadImage(src, jobId, idx, prompt, name) {
    const today = new Date().toISOString().slice(0, 10);
    const outDir = path.join(this.outputDirValue, today);
    fs.mkdirSync(outDir, { recursive: true });
    const base = name || sanitizeFilename(prompt, 30);
    const filename = `${String(idx).padStart(3, "0")}_${base}_${String(jobId || "xxxxxx").slice(0, 6)}.png`;
    const outPath = path.join(outDir, filename);
    const page = await this.ensurePage();
    const result = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      const b = await r.arrayBuffer();
      const bytes = new Uint8Array(b);
      let s = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return { b64: btoa(s), size: bytes.length };
    }, src);
    if (!result || result.error || !result.b64) {
      throw new Error(`下载图片失败: ${result && result.error ? result.error : src}`);
    }
    fs.writeFileSync(outPath, Buffer.from(result.b64, "base64"));
    return outPath;
  }

  async generate({ prompt, jobId, name, inputImages = [], progress }) {
    await this.ensurePage();
    this.busy = true;
    const start = Date.now();
    logger.info("generate.start", { jobId, hasName: !!name, inputImageCount: normalizeInputImages(inputImages).length });
    try {
      if (progress) await progress("ready", "准备输入");
      await this.page.waitForTimeout(this.timing("after_send_settle", 2) * 1000);
      await this.assertChatReady();
      const uploadedImages = await this.uploadInputImages(inputImages, progress);
      if (progress) await progress("typing", "输入提示词");
      await this.fillComposer(prompt);
      const prevSrcs = await this.collectImageSrcs();
      if (progress) await progress("sending", "发送");
      await this.clickSend();
      if (progress) await progress("generating", "等待图片生成");
      const src = await this.waitForNewImage(prevSrcs);
      const saved = await this.downloadImage(src, jobId, 1, prompt, name);
      if (progress) await progress("image_done", "已保存图片");
      this.setLastChatUrl(this.page.url());
      logger.info("generate.done", { jobId, imageCount: 1, elapsed: (Date.now() - start) / 1000 });
      return { success: true, image_paths: [saved], input_images: uploadedImages, elapsed: (Date.now() - start) / 1000 };
    } catch (e) {
      logger.error("generate.failed", { jobId, error: e.message || String(e), elapsed: (Date.now() - start) / 1000 });
      return { success: false, error: e.message || String(e), elapsed: (Date.now() - start) / 1000 };
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { ChatGPTDriver };
