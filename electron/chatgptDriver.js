const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const logger = require("./logger");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(text, maxLen = 30) {
  return String(text || "image")
    .replace(/[\\/:*\"<>|\r\n\t]/g, "_")
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

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(450);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function findFreePort(preferredPort) {
  const start = Math.max(1024, positiveInt(preferredPort, 9222));
  for (let port = start; port < start + 60; port += 1) {
    if (!(await canConnect(port))) return port;
  }
  throw new Error(`找不到可用的 Chrome 调试端口（从 ${start} 开始）`);
}

async function waitForPort(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    // Edge's compatibility launcher can exit successfully after handing off to
    // the real browser process. Keep waiting for that process to expose CDP.
    await sleep(250);
  }
  const exitNote = child.exitCode !== null && child.exitCode !== undefined ? `（启动器退出代码 ${child.exitCode}）` : "";
  throw new Error(`浏览器未在 ${Math.round(timeoutMs / 1000)} 秒内启动 ${exitNote}`.trim());
}

function normalizeBrowserEngine(value) {
  return String(value || "").trim().toLowerCase() === "edge" ? "edge" : "chrome";
}

function browserLabel(engine) {
  return engine === "edge" ? "Microsoft Edge" : "Google Chrome";
}

function isChatGptUrl(url) {
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

function isLoginOrChallengeUrl(url) {
  const value = String(url || "").toLowerCase();
  return value.includes("/auth/") || value.includes("login") || value.includes("/cdn-cgi/");
}

function findBrowserExecutable(engine, browserCfg) {
  const explicitPath = String(
    browserCfg[`${engine}_path`] || process.env[`IMAGE_CHATGPT_${engine.toUpperCase()}_PATH`] || "",
  ).trim();
  const appFolder = engine === "edge" ? ["Microsoft", "Edge", "Application", "msedge.exe"] : ["Google", "Chrome", "Application", "chrome.exe"];
  const candidates = [
    explicitPath,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, ...appFolder),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, ...appFolder),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], ...appFolder),
  ].filter(Boolean);
  return candidates.find((candidate) => pathExists(candidate)) || null;
}

class ChatGPTDriver {
  constructor(paths) {
    this.paths = paths;
    this.cfg = readJson(paths.selectorsJson, {});
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdpSession = null;
    this.browserProcess = null;
    this.cdpPort = null;
    this.nativeWindowHandles = [];
    this.pageControlsReadyFor = null;
    this.onPageHideWindow = null;
    this.busy = false;
    this.windowVisible = false;
    this.outputDirValue = paths.outputDir;
    this.lastChatUrl = null;
    this.initPromise = null;
    this.lastInitError = null;
    this.browserVisibleWanted = false;
    this.loadState();
  }

  loadState() {
    const state = readJson(this.paths.stateJson, {});
    this.lastChatUrl = state.last_chat_url || null;
    this.browserEngine = normalizeBrowserEngine(state.browser_engine || this.browserConfig().engine);
    if (state.output_dir && path.dirname(state.output_dir)) {
      this.outputDirValue = state.output_dir;
    }
  }

  saveState() {
    writeJson(this.paths.stateJson, {
      last_chat_url: this.lastChatUrl || null,
      browser_engine: this.browserEngine,
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

  browserConfig() {
    return this.cfg.browser || {};
  }

  browserProfileDir(engine = this.browserEngine) {
    // Keep the original Chrome profile location for backward compatibility.
    return engine === "edge" ? path.join(this.paths.dataRoot, "browser_profile_edge") : this.paths.profileDir;
  }

  getBrowserEngine() {
    return this.browserEngine;
  }

  async setBrowserEngine(engine) {
    const next = normalizeBrowserEngine(engine);
    if (next === this.browserEngine) return next;
    if (this.busy) throw new Error("正在生成中，不能切换浏览器");
    if (this.isInitializing()) throw new Error("浏览器正在启动，请稍后再切换");
    if (this.hasLivePage()) await this.close();
    this.browserEngine = next;
    this.saveState();
    logger.info("system_browser.engine.changed", { engine: next });
    return next;
  }

  setPageHideWindowHandler(handler) {
    this.onPageHideWindow = typeof handler === "function" ? handler : null;
  }

  pageUrl() {
    return this.page && !this.page.isClosed() ? this.page.url() : "";
  }

  hasLivePage() {
    return !!(
      this.browser && this.browser.isConnected() && this.context && this.page && !this.page.isClosed()
    );
  }

  isInitializing() {
    return !!this.initPromise;
  }

  resetRuntimeRefs() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdpSession = null;
    this.cdpPort = null;
    this.nativeWindowHandles = [];
    this.pageControlsReadyFor = null;
    this.windowVisible = false;
  }

  browserWindowBounds() {
    const browserCfg = this.browserConfig();
    return {
      width: Math.min(1920, Math.max(800, positiveInt(browserCfg.window_width, 1080))),
      height: Math.min(1400, Math.max(560, positiveInt(browserCfg.window_height, 760))),
    };
  }

  async setupPageWindowControls() {
    const page = this.page;
    if (!page || page.isClosed() || this.pageControlsReadyFor === page) return;
    await page.exposeBinding("__imageChatGptHideWindow", async ({ page: sourcePage, frame }) => {
      if (sourcePage !== this.page || frame !== sourcePage.mainFrame() || !isChatGptUrl(sourcePage.url())) {
        return { ok: false, msg: "只允许从受控 ChatGPT 页面隐藏窗口" };
      }
      const hidden = await this.hideWindow();
      if (hidden && this.onPageHideWindow) await this.onPageHideWindow();
      return {
        ok: hidden,
        msg: hidden ? "浏览器已完全隐藏，任务继续执行" : "隐藏浏览器失败",
      };
    });
    page.on("domcontentloaded", () => {
      this.installPageWindowControls().catch((error) => {
        logger.warn("system_browser.page_hide_button_install_failed", error);
      });
    });
    this.pageControlsReadyFor = page;
    await this.installPageWindowControls();
  }

  async ensureAuthenticatedPageWindowControls() {
    const page = this.page;
    if (!page || page.isClosed()) return false;
    if (this.pageControlsReadyFor === page) return this.installPageWindowControls();
    if (!(await this.isLoggedIn({ start: false }))) return false;
    await this.setupPageWindowControls();
    return this.installPageWindowControls();
  }

  async installPageWindowControls() {
    const page = this.page;
    if (!page || page.isClosed() || !isChatGptUrl(page.url()) || isLoginOrChallengeUrl(page.url())) return false;
    try {
      return await page.evaluate(() => {
        const rootId = "__image_chatgpt_hide_window_control__";
        const existing = document.getElementById(rootId);
        if (existing) {
          if (typeof existing.__imageChatGptReset === "function") existing.__imageChatGptReset();
          return true;
        }
        if (typeof window.__imageChatGptHideWindow !== "function") return false;

        const host = document.createElement("div");
        host.id = rootId;
        host.setAttribute("aria-label", "Image-ChatGPT 窗口控制");
        host.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:auto;";
        const shadow = host.attachShadow({ mode: "closed" });
        const bar = document.createElement("div");
        bar.style.cssText = [
          "display:flex", "align-items:center", "gap:10px", "min-height:42px", "padding:4px 5px 4px 13px",
          "border:1px solid rgba(96,165,250,.36)", "border-radius:12px", "background:rgba(17,24,39,.96)",
          "color:#e5e7eb", "font:500 13px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
          "box-shadow:0 8px 26px rgba(0,0,0,.32)", "backdrop-filter:blur(10px)",
        ].join(";");
        const reminder = document.createElement("span");
        reminder.textContent = "任务运行中，请勿点右上角关闭";
        reminder.title = "关闭浏览器会中断当前网页任务";
        reminder.style.cssText = "white-space:nowrap;";
        const divider = document.createElement("span");
        divider.setAttribute("aria-hidden", "true");
        divider.style.cssText = "width:1px;height:20px;background:rgba(148,163,184,.32);";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "隐藏窗口";
        button.title = "隐藏浏览器窗口，当前任务继续在后台执行";
        button.setAttribute("aria-label", button.title);
        button.style.cssText = [
          "height:34px", "padding:0 14px", "border:1px solid rgba(191,219,254,.6)",
          "border-radius:8px", "background:linear-gradient(135deg,#2563eb,#4f46e5)", "color:#fff",
          "font:700 13px/32px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
          "cursor:pointer", "box-shadow:0 2px 10px rgba(37,99,235,.38)",
        ].join(";");
        const resetButton = () => {
          button.disabled = false;
          button.style.cursor = "pointer";
          button.style.background = "linear-gradient(135deg,#2563eb,#4f46e5)";
          button.textContent = "隐藏窗口";
        };
        host.__imageChatGptReset = resetButton;
        button.addEventListener("mouseenter", () => { button.style.background = "linear-gradient(135deg,#1d4ed8,#4338ca)"; });
        button.addEventListener("mouseleave", () => { if (!button.disabled) button.style.background = "linear-gradient(135deg,#2563eb,#4f46e5)"; });
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (button.disabled) return;
          button.disabled = true;
          button.style.cursor = "wait";
          button.textContent = "正在隐藏…";
          try {
            const result = await window.__imageChatGptHideWindow();
            if (!result || !result.ok) throw new Error((result && result.msg) || "隐藏失败");
          } catch (error) {
            button.disabled = false;
            button.style.cursor = "pointer";
            button.style.background = "#7f1d1d";
            button.textContent = "重试隐藏";
            setTimeout(() => {
              if (!button.disabled) {
                button.style.background = "linear-gradient(135deg,#2563eb,#4f46e5)";
                button.textContent = "隐藏窗口";
              }
            }, 1800);
          }
        });
        bar.append(reminder, divider, button);
        shadow.appendChild(bar);
        document.documentElement.appendChild(host);
        return true;
      });
    } catch (error) {
      if (!page.isClosed()) logger.warn("system_browser.page_hide_button_install_failed", error);
      return false;
    }
  }

  async init({ headless = true } = {}) {
    if (this.hasLivePage()) return;
    if (this.initPromise) return this.initPromise;
    logger.info("system_browser.init.start", { engine: this.browserEngine, hidden: headless });
    this.initPromise = this._init({ headless }).then(() => {
      this.lastInitError = null;
      logger.info("system_browser.init.done", { engine: this.browserEngine });
    }).catch(async (e) => {
      this.lastInitError = e.message || String(e);
      logger.error("system_browser.init.failed", e);
      await this.cleanupFailedLaunch();
      throw e;
    }).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async _init({ headless = true } = {}) {
    fs.mkdirSync(this.outputDirValue, { recursive: true });
    const browserCfg = this.browserConfig();
    const engine = this.browserEngine;
    const label = browserLabel(engine);
    const profileDir = this.browserProfileDir(engine);
    fs.mkdirSync(profileDir, { recursive: true });
    const executablePath = findBrowserExecutable(engine, browserCfg);
    if (!executablePath) {
      throw new Error(`未找到 ${label}。请安装它，或在 config/selectors.json 的 browser.${engine}_path 中填写可执行文件的完整路径。`);
    }
    const bounds = this.browserWindowBounds();
    const port = await findFreePort(browserCfg.cdp_port);
    const initialUrl = this.lastChatUrl || this.cfg.chatgpt_url || "https://chatgpt.com/";
    const position = headless ? "-32000,-32000" : "50,50";
    const args = [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--new-window",
      `--window-size=${bounds.width},${bounds.height}`,
      `--window-position=${position}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=TranslateUI",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--disable-restore-tab-session",
    ];
    const child = spawn(executablePath, args, { stdio: "ignore", windowsHide: false });
    this.browserProcess = child;
    child.once("error", (error) => {
      this.lastInitError = `${label} 无法启动: ${error.message || String(error)}`;
      logger.error("system_browser.process.error", error);
    });
    child.once("exit", (code, signal) => {
      logger.info("system_browser.process.exit", { engine, code, signal });
      if (this.browserProcess === child && !this.hasLivePage()) this.resetRuntimeRefs();
    });
    await waitForPort(port, child, positiveInt(browserCfg.cdp_timeout_ms, 30000));
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: positiveInt(browserCfg.cdp_timeout_ms, 30000),
    });
    this.browser.on("disconnected", () => {
      logger.info("system_browser.disconnected", { engine });
      if (this.browser && !this.browser.isConnected()) this.resetRuntimeRefs();
    });
    this.context = this.browser.contexts()[0] || await this.browser.newContext();
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(this.timing("selector_timeout_ms", 15000));
    this.cdpPort = port;
    const current = this.pageUrl();
    if (!current.includes("chatgpt.com")) {
      await this.goto(initialUrl);
    }
    await this.ensureAuthenticatedPageWindowControls();
    this.browserVisibleWanted = !headless;
    this.windowVisible = !headless;
    if (headless) await this.hideWindow();
    logger.info("system_browser.process.started", { engine, executablePath, profileDir, port, ...bounds, hidden: headless });
  }

  async cleanupFailedLaunch() {
    logger.warn("system_browser.cleanup_failed_launch.start");
    await this.closeRemoteBrowser();
    if (this.browserProcess && this.browserProcess.exitCode === null) this.browserProcess.kill();
    this.browserProcess = null;
    this.resetRuntimeRefs();
    logger.warn("system_browser.cleanup_failed_launch.done");
  }

  async close() {
    logger.info("system_browser.close.start");
    await this.closeRemoteBrowser();
    if (this.browserProcess && this.browserProcess.exitCode === null) this.browserProcess.kill();
    this.browserProcess = null;
    this.resetRuntimeRefs();
    logger.info("system_browser.close.done");
  }

  async closeRemoteBrowser() {
    let session = this.cdpSession;
    if (!session && this.context && this.page && !this.page.isClosed()) {
      session = await this.context.newCDPSession(this.page).catch(() => null);
    }
    // Playwright's Browser.close() only disconnects when attached through CDP.
    // Ask the browser itself to exit first, which is required for Edge's launcher.
    if (session) await session.send("Browser.close").catch(() => {});
    await this.detachDebugger();
    const browser = this.browser;
    if (browser && browser.isConnected()) await browser.close().catch(() => {});
  }

  async ensurePage({ headless = true } = {}) {
    if (!this.hasLivePage()) await this.init({ headless });
    return this.page;
  }

  async goto(url) {
    const page = await this.ensurePage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      if (!this.pageUrl()) throw e;
      logger.warn("system_browser.navigate.interrupted", { url, error: e.message || String(e) });
    }
    await this.ensureAuthenticatedPageWindowControls();
    return this.pageUrl();
  }

  async evaluate(fn, ...args) {
    const page = await this.ensurePage();
    const serializedArgs = JSON.stringify(args).replace(/</g, "\\u003c");
    return page.evaluate(`(${fn.toString()})(...${serializedArgs})`);
  }

  async ensureDebugger() {
    const page = await this.ensurePage();
    if (!this.cdpSession) {
      this.cdpSession = await this.context.newCDPSession(page);
      logger.info("system_browser.cdp.attached", { engine: this.browserEngine });
    }
    return this.cdpSession;
  }

  async detachDebugger() {
    const session = this.cdpSession;
    this.cdpSession = null;
    if (session) await session.detach().catch(() => {});
  }

  async sendDevToolsCommand(method, params = {}) {
    const session = await this.ensureDebugger();
    return session.send(method, params);
  }

  async trySelectors(selectors, { visibleOnly = true, timeout = 4000 } = {}) {
    const deadline = Date.now() + timeout;
    do {
      for (const sel of selectors) {
        try {
          const state = await this.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!el) return { found: false, visible: false };
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
              found: true,
              visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0,
            };
          }, sel);
          if (state && state.found && (!visibleOnly || state.visible)) return { sel };
        } catch {
          // Invalid or stale selector; continue with the next candidate.
        }
      }
      if (Date.now() < deadline) await sleep(180);
    } while (Date.now() < deadline);
    throw new Error(`无选择器命中,试过: ${selectors.join(", ")}`);
  }

  async tryEnabledSelectors(selectors, { timeout = 4000 } = {}) {
    const deadline = Date.now() + timeout;
    do {
      for (const sel of selectors) {
        try {
          const state = await this.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!el) return { found: false, ready: false };
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
            const disabled = Boolean(el.disabled)
              || el.hasAttribute("disabled")
              || el.getAttribute("aria-disabled") === "true"
              || el.getAttribute("data-state") === "disabled"
              || style.pointerEvents === "none";
            return { found: true, ready: visible && !disabled };
          }, sel);
          if (state && state.found && state.ready) return { sel };
        } catch {
          // Invalid or stale selector; continue with the next candidate.
        }
      }
      if (Date.now() < deadline) await sleep(180);
    } while (Date.now() < deadline);
    throw new Error(`无可用选择器命中,试过: ${selectors.join(", ")}`);
  }

  async isSelectorVisible(selector) {
    try {
      const state = await this.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      }, selector);
      return !!state;
    } catch {
      return false;
    }
  }

  async elementExists(selector) {
    try {
      return !!(await this.evaluate((sel) => !!document.querySelector(sel), selector));
    } catch {
      return false;
    }
  }

  async elementBox(selector) {
    return this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, selector);
  }

  async clickSelector(selector) {
    const box = await this.elementBox(selector);
    if (!box) throw new Error(`元素不可点击: ${selector}`);
    try {
      await this.sendDevToolsCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await this.sendDevToolsCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await this.sendDevToolsCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      return;
    } catch (e) {
      logger.warn("system_browser.mouse_input.fallback", { selector, error: e.message || String(e) });
    }
    const clicked = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      el.click();
      return true;
    }, selector);
    if (!clicked) throw new Error(`元素不可点击: ${selector}`);
  }

  async dispatchKey(key, code, keyCode, modifiers = 0) {
    await this.sendDevToolsCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await this.sendDevToolsCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  }

  async typeText(selector, text) {
    await this.clickSelector(selector);
    try {
      await this.dispatchKey("a", "KeyA", 65, 2);
      await this.dispatchKey("Delete", "Delete", 46);
      for (let i = 0; i < text.length; i += 50) {
        await this.sendDevToolsCommand("Input.insertText", { text: text.slice(i, i + 50) });
        await sleep(30);
      }
      const actual = await this.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? String(el.innerText || el.textContent || "").trim() : "";
      }, selector);
      if (actual.includes(text.slice(0, Math.min(text.length, 20)))) return;
    } catch (e) {
      logger.warn("system_browser.keyboard_input.fallback", { selector, error: e.message || String(e) });
    }

    const inserted = await this.evaluate((sel, value) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      const ok = document.execCommand("insertText", false, value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return ok || String(el.innerText || el.textContent || "").includes(value.slice(0, 20));
    }, selector, text);
    if (!inserted) throw new Error("ChatGPT 输入框未接受提示词，请显示浏览器检查页面状态。");
    const actual = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? String(el.innerText || el.textContent || el.value || "").trim() : "";
    }, selector);
    if (!actual.includes(text.slice(0, Math.min(text.length, 20)))) {
      throw new Error("ChatGPT 输入框未写入提示词，请显示浏览器检查页面状态。");
    }
  }

  async isLoggedIn({ start = true } = {}) {
    try {
      if (start) await this.ensurePage();
      if (!this.hasLivePage()) return false;
      const url = this.pageUrl();
      if (!url.includes("chatgpt.com") || url.includes("/auth/") || url.toLowerCase().includes("login")) {
        return false;
      }
      const state = await this.evaluate((composerSelectors, loggedOutSelectors) => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        };
        const hasVisible = (selectors) => selectors.some((selector) => {
          try {
            return Array.from(document.querySelectorAll(selector)).some(isVisible);
          } catch {
            return false;
          }
        });
        const loggedOutButton = Array.from(document.querySelectorAll("a, button")).some((el) => {
          if (!isVisible(el)) return false;
          return /^(log in|sign up|登录|注册)$/i.test((el.innerText || el.textContent || "").trim());
        });
        return {
          hasComposer: hasVisible(composerSelectors),
          hasLoggedOutControl: hasVisible(loggedOutSelectors) || loggedOutButton,
        };
      }, this.list("composer"), this.list("logged_out_indicator"));
      return !!(state && state.hasComposer && !state.hasLoggedOutControl);
    } catch {
      return false;
    }
  }

  async openLogin() {
    if (this.busy) return;
    this.browserVisibleWanted = true;
    await this.ensurePage({ headless: false });
    await this.showWindow();
    await this.goto(this.cfg.login_url || "https://chatgpt.com/auth/login");
  }

  async openNewChat() {
    if (this.busy) throw new Error("正在生成中,无法新建对话");
    await this.ensurePage({ headless: false });
    const url = this.cfg.new_chat_url || "https://chatgpt.com/?model=auto";
    await this.goto(url);
    await sleep(this.timing("after_send_settle", 2) * 1000);
    return this.pageUrl();
  }

  async openLastChat() {
    if (this.busy) throw new Error("正在生成中,无法切换对话");
    await this.ensurePage();
    await this.goto(this.lastChatUrl || this.cfg.new_chat_url || "https://chatgpt.com/?model=auto");
    await sleep(this.timing("after_send_settle", 2) * 1000);
    this.setLastChatUrl(this.pageUrl());
    return this.lastChatUrl;
  }

  async chromiumWindowId() {
    const target = await this.sendDevToolsCommand("Browser.getWindowForTarget");
    if (!target || !target.windowId) throw new Error("无法取得 Chromium 窗口");
    return target.windowId;
  }

  async setChromiumWindowBounds(bounds) {
    const windowId = await this.chromiumWindowId();
    await this.sendDevToolsCommand("Browser.setWindowBounds", { windowId, bounds });
  }

  async nativeWindowAction(action, handles = []) {
    const script = path.join(__dirname, "browserNativeWindow.ps1");
    if (!pathExists(script)) return { ok: false, handles: [], changed: 0, error: "未找到原生窗口控制脚本" };
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action];
    if (action === "capture") {
      args.push("-ProfileDir", this.browserProfileDir());
    } else if (handles.length) {
      args.push("-Handles", ...handles.map((value) => String(value)));
    }
    return new Promise((resolve) => {
      const child = spawn(pathExists(executable) ? executable : "powershell.exe", args, { windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
      child.once("error", (error) => resolve({ ok: false, handles: [], changed: 0, error: error.message || String(error) }));
      child.once("close", () => {
        try {
          const result = JSON.parse(output.trim());
          resolve({
            ok: !!result.ok,
            handles: Array.isArray(result.handles) ? result.handles.map((value) => Number(value)).filter(Boolean) : [],
            changed: Number(result.changed || 0),
            error: result.error || "",
          });
        } catch {
          resolve({ ok: false, handles: [], changed: 0, error: "原生窗口控制没有返回有效结果" });
        }
      });
    });
  }

  async hideNativeBrowserWindow() {
    const captured = await this.nativeWindowAction("capture");
    if (captured.ok && captured.handles.length) this.nativeWindowHandles = captured.handles;
    if (!this.nativeWindowHandles.length) return false;
    const result = await this.nativeWindowAction("hide", this.nativeWindowHandles);
    if (!result.ok) logger.warn("system_browser.native_hide_failed", result);
    return result.ok && result.changed > 0;
  }

  async showNativeBrowserWindow() {
    if (!this.nativeWindowHandles.length) return false;
    const result = await this.nativeWindowAction("show", this.nativeWindowHandles);
    if (!result.ok) logger.warn("system_browser.native_show_failed", result);
    return result.ok && result.changed > 0;
  }

  async showWindow() {
    this.browserVisibleWanted = true;
    await this.ensurePage({ headless: false });
    const bounds = this.browserWindowBounds();
    try {
      await this.setChromiumWindowBounds({
        left: 50,
        top: 50,
        width: bounds.width,
        height: bounds.height,
        windowState: "normal",
      });
      await this.showNativeBrowserWindow();
      this.windowVisible = true;
      await this.ensureAuthenticatedPageWindowControls();
      return true;
    } catch (e) {
      logger.warn("system_browser.window.show_failed", e);
      return false;
    }
  }

  async hideWindow() {
    this.browserVisibleWanted = false;
    if (!this.hasLivePage()) return false;
    const bounds = this.browserWindowBounds();
    try {
      await this.setChromiumWindowBounds({
        left: -32000,
        top: -32000,
        width: bounds.width,
        height: bounds.height,
        windowState: "normal",
      });
      await this.hideNativeBrowserWindow();
      this.windowVisible = false;
      return true;
    } catch (e) {
      logger.warn("system_browser.window.hide_failed", e);
      return false;
    }
  }

  async isWindowVisible() {
    if (!this.hasLivePage()) {
      this.windowVisible = false;
      return false;
    }
    try {
      const windowId = await this.chromiumWindowId();
      const { bounds } = await this.sendDevToolsCommand("Browser.getWindowBounds", { windowId });
      this.windowVisible = !!(
        bounds && bounds.windowState !== "minimized" &&
        // Chromium clamps an off-screen -32000 request to roughly -26214 on Windows.
        Number(bounds.left) > -20000 && Number(bounds.top) > -20000
      );
    } catch {
      this.windowVisible = false;
    }
    return this.windowVisible;
  }

  async toggleWindow() {
    const targetVisible = !(await this.isWindowVisible());
    const ok = targetVisible ? await this.showWindow() : await this.hideWindow();
    const visible = await this.isWindowVisible();
    return {
      ok: ok && visible === targetVisible,
      visible,
      msg: ok && visible === targetVisible ? (visible ? "已显示浏览器" : "浏览器已完全隐藏，任务继续执行") : "切换失败",
    };
  }

  async assertChatReady() {
    await this.ensurePage();
    const url = this.pageUrl();
    if (!url.includes("chatgpt.com")) {
      throw new Error(`当前页面不在 chatgpt.com(实际 URL: ${url})。请显示浏览器检查验证状态。`);
    }
    if (url.includes("/auth/") || url.toLowerCase().includes("login")) {
      throw new Error("当前在登录页,登录态已失效。请先登录 ChatGPT。");
    }
    const cf = await this.evaluate(() => {
      const text = (document.body && document.body.innerText) || "";
      return /just a moment|checking your browser|cloudflare/i.test(text) || /just a moment/i.test(document.title || "");
    }).catch(() => false);
    if (cf) throw new Error("检测到 Cloudflare 验证页面。请显示浏览器手动完成验证。");
    await this.ensureAuthenticatedPageWindowControls();
  }

  async composerInteractionState() {
    return this.evaluate((composerSelectors) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      };
      for (const selector of composerSelectors) {
        const el = document.querySelector(selector);
        if (!isVisible(el)) continue;
        const style = window.getComputedStyle(el);
        const disabled = Boolean(el.disabled)
          || el.hasAttribute("disabled")
          || el.getAttribute("aria-disabled") === "true"
          || el.getAttribute("contenteditable") === "false"
          || el.readOnly === true
          || style.pointerEvents === "none";
        return {
          documentReady: document.readyState === "interactive" || document.readyState === "complete",
          hasComposer: true,
          writable: !disabled,
        };
      }
      return {
        documentReady: document.readyState === "interactive" || document.readyState === "complete",
        hasComposer: false,
        writable: false,
      };
    }, this.list("composer")).catch(() => ({ documentReady: false, hasComposer: false, writable: false }));
  }

  async waitForChatPageReady({ timeoutSec, minWaitSec = 0, stableRounds } = {}) {
    await this.assertChatReady();
    const timeout = Math.max(10, Number(timeoutSec) || this.timing("page_ready_timeout", 45));
    const pollMs = Math.max(250, this.timing("page_ready_poll_interval", 0.75) * 1000);
    const requiredStableRounds = Math.max(2, Math.floor(Number(stableRounds) || this.timing("page_ready_stable_rounds", 3)));
    const deadline = Date.now() + timeout * 1000;
    const notBefore = Date.now() + Math.max(0, Number(minWaitSec) || 0) * 1000;
    let readyRounds = 0;
    let lastState = null;

    while (Date.now() < deadline) {
      const state = await this.composerInteractionState();
      const finished = await this.isGenerationFinished();
      lastState = { ...state, finished };
      if (Date.now() >= notBefore && state.documentReady && state.hasComposer && state.writable && finished) {
        readyRounds += 1;
        if (readyRounds >= requiredStableRounds) return;
      } else {
        readyRounds = 0;
      }
      await sleep(pollMs);
    }
    const detail = lastState
      ? `documentReady=${lastState.documentReady}, composer=${lastState.hasComposer}, writable=${lastState.writable}, generationFinished=${lastState.finished}`
      : "无法读取页面状态";
    throw new Error(`ChatGPT 页面尚未恢复到可继续处理任务的状态(${detail})。请显示浏览器检查页面。`);
  }

  async fillComposer(text) {
    const cleaned = String(text || "").replace(/[\r\n]+/g, " ").replace(/ {2,}/g, " ").trim();
    if (!cleaned) throw new Error("清洗后 prompt 为空");
    const { sel } = await this.trySelectors(this.list("composer"), { timeout: 15000 });
    await this.typeText(sel, cleaned);
    await sleep(300);
  }

  async findUploadInput() {
    const inputSelectors = this.list("attachment_file_input").length
      ? this.list("attachment_file_input")
      : ["input[type='file'][accept*='image']", "input[type='file']"];
    for (const sel of inputSelectors) {
      if (await this.elementExists(sel)) return sel;
    }

    for (const sel of this.list("attachment_button")) {
      try {
        if (!(await this.isSelectorVisible(sel))) continue;
        await this.clickSelector(sel);
        await sleep(500);
        for (const inputSel of inputSelectors) {
          if (await this.elementExists(inputSel)) return inputSel;
        }
      } catch {
        // Try the next attachment control.
      }
    }
    throw new Error(`找不到 ChatGPT 图片上传控件,试过: ${inputSelectors.join(", ")}`);
  }

  async setFileInputFiles(selector, files) {
    const documentNode = await this.sendDevToolsCommand("DOM.getDocument", { depth: 1, pierce: true });
    const node = await this.sendDevToolsCommand("DOM.querySelector", {
      nodeId: documentNode.root.nodeId,
      selector,
    });
    if (!node || !node.nodeId) throw new Error(`找不到文件上传元素: ${selector}`);
    await this.sendDevToolsCommand("DOM.setFileInputFiles", { files, nodeId: node.nodeId });
  }

  async waitUploadSettled(timeoutSec = 45) {
    const busySelectors = this.list("attachment_uploading");
    const deadline = Date.now() + timeoutSec * 1000;
    let quietRounds = 0;
    while (Date.now() < deadline) {
      let busy = false;
      for (const sel of busySelectors) {
        if (await this.isSelectorVisible(sel)) {
          busy = true;
          break;
        }
      }
      if (!busy) {
        quietRounds += 1;
        if (quietRounds >= 2) return;
      } else {
        quietRounds = 0;
      }
      await sleep(700);
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
    const inputSelector = await this.findUploadInput();
    await this.setFileInputFiles(inputSelector, files);
    await sleep(this.timing("after_upload_settle", 3) * 1000);
    await this.waitUploadSettled(this.timing("upload_timeout", 45));
    return files;
  }

  safeSendButtonSelectors() {
    // Older portable installations may retain their previous selectors.json.
    // Never allow a positional fallback here: it can point at the attachment,
    // microphone, or another composer button while the send control is disabled.
    return this.list("send_button").filter((selector) => selector && selector !== "div#composer-background button:last-of-type");
  }

  async capturePromptSubmissionState(prompt) {
    const expected = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 80).toLocaleLowerCase();
    return this.evaluate((composerSelectors, expectedText) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      };
      let composerText = "";
      for (const selector of composerSelectors) {
        const el = document.querySelector(selector);
        if (isVisible(el)) {
          composerText = normalize(el.innerText || el.textContent || el.value || "");
          break;
        }
      }
      const userMessages = Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author="user"]'));
      const userContainsExpected = expectedText.length > 0 && userMessages.slice(-3).some((el) => normalize(el.innerText || el.textContent || "").includes(expectedText));
      return {
        composerContainsExpected: expectedText.length > 0 && composerText.includes(expectedText),
        userCount: userMessages.length,
        userContainsExpected,
      };
    }, this.list("composer"), expected).catch(() => ({ composerContainsExpected: false, userCount: 0, userContainsExpected: false }));
  }

  async waitForPromptSubmission(beforeState, prompt) {
    const timeoutSec = Math.max(8, this.timing("send_confirm_timeout", 12));
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const current = await this.capturePromptSubmissionState(prompt);
      if (current.userContainsExpected || current.userCount > beforeState.userCount) return;
      if (beforeState.composerContainsExpected && !current.composerContainsExpected) return;
      if (!(await this.isGenerationFinished())) return;
      await sleep(350);
    }
    throw new Error("ChatGPT 未确认收到提示词，已停止本次任务以避免误判为内容违规。请显示浏览器后重试。");
  }

  async clickSend(prompt) {
    const beforeState = await this.capturePromptSubmissionState(prompt);
    await sleep(300);
    let sentByButton = false;
    try {
      const selectors = this.safeSendButtonSelectors();
      if (!selectors.length) throw new Error("未配置可靠的发送按钮选择器");
      const { sel } = await this.tryEnabledSelectors(selectors, { timeout: 8000 });
      await this.clickSelector(sel);
      sentByButton = true;
    } catch (e) {
      logger.warn("chatgpt.send_button.unavailable", { error: e.message || String(e) });
      try {
        const { sel } = await this.trySelectors(this.list("composer"), { timeout: 3000 });
        await this.clickSelector(sel);
        await this.dispatchKey("Enter", "Enter", 13);
      } catch {
        await this.evaluate(() => {
          const active = document.activeElement;
          if (active) active.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        });
      }
    }
    await sleep(500);
    await this.waitForPromptSubmission(beforeState, prompt);
    logger.info("chatgpt.prompt_submitted", { sentByButton });
  }

  async submitPrompt(prompt, progress) {
    const attempts = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (attempt > 1) {
          if (progress) await progress("sending", `未确认发送，正在重试 (${attempt}/${attempts})`);
          await this.assertChatReady();
          await sleep(800);
        } else if (progress) {
          await progress("typing", "输入提示词");
        }
        await this.fillComposer(prompt);
        if (progress && attempt === 1) await progress("sending", "发送");
        await this.clickSend(prompt);
        return;
      } catch (e) {
        lastError = e;
        const message = e && (e.message || String(e));
        const canRetry = /未确认收到提示词|输入框未(?:接受|写入)提示词/.test(message || "");
        if (!canRetry || attempt === attempts) throw e;
        logger.warn("chatgpt.prompt_submission.retry", { attempt, error: message || "未知错误" });
        await sleep(1200);
      }
    }
    throw lastError || new Error("ChatGPT 未确认收到提示词。");
  }

  async collectImageSrcs() {
    const selectors = [...this.list("image_in_message"), "img[src]"];
    const srcs = await this.evaluate((list) => {
      const result = new Set();
      const seen = new Set();
      for (const selector of list) {
        for (const img of document.querySelectorAll(selector)) {
          const src = img.currentSrc || img.src || img.getAttribute("src") || "";
          if (!src || seen.has(src)) continue;
          seen.add(src);
          if (src.startsWith("data:image/svg") || src.includes("avatar") || src.includes("icon")) continue;
          if (src.startsWith("blob:") || src.startsWith("http")) result.add(src);
        }
      }
      return [...result];
    }, selectors).catch(() => []);
    return new Set(srcs);
  }

  async imageLoaded(src) {
    const res = await this.evaluate((imageSrc) => {
      for (const img of document.querySelectorAll("img")) {
        if (img.src === imageSrc || img.getAttribute("src") === imageSrc) {
          const rect = img.getBoundingClientRect();
          return { naturalWidth: img.naturalWidth, renderedWidth: Math.round(rect.width) };
        }
      }
      return null;
    }, src).catch(() => null);
    return !!(res && res.naturalWidth > 0 && res.renderedWidth > 50);
  }

  async waitGeneratingDone(timeoutSec = 240) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      let visible = false;
      for (const sel of this.list("generating_indicator")) {
        if (await this.isSelectorVisible(sel)) {
          visible = true;
          break;
        }
      }
      if (!visible) return;
      await sleep(this.timing("image_appear_poll_interval", 1.5) * 1000);
    }
  }

  async isGenerationFinished() {
    for (const sel of this.list("generating_indicator")) {
      if (await this.isSelectorVisible(sel)) return false;
    }
    return true;
  }

  async getLastAiText(afterCount = 0) {
    return this.evaluate((previousCount) => {
      const selectors = [
        '[data-message-author-role="assistant"]',
        '[data-message-author="assistant"]',
      ];
      let blocks = [];
      for (const selector of selectors) {
        blocks = Array.from(document.querySelectorAll(selector));
        if (blocks.length) break;
      }
      if (blocks.length <= Number(previousCount || 0)) return "";
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const text = (blocks[i].innerText || "").trim();
        if (text.length > 15) return text.slice(0, 500);
      }
      return "";
    }, afterCount).catch(() => "");
  }

  async waitForNewImage(prevSrcs, previousAssistantMessageCount = 0) {
    const deadline = Date.now() + this.timing("generation_timeout", 300) * 1000;
    const noImgCheckAfter = Date.now() + Math.max(12, this.timing("no_image_response_delay", 15)) * 1000;
    let noImgConfirm = 0;
    while (Date.now() < deadline) {
      const srcs = await this.collectImageSrcs();
      const fresh = [...srcs].filter((src) => !prevSrcs.has(src));
      for (const src of fresh.sort()) {
        if (await this.imageLoaded(src)) {
          await this.waitGeneratingDone();
          const still = await this.collectImageSrcs();
          if (still.has(src)) return src;
        }
      }
      if (Date.now() > noImgCheckAfter) {
        const anyLoaded = await fresh.reduce(async (previous, src) => (await previous) || await this.imageLoaded(src), Promise.resolve(false));
        if (!anyLoaded && await this.isGenerationFinished()) {
          noImgConfirm += 1;
          if (noImgConfirm >= 2) {
            const aiText = await this.getLastAiText(previousAssistantMessageCount);
            if (aiText && aiText.length > 5) {
              throw new Error(`ChatGPT 未生成图片(可能提示词违规或被拒绝)。ChatGPT 回复: ${aiText.slice(0, 200)}`);
            }
          }
        } else {
          noImgConfirm = 0;
        }
      }
      await sleep(this.timing("image_appear_poll_interval", 1.5) * 1000);
    }
    throw new Error(`等待图片生成超时(${this.timing("generation_timeout", 300)}s)。请显示浏览器查看实际情况。`);
  }

  async downloadImage(src, jobId, prompt, name, queueIndex = 1, queuePart = null) {
    const today = new Date().toISOString().slice(0, 10);
    const outDir = path.join(this.outputDirValue, today);
    fs.mkdirSync(outDir, { recursive: true });
    const base = name || sanitizeFilename(prompt, 30);
    const mainIndex = Math.max(1, Math.floor(Number(queueIndex) || 1));
    const partIndex = Math.floor(Number(queuePart) || 0);
    const prefix = partIndex > 0 ? `${mainIndex}-${partIndex}` : String(mainIndex);
    const filename = `${prefix}_${base}.png`;
    let outPath = path.join(outDir, filename);
    let duplicate = 2;
    while (fs.existsSync(outPath)) {
      outPath = path.join(outDir, `${prefix}_${base}_${duplicate}.png`);
      duplicate += 1;
    }
    const result = await this.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) return { error: `HTTP ${response.status}` };
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let text = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return { b64: btoa(text), size: bytes.length };
    }, src);
    if (!result || result.error || !result.b64) {
      throw new Error(`下载图片失败: ${result && result.error ? result.error : src}`);
    }
    fs.writeFileSync(outPath, Buffer.from(result.b64, "base64"));
    return outPath;
  }

  async generate({ prompt, jobId, name, inputImages = [], queueIndex = 1, queuePart = null, progress }) {
    await this.ensurePage();
    this.busy = true;
    const start = Date.now();
    logger.info("generate.start", { jobId, hasName: !!name, inputImageCount: normalizeInputImages(inputImages).length });
    try {
      if (progress) await progress("ready", "等待 ChatGPT 页面就绪");
      await this.waitForChatPageReady({ minWaitSec: 1 });
      const uploadedImages = await this.uploadInputImages(inputImages, progress);
      const prevSrcs = await this.collectImageSrcs();
      const previousAssistantMessageCount = await this.evaluate(() => document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author="assistant"]').length).catch(() => 0);
      await this.submitPrompt(prompt, progress);
      if (progress) await progress("generating", "等待图片生成");
      const src = await this.waitForNewImage(prevSrcs, previousAssistantMessageCount);
      const saved = await this.downloadImage(src, jobId, prompt, name, queueIndex, queuePart);
      if (progress) await progress("image_done", "已保存图片");
      if (progress) await progress("settling", "图片已保存，等待页面恢复");
      try {
        await this.waitForChatPageReady({
          timeoutSec: this.timing("post_generation_timeout", 45),
          minWaitSec: this.timing("post_generation_settle", 3),
        });
      } catch (e) {
        // The image is already safely written. Do not mark that completed work
        // as failed solely because ChatGPT is still rendering its post-response UI.
        logger.warn("generate.post_image_page_not_ready", { jobId, error: e.message || String(e) });
        if (progress) await progress("settling", "图片已保存；页面仍在恢复，下一任务会继续等待");
      }
      this.setLastChatUrl(this.pageUrl());
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
