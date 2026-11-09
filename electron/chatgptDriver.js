const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const logger = require("./logger");
const { UploadCoordinator, UploadError, uploadProblem, validateReferences, stageReferenceFiles, watchUpload } = require("./uploadManager");

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

function isConversationUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return isChatGptUrl(parsed.href) && /^\/c\/[^/]+/.test(parsed.pathname);
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
    this.activeWorkers = 0;
    this.workerGeneration = 0;
    this.mainPageRecoveryPromise = null;
    this.pendingAutomationAttachments = null;
    this.automationDraft = null;
    this.inputCoordinator = { tail: Promise.resolve() };
    this.uploadCoordinator = new UploadCoordinator();
    this.uploadAttempt = null;
    this.stagedReferences = null;
    this.taskSignal = null;
    this.pendingTaskOperations = new Set();
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
    this.lastChatUrl = isConversationUrl(state.last_chat_url) ? state.last_chat_url : null;
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
    if (!isConversationUrl(url)) return false;
    this.lastChatUrl = url;
    this.saveState();
    return true;
  }

  conversationKey(url) {
    if (!isConversationUrl(url)) return null;
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
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
    if (this.busy || this.activeWorkers > 0) throw new Error("正在生成中，不能切换浏览器");
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
    // Server workers from a disconnected browser no longer occupy its slots.
    // Late cleanup from that browser must not affect workers in the next one.
    if (this.isolatedWorkersUseNewPages) {
      this.workerGeneration += 1;
      this.activeWorkers = 0;
    }
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

  isManagedPageUrl(url) { return isChatGptUrl(url); }

  async setupPageWindowControls() {
    const page = this.page;
    if (!page || page.isClosed() || this.pageControlsReadyFor === page) return;
    await page.exposeBinding("__imageChatGptHideWindow", async ({ page: sourcePage, frame }) => {
      if (sourcePage !== this.page || frame !== sourcePage.mainFrame() || !this.isManagedPageUrl(sourcePage.url())) {
        return { ok: false, msg: "只允许从受控页面隐藏窗口" };
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
    if (!page || page.isClosed() || !this.isManagedPageUrl(page.url()) || isLoginOrChallengeUrl(page.url())) return false;
    try {
      return await page.evaluate((slotNumber) => {
        const rootId = "__image_chatgpt_hide_window_control__";
        const existing = document.getElementById(rootId);
        if (existing) {
          if (typeof existing.__imageChatGptReset === "function") existing.__imageChatGptReset();
          if (typeof existing.__imageChatGptSetSlot === "function") existing.__imageChatGptSetSlot(slotNumber);
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
        const slotLabel = document.createElement("span");
        slotLabel.style.cssText = "white-space:nowrap;color:#bfdbfe;font-weight:700;";
        host.__imageChatGptSetSlot = (value) => {
          slotLabel.textContent = value ? `环境 ${value}` : "";
          slotLabel.style.display = value ? "" : "none";
        };
        host.__imageChatGptSetSlot(slotNumber);
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
        bar.append(slotLabel, reminder, divider, button);
        shadow.appendChild(bar);
        document.documentElement.appendChild(host);
        return true;
      }, this.workerSlot || null);
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

  sanitizeProfileDir(profileDir) {
    try {
      const localStateFile = path.join(profileDir, "Local State");
      if (fs.existsSync(localStateFile)) {
        const raw = fs.readFileSync(localStateFile, "utf8");
        const data = JSON.parse(raw);
        let changed = false;
        if (data.profile) {
          const order = data.profile.profiles_order || [];
          const validProfile = order[0] || (data.profile.info_cache && Object.keys(data.profile.info_cache)[0]) || "Default";
          if (data.profile.last_used === "Guest Profile" || data.profile.last_used === "System Profile") {
            data.profile.last_used = validProfile;
            changed = true;
          }
          if (data.profile.picker_shown) {
            data.profile.picker_shown = false;
            changed = true;
          }
          if (!data.profile.last_active_profiles || !data.profile.last_active_profiles.length) {
            data.profile.last_active_profiles = [validProfile];
            changed = true;
          }
        }
        if (changed) fs.writeFileSync(localStateFile, JSON.stringify(data, null, 2), "utf8");
      }
      const guestDir = path.join(profileDir, "Guest Profile");
      if (fs.existsSync(guestDir)) fs.rmSync(guestDir, { recursive: true, force: true });
    } catch (_) {}
  }

  async _init({ headless = true } = {}) {
    fs.mkdirSync(this.outputDirValue, { recursive: true });
    const browserCfg = this.browserConfig();
    const engine = this.browserEngine;
    const label = browserLabel(engine);
    const profileDir = this.browserProfileDir(engine);
    fs.mkdirSync(profileDir, { recursive: true });
    this.sanitizeProfileDir(profileDir);
    const executablePath = findBrowserExecutable(engine, browserCfg);
    if (!executablePath) {
      throw new Error(`未找到 ${label}。请安装它，或在 config/selectors.json 的 browser.${engine}_path 中填写可执行文件的完整路径。`);
    }
    const bounds = this.browserWindowBounds();
    const port = await findFreePort(browserCfg.cdp_port);
    const initialUrl = this.cfg.new_chat_url || this.cfg.chatgpt_url || "https://chatgpt.com/";
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
      "--no-guest",
      "--no-profile-picker",
      "--disable-features=TranslateUI,ProfilePicker",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--disable-restore-tab-session",
    ];
    const linuxDiagnostics = process.platform === "linux";
    const child = spawn(executablePath, args, { stdio: linuxDiagnostics ? ["ignore", "ignore", "pipe"] : "ignore", windowsHide: false });
    if (linuxDiagnostics && child.stderr) {
      let pending = "";
      child.stderr.on("data", chunk => {
        pending += chunk.toString("utf8");
        const lines = pending.split(/\r?\n/);
        pending = lines.pop().slice(-2048);
        for (const line of lines) {
          const location = line.match(/\b(ERROR|FATAL|WARNING):([a-zA-Z0-9_.-]+\.(?:cc|h)):(\d+)/);
          if (location) logger.warn("system_browser.start_event", { severity: location[1], source: `${location[2]}:${location[3]}` });
          const hint = /crashpad|crash reporter/i.test(line) ? "crashpad"
            : /no usable sandbox|sandbox.*not|setuid sandbox/i.test(line) ? "sandbox"
            : /namespace|operation not permitted/i.test(line) ? "namespace"
            : /cannot open display|missing x server|no.*display/i.test(line) ? "display"
            : /permission denied/i.test(line) ? "permissions"
            : /pthread_create|resource temporarily unavailable/i.test(line) ? "resources" : "";
          if (hint) logger.warn("system_browser.start_hint", { hint });
        }
      });
    }
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
    if (this.mainPageRecoveryPromise) await this.mainPageRecoveryPromise;
    if (!this.hasLivePage() && this.browser && this.browser.isConnected() && this.context) {
      this.mainPageRecoveryPromise = (async () => {
        await this.detachDebugger();
        const page = await this.context.newPage();
        this.page = page;
        this.pageControlsReadyFor = null;
        page.setDefaultTimeout(this.timing("selector_timeout_ms", 15000));
        await page.goto(this.cfg.new_chat_url || this.cfg.chatgpt_url || "https://chatgpt.com/", { waitUntil: "domcontentloaded" });
        await this.ensureAuthenticatedPageWindowControls();
      })();
      try { await this.mainPageRecoveryPromise; } finally { this.mainPageRecoveryPromise = null; }
    }
    if (!this.hasLivePage() && this.activeWorkers > 0) throw new Error("浏览器已断开，请等待当前并发任务结束后检查浏览器");
    if (!this.hasLivePage()) await this.init({ headless });
    return this.page;
  }

  async readComposerDraft() {
    return this.evaluate((selectors) => {
      const visible = el => {
        const r = el.getBoundingClientRect(), style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (!visible(el)) continue;
          const value = typeof el.value === "string" ? el.value : (el.innerText || el.textContent || "");
          return { found: true, text: String(value).replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim() };
        }
      }
      return { found: false, text: "" };
    }, ["input-area-v2 .ql-editor[contenteditable='true'][role='textbox']", ...this.list("composer")]);
  }

  async assertPrimaryComposerClear({ requireComposer = false } = {}) {
    const label = this.workerSlot ? `环境 ${this.workerSlot}` : "主标签";
    const conflict = message => Object.assign(new Error(message), { blockWorker: true });
    if (!this.hasLivePage() || !this.isManagedPageUrl(this.pageUrl())) {
      if (requireComposer) throw conflict(`${label}尚未打开可确认的输入区，请检查登录状态`);
      return;
    }
    const info = await this.readComposerDraft();
    if (!info.found) {
      if (requireComposer) throw conflict(`${label}输入区尚未就绪，请检查后重试`);
      return;
    }
    if (info.text) throw conflict(`${label}输入区有无法确认归属的草稿，已保留，请检查后恢复该环境`);
    const state = typeof this.inputState === "function" ? await this.inputState() : await this.composerAttachmentState();
    if (state.count || state.busy) throw conflict(`${label}有未发送或正在上传的参考图，请检查后恢复该环境`);
  }

  async recoverAutomationDraft() {
    const draft = this.automationDraft;
    if (!draft) return;
    const state = await this.capturePromptSubmissionState(draft.prompt);
    if (!state.composerFound) throw Object.assign(new Error("输入区尚未就绪，无法检查上次任务残留"), { blockWorker: true });
    if (draft.submissionAttempted && !draft.submissionConfirmed) {
      if (!state.lastUserMatches || !state.lastUserKey || state.lastUserKey === draft.before?.lastUserKey) {
        throw Object.assign(new Error("上次任务的发送状态尚未确认，已保留输入区，请检查后恢复该环境"), { blockWorker: true });
      }
      draft.submissionConfirmed = true;
    }
    const normalize = value => String(value || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
    if (state.composerText && !draft.inputStarted) {
      throw Object.assign(new Error("等待上传期间输入区出现了新的草稿，已保留，请检查后恢复该环境"), { blockWorker: true });
    }
    if (state.composerText && state.composerText !== normalize(draft.prompt)) {
      throw Object.assign(new Error("输入区内容与上次任务不一致，已保留草稿，请检查后恢复该环境"), { blockWorker: true });
    }
    if (state.composerText) {
      const composer = await this.trySelectors(this.list("composer"), { timeout: 4000 });
      await this.typeText(composer.sel, "", composer.index);
    }
    if (this.pendingAutomationAttachments) {
      if (draft.submissionConfirmed) this.pendingAutomationAttachments.submissionAttempted = false;
      if (!(await this.clearPendingAutomationAttachments())) {
        throw Object.assign(new Error("上次任务的参考图仍在输入区，已保留该环境，请检查后恢复"), { blockWorker: true });
      }
    }
    this.automationDraft = null;
    this.releaseDeferredReferences();
    logger.info("chatgpt.composer.recovered", { jobId: draft.jobId, slot: this.workerSlot, submitted: !!draft.submissionConfirmed });
  }

  async createIsolatedWorker(conversationUrl = null, slotNumber = null, progress = null) {
    let page = null;
    let reserved = false;
    let reservedGeneration = null;
    const usesPrimaryPage = slotNumber === 1 && !this.isolatedWorkersUseNewPages;
    const report = async (phase, detail) => {
      logger.info("system_browser.worker.prepare", { slot: slotNumber, phase });
      if (progress) await progress("ready", detail);
    };
    try {
      await report("browser", "连接浏览器");
      await this.ensurePage();
      if (usesPrimaryPage) {
        await report("primary", "检查主标签");
        const current = this.conversationKey(this.pageUrl());
        const willNavigate = Boolean(conversationUrl ? current !== conversationUrl : current);
        await this.assertPrimaryComposerClear({ requireComposer: willNavigate });
      }
      this.activeWorkers += 1;
      reserved = true;
      reservedGeneration = this.workerGeneration;
      const reservedContext = this.context;
      const checkGeneration = () => {
        if (this.isolatedWorkersUseNewPages && reservedGeneration !== this.workerGeneration) {
          throw new Error("浏览器已断开，环境已重置");
        }
      };
      await report("tab", usesPrimaryPage ? "使用主标签" : "打开独立标签");
      checkGeneration();
      page = usesPrimaryPage ? this.page : await reservedContext.newPage();
      checkGeneration();
      page.setDefaultTimeout(this.timing("selector_timeout_ms", 15000));
      const worker = Object.assign(Object.create(Object.getPrototypeOf(this)), this, {
        page,
        cdpSession: null,
        pageControlsReadyFor: null,
        pendingAutomationAttachments: null,
        automationDraft: null,
        uploadAttempt: null,
        stagedReferences: null,
        taskSignal: null,
        pendingTaskOperations: new Set(),
        busy: false,
        activeWorkers: 0,
        lastChatUrl: null,
        initPromise: null,
        workerSlot: slotNumber,
        usesPrimaryPage,
        workerGeneration: reservedGeneration,
        workerReleased: false,
      });
      // Parallel conversations must not replace the user's saved main conversation.
      worker.setLastChatUrl = () => false;
      worker.ensurePage = async function () {
        if (!this.hasLivePage()) throw new Error("并发对话标签已关闭或浏览器断开，请检查浏览器");
        return this.page;
      };
      if (usesPrimaryPage) {
        worker.ensureAuthenticatedPageWindowControls = async () => {
          if (this.page !== page) return false;
          this.workerSlot = slotNumber;
          return this.ensureAuthenticatedPageWindowControls();
        };
      }
      if (conversationUrl && !worker.conversationKey(conversationUrl)) throw new Error("并发环境的对话地址无效");
      const current = worker.conversationKey(worker.pageUrl());
      if (!usesPrimaryPage || (conversationUrl ? current !== conversationUrl : !!current)) {
        await report("navigation", "加载对话页面");
        const url = conversationUrl || worker.cfg.new_chat_url || worker.cfg.chatgpt_url || "https://chatgpt.com/";
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        } catch (error) {
          if (!worker.pageUrl() || worker.pageUrl() === "about:blank") throw error;
          logger.warn("system_browser.worker.navigation_interrupted", { slot: slotNumber, error: error.message || String(error) });
        }
      }
      await report("controls", "检查页面状态");
      await worker.ensureAuthenticatedPageWindowControls();
      await report("ready", "会话已准备");
      checkGeneration();
      return worker;
    } catch (error) {
      logger.warn("system_browser.worker.prepare_failed", { slot: slotNumber, error: error.message || String(error) });
      if (!usesPrimaryPage && page && !page.isClosed()) await page.close().catch(() => {});
      if (reserved && (!this.isolatedWorkersUseNewPages || reservedGeneration === this.workerGeneration)) {
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      }
      throw error;
    }
  }

  async releaseIsolatedWorker(worker, { keep = false } = {}) {
    if (this.isolatedWorkersUseNewPages) {
      if (worker.workerReleased) return;
      worker.workerReleased = true;
    }
    try {
      if (!keep && this.isolatedWorkersUseNewPages && !worker.usesPrimaryPage && worker.page && !worker.page.isClosed()) await worker.page.close();
      await worker.detachDebugger();
      if (!keep && !worker.usesPrimaryPage && worker.page && !worker.page.isClosed()) await worker.page.close();
      if (!keep && this.isolatedWorkersUseNewPages && worker.page?.isClosed()) {
        worker.pendingAutomationAttachments = null;
        worker.releaseDeferredReferences();
      }
      if (worker.usesPrimaryPage && this.page === worker.page) this.workerSlot = null;
    } catch (error) {
      logger.warn("browser.worker.release.failed", { error: error.message || String(error), keep });
    } finally {
      if (!this.isolatedWorkersUseNewPages || worker.workerGeneration === this.workerGeneration) {
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      }
    }
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

  assertTaskActive() {
    if (this.taskSignal?.aborted) throw this.taskSignal.reason;
  }

  async withInputLock(action) {
    const previous = this.inputCoordinator.tail.catch(() => {});
    let release;
    const turn = new Promise(resolve => { release = resolve; });
    this.inputCoordinator.tail = previous.then(() => turn);
    try {
      await this.taskOperation(previous);
      this.assertTaskActive();
      return await action();
    } finally { release(); }
  }

  async withUploadLock(files, progress, action) {
    if (!files.length) return action();
    return this.uploadCoordinator.run(this, progress, async () => {
      try { return await action(); }
      catch (error) {
        this.uploadCoordinator.block(error);
        if (!this.isolatedWorkersUseNewPages && !this.taskSignal?.aborted && this.automationDraft && !this.automationDraft.submissionAttempted) {
          if (this.uploadAttempt) this.uploadAttempt.cleaning = true;
          if (await this.clearUnsentUpload()) {
            error.uploadCleaned = true;
            error.uploadUnsent = true;
          } else error.blockWorker = true;
        }
        throw error;
      }
      finally {
        const attempt = this.uploadAttempt;
        const staged = this.stagedReferences;
        this.uploadAttempt = null;
        attempt?.dispose();
        if (staged) {
          const release = () => {
            if (attempt) attempt.onIdle(() => staged.dispose());
            else staged.dispose();
          };
          if (this.pendingAutomationAttachments) staged.release = release;
          else { this.stagedReferences = null; release(); }
        }
      }
    });
  }

  checkUploadState(state) {
    this.uploadCoordinator.check();
    if (this.uploadAttempt?.failure) throw this.uploadAttempt.failure;
    if (state.uploadError) {
      const error = uploadProblem(state.uploadError);
      this.uploadCoordinator.block(error);
      throw error;
    }
  }

  uploadTransportIdle() {
    return !this.uploadAttempt || (!this.uploadAttempt.inFlight.size && !this.uploadAttempt.parsing.size);
  }

  releaseDeferredReferences() {
    const staged = this.stagedReferences;
    if (staged?.release && !this.pendingAutomationAttachments) {
      this.stagedReferences = null;
      staged.release();
    }
  }

  async clearUnsentUpload() {
    if (!this.automationDraft || this.automationDraft.submissionAttempted) return false;
    try {
      await this.withInputLock(() => this.recoverAutomationDraft());
      return true;
    } catch (error) {
      this.assertTaskActive();
      logger.warn("upload.cleanup.failed", { slot: this.workerSlot, kind: error.uploadKind || "composer_not_clear" });
      return false;
    }
  }

  async performReferenceUpload(files, progress, selectFiles, waitReady) {
    const maxBytes = this.cfg.chatgpt_url?.includes("gemini.google.com") ? Infinity : 20 * 1024 * 1024;
    const metadata = validateReferences(files, maxBytes);
    this.releaseDeferredReferences();
    if (this.stagedReferences) throw Object.assign(new Error("上次参考图副本仍被输入区使用，请检查后恢复该环境"), { blockWorker: true });
    if (progress) await progress("uploading", "正在准备参考图");
    this.stagedReferences = await stageReferenceFiles(files, metadata, this.taskSignal);
    const uploadFiles = this.stagedReferences.files;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this.assertTaskActive();
      this.uploadCoordinator.check();
      await this.assertPrimaryComposerClear({ requireComposer: true });
      this.uploadCoordinator.check();
      this.uploadAttempt?.dispose();
      this.uploadAttempt = watchUpload(this.page, this.uploadCoordinator, this.workerSlot, uploadFiles, maxBytes);
      try {
        if (progress) await progress("uploading", `上传参考图 ${files.length} 张${attempt > 1 ? "（重传 1/1）" : ""}`);
        this.pendingAutomationAttachments = { count: files.length, submissionAttempted: false };
        await selectFiles(uploadFiles);
        await waitReady();
        return;
      } catch (error) {
        this.assertTaskActive();
        this.uploadCoordinator.block(error);
        if (this.isolatedWorkersUseNewPages || !error.retryable || error.uploadFatal || attempt === 2) throw error;
        const draft = this.automationDraft;
        this.uploadAttempt.cleaning = true;
        if (!(await this.clearUnsentUpload())) {
          error.blockWorker = true;
          throw error;
        }
        const deadline = Date.now() + 6000;
        while (!this.uploadTransportIdle() && Date.now() < deadline) await this.taskSleep(300);
        if (!this.uploadTransportIdle()) {
          throw new UploadError("pending", "参考图已清理，但上传连接尚未结束，已阻止重复上传，请检查浏览器", { fatal: true });
        }
        this.uploadAttempt.dispose();
        this.uploadAttempt = null;
        this.automationDraft = draft;
        this.uploadCoordinator.cooldownUntil = Math.max(this.uploadCoordinator.cooldownUntil, Date.now() + 8000);
        if (progress) await progress("uploading", "上传暂时失败，冷却 8 秒后仅重传一次");
        logger.info("upload.retry.scheduled", { slot: this.workerSlot, kind: error.uploadKind, status: error.httpStatus || 0, attempt: 1, delayMs: 8000 });
        await this.taskSleep(8000);
      }
    }
  }

  async taskOperation(promise) {
    const signal = this.taskSignal;
    if (!signal) return promise;
    const pending = Promise.resolve(promise);
    this.pendingTaskOperations.add(pending);
    const settled = () => this.pendingTaskOperations.delete(pending);
    pending.then(settled, settled);
    this.assertTaskActive();
    let onAbort;
    try {
      const result = await Promise.race([pending, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      })]);
      this.assertTaskActive();
      return result;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  hasPendingTaskOperations() {
    return this.pendingTaskOperations.size > 0;
  }

  async taskSleep(ms) {
    const signal = this.taskSignal;
    this.assertTaskActive();
    if (!signal) return sleep(ms);
    await new Promise((resolve, reject) => {
      const done = () => { signal.removeEventListener("abort", onAbort); resolve(); };
      const timer = setTimeout(done, ms);
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.assertTaskActive();
  }

  async stopCurrentGeneration() {
    if (!this.hasLivePage()) return false;
    if (this.pendingAutomationAttachments && this.automationDraft && !this.automationDraft.submissionAttempted) {
      if (!(await this.clearUnsentUpload())) return false;
    }
    const gemini = this.cfg.chatgpt_url?.includes("gemini.google.com");
    const selectors = gemini
      ? ['button[aria-label*="停止回答"]', 'button[aria-label*="Stop response"]', 'button[aria-label*="Stop generating"]']
      : this.list("generating_indicator").filter(selector => /^button\b/.test(selector));
    for (const selector of selectors) {
      const button = this.page.locator(selector).first();
      if (await button.isVisible().catch(() => false)) {
        await this.withInputLock(() => button.click({ timeout: 3000 }));
        break;
      }
    }
    // Reuse only after the page is quiet and its input is completely empty.
    const deadline = Date.now() + 10000;
    let stableRounds = 0;
    while (Date.now() < deadline) {
      const finished = gemini ? !(await this.responseState()).generating : await this.isGenerationFinished();
      try {
        await this.assertPrimaryComposerClear({ requireComposer: true });
        if (finished && ++stableRounds >= 3) return true;
        if (!finished) stableRounds = 0;
      } catch { return false; }
      await sleep(500);
    }
    return false;
  }

  async evaluate(fn, ...args) {
    this.assertTaskActive();
    const page = await this.ensurePage();
    this.assertTaskActive();
    const serializedArgs = JSON.stringify(args).replace(/</g, "\\u003c");
    const result = await this.taskOperation(page.evaluate(`(${fn.toString()})(...${serializedArgs})`));
    this.assertTaskActive();
    return result;
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
    const releasingInput = (method === "Input.dispatchKeyEvent" && params.type === "keyUp") || (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased");
    if (!releasingInput) this.assertTaskActive();
    const session = releasingInput ? await this.ensureDebugger() : await this.taskOperation(this.ensureDebugger());
    if (!releasingInput) this.assertTaskActive();
    return session.send(method, params);
  }

  async trySelectors(selectors, { visibleOnly = true, timeout = 4000 } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    do {
      for (const sel of selectors) {
        try {
          const page = await this.ensurePage();
          const locator = page.locator(sel);
          const count = await locator.count();
          for (let index = 0; index < count; index += 1) {
            if (!visibleOnly || await locator.nth(index).isVisible()) return { sel, index };
          }
        } catch (error) {
          // A ChatGPT route change can invalidate its old JavaScript context.
          // Locator calls are retried until the new page is ready.
          lastError = error;
        }
      }
      if (Date.now() < deadline) await this.taskSleep(180);
    } while (Date.now() < deadline);
    const reason = lastError ? `；页面读取异常: ${lastError.message || String(lastError)}` : "";
    throw new Error(`无选择器命中,试过: ${selectors.join(", ")}${reason}`);
  }

  async tryEnabledSelectors(selectors, { timeout = 4000 } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    do {
      for (const sel of selectors) {
        try {
          const page = await this.ensurePage();
          const locator = page.locator(sel);
          const count = await locator.count();
          for (let index = 0; index < count; index += 1) {
            const item = locator.nth(index);
            if (!(await item.isVisible())) continue;
            const enabled = await item.evaluate((el) => {
              const style = window.getComputedStyle(el);
              return !Boolean(el.disabled)
                && !el.hasAttribute("disabled")
                && el.getAttribute("aria-disabled") !== "true"
                && el.getAttribute("data-state") !== "disabled"
                && style.pointerEvents !== "none";
            });
            if (enabled) return { sel, index };
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (Date.now() < deadline) await this.taskSleep(180);
    } while (Date.now() < deadline);
    const reason = lastError ? `；页面读取异常: ${lastError.message || String(lastError)}` : "";
    throw new Error(`无可用选择器命中,试过: ${selectors.join(", ")}${reason}`);
  }

  async isSelectorVisible(selector) {
    try {
      const state = await this.evaluate((sel) => {
        return Array.from(document.querySelectorAll(sel)).some((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        });
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

  async elementBox(selector, index = 0) {
    const page = await this.ensurePage();
    const locator = page.locator(selector).nth(index);
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox();
    if (!box || box.width < 1 || box.height < 1) return null;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async clickSelector(selector, index = 0) {
    const box = await this.elementBox(selector, index);
    if (!box) throw new Error(`元素不可点击: ${selector}`);
    try {
      await this.sendDevToolsCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await this.sendDevToolsCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await this.sendDevToolsCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      return;
    } catch (e) {
      logger.warn("system_browser.mouse_input.fallback", { selector, error: e.message || String(e) });
    }
    const clicked = await this.evaluate((sel, matchIndex) => {
      const el = document.querySelectorAll(sel)[matchIndex];
      if (!el) return false;
      el.focus();
      el.click();
      return true;
    }, selector, index);
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

  async typeText(selector, text, index = 0) {
    const value = String(text || "");
    const normalize = item => String(item || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
    const expected = normalize(value);
    const locator = this.page.locator(selector).nth(index);
    this.assertTaskActive();
    // Fill the target editor directly. Global Ctrl+A/Delete and partial-prefix
    // checks can leave drafts behind or type into another concurrent tab.
    await locator.fill(value, { timeout: 15000 });
    this.assertTaskActive();
    const deadline = Date.now() + 4000;
    let actualLength = 0;
    while (Date.now() < deadline) {
      const actual = await this.evaluate((sel, matchIndex) => {
        const el = document.querySelectorAll(sel)[matchIndex];
        return el ? { found: true, text: typeof el.value === "string" ? el.value : (el.innerText || el.textContent || "") } : { found: false, text: "" };
      }, selector, index);
      actualLength = normalize(actual.text).length;
      if (actual.found && normalize(actual.text) === expected) return;
      await this.taskSleep(150);
    }
    logger.warn("chatgpt.prompt.input_mismatch", { expectedLength: expected.length, actualLength, slot: this.workerSlot });
    throw new Error(expected ? "ChatGPT 输入框未完整写入提示词，请检查后重试" : "ChatGPT 输入框未能清空，请检查后重试");
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
    await this.waitForChatPageReady({
      minWaitSec: this.timing("new_chat_page_settle", 3),
      stableRounds: this.timing("new_chat_page_stable_rounds", 4),
    });
    return this.pageUrl();
  }

  async openLastChat() {
    if (this.busy) throw new Error("正在生成中,无法切换对话");
    await this.ensurePage();
    if (!this.lastChatUrl) throw new Error("还没有已完成的上次对话");
    await this.goto(this.lastChatUrl);
    await this.taskSleep(this.timing("after_send_settle", 1) * 1000);
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
        for (const el of document.querySelectorAll(selector)) {
          if (!isVisible(el)) continue;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
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
            centered: rect.top > window.innerHeight * 0.2 && rect.top < window.innerHeight * 0.78,
          };
        }
      }
      return {
        documentReady: document.readyState === "interactive" || document.readyState === "complete",
        hasComposer: false,
        writable: false,
        centered: false,
      };
    }, this.list("composer")).catch(() => ({ documentReady: false, hasComposer: false, writable: false, centered: false }));
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
      await this.taskSleep(pollMs);
    }
    const detail = lastState
      ? `documentReady=${lastState.documentReady}, composer=${lastState.hasComposer}, writable=${lastState.writable}, generationFinished=${lastState.finished}`
      : "无法读取页面状态";
    throw new Error(`ChatGPT 页面尚未恢复到可继续处理任务的状态(${detail})。请显示浏览器检查页面。`);
  }

  async assertAutomationCanWrite(prompt) {
    const state = await this.readComposerDraft();
    const expected = String(prompt || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
    if (state.text && !(this.automationDraft?.inputStarted && state.text === expected)) {
      throw Object.assign(new Error("输入区出现了未由本任务填写的草稿，已保留，请检查后恢复该环境"), { blockWorker: true });
    }
    if (this.automationDraft) this.automationDraft.inputStarted = true;
  }

  async fillComposer(text) {
    const cleaned = String(text || "").replace(/[\r\n]+/g, " ").replace(/ {2,}/g, " ").trim();
    if (!cleaned) throw new Error("清洗后 prompt 为空");
    await this.assertAutomationCanWrite(cleaned);
    const { sel, index } = await this.trySelectors(this.list("composer"), { timeout: 15000 });
    await this.typeText(sel, cleaned, index);
    await this.taskSleep(300);
  }

  async findUploadInput(expectedCount = 1) {
    const inputSelectors = this.list("attachment_file_input").length
      ? this.list("attachment_file_input")
      : ["input[type='file'][accept*='image']", "input[type='file']"];
    // Hidden file inputs are normal. Preserve configured selector priority,
    // but never send a batch to an input that cannot accept multiple files.
    const selectInput = () => this.evaluate((selectors, count) => {
      for (const selector of selectors) {
        let inputs;
        try { inputs = Array.from(document.querySelectorAll(selector)); } catch { continue; }
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          if (!(input instanceof HTMLInputElement) || input.type !== 'file' || input.disabled || input.hasAttribute('capture')) continue;
          if (count > 1 && !input.multiple) continue;
          const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          input.setAttribute('data-image-chatgpt-upload', token);
          return { selector: `input[data-image-chatgpt-upload="${token}"]`, configuredSelector: selector, index, multiple: input.multiple };
        }
      }
      return null;
    }, inputSelectors, expectedCount);
    this.assertTaskActive();
    const existing = await selectInput();
    if (existing) return existing;

    for (const sel of this.list("attachment_button")) {
      try {
        if (!(await this.isSelectorVisible(sel))) continue;
        await this.clickSelector(sel);
        await this.taskSleep(500);
        const selected = await selectInput();
        if (selected) return selected;
      } catch {
        this.assertTaskActive();
        // Try the next attachment control.
      }
    }
    throw new Error(expectedCount > 1
      ? `找不到支持一次上传 ${expectedCount} 张图片的 ChatGPT 多选控件，请显示浏览器检查页面`
      : `找不到 ChatGPT 图片上传控件,试过: ${inputSelectors.join(", ")}`);
  }

  async setFileInputFiles(selector, files) {
    const documentNode = await this.sendDevToolsCommand("DOM.getDocument", { depth: 1, pierce: true });
    const node = await this.sendDevToolsCommand("DOM.querySelector", {
      nodeId: documentNode.root.nodeId,
      selector,
    });
    if (!node?.nodeId) throw new Error(`找不到文件上传元素: ${selector}`);
    try {
      await this.sendDevToolsCommand("DOM.setFileInputFiles", { files, nodeId: node.nodeId });
    } finally {
      try { await this.sendDevToolsCommand("DOM.removeAttribute", { nodeId: node.nodeId, name: "data-image-chatgpt-upload" }); } catch {}
    }
  }

  async composerAttachmentState() {
    return this.evaluate((composerSelectors) => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      let composer = null;
      for (const selector of composerSelectors) {
        try { composer = Array.from(document.querySelectorAll(selector)).find(visible) || null; } catch (_) {}
        if (composer) break;
      }
      let root = composer
        ? composer.closest('#composer-background') || composer.closest('[class*="ComposerLayoutRoot"]') || composer.closest('form') || composer.parentElement
        : null;
      if (!root) {
        const input = Array.from(document.querySelectorAll('input[type="file"][multiple]')).find(item => visible(item.parentElement));
        if (input) root = input.closest('#composer-background') || input.closest('[class*="ComposerLayoutRoot"]') || input.closest('form') || input.parentElement;
      }
      const layoutRoot = root?.closest('[class*="ComposerLayoutRoot"]') || root;
      const attachmentRegion = root?.querySelector('[class*="ComposerLayoutAttachments"]')
        || layoutRoot?.querySelector('[class*="ComposerLayoutAttachments"]')
        || root;
      if (!root || !attachmentRegion) {
        return { count: 0, ready: 0, busy: false, spinnerCount: 0, rawImages: 0, roots: 0, composerFound: !!root, attachmentRegionFound: false, signature: '' };
      }
      const rawImages = Array.from(attachmentRegion.querySelectorAll('img')).filter(visible);
      const images = rawImages.filter((img) => {
        // Composer previews may be large data:image/base64 strings. Searching
        // their bytes for "icon"/"avatar" wrongly excludes real attachments.
        const src = img.currentSrc || img.src || '';
        if (!src || src.startsWith('data:image/svg')) return false;
        if (/^https?:/i.test(src)) {
          try {
            const pathname = new URL(src).pathname;
            if (/(?:^|\/)(?:avatars?|icons?)(?:\/|\.)/i.test(pathname)) return false;
          } catch (_) {}
        }
        if (img.complete && img.naturalWidth > 0 && (img.naturalWidth < 32 || img.naturalHeight < 32)) return false;
        return true;
      });
      const cardSelector = 'div[class*="composer-attachment-surface"]';
      const cards = Array.from(attachmentRegion.querySelectorAll(cardSelector)).filter(visible)
        .filter(card => !card.parentElement?.closest(cardSelector));
      const busyIndicators = new Set();
      for (const card of new Set([...cards, ...images.map(img => img.closest(cardSelector) || img.parentElement)])) {
        if (!card) continue;
        const localNodes = [card, ...card.querySelectorAll('*')];
        for (const node of localNodes) {
          if (!visible(node)) continue;
          const className = typeof node.className === 'string' ? node.className : (node.className?.baseVal || '');
          const aria = node.getAttribute('aria-label') || '';
          const testId = node.getAttribute('data-testid') || '';
          const role = node.getAttribute('role') || '';
          const style = getComputedStyle(node);
          const hasUploadLabel = /上传中|正在上传|uploading|upload in progress/i.test(aria);
          const hasUploadClass = /animate-spin|spinner/i.test(className);
          const hasUploadTestId = /upload.*progress|progress.*upload/i.test(testId);
          const hasProgressAnimation = style.animationName !== 'none' && /spin|rotate|spinner|upload|progress/i.test(style.animationName);
          if (role === 'progressbar' || node.getAttribute('aria-busy') === 'true' || hasUploadLabel || hasUploadClass || hasUploadTestId || hasProgressAnimation) {
            busyIndicators.add(node);
          }
        }
      }
      const signature = images.map((img) => {
        const src = img.currentSrc || img.src || '';
        const middle = Math.floor(src.length / 2);
        const sample = `${src.slice(0, 80)}${src.slice(Math.max(0, middle - 40), middle + 40)}${src.slice(-80)}:${img.naturalWidth}x${img.naturalHeight}:${img.complete ? 1 : 0}`;
        let hash = 2166136261;
        for (let index = 0; index < sample.length; index += 1) hash = Math.imul(hash ^ sample.charCodeAt(index), 16777619);
        return (hash >>> 0).toString(16);
      }).join(',');
      const outside = images.filter(img => !cards.some(card => card.contains(img)));
      const loaded = img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
      const ready = cards.filter(card => images.some(img => card.contains(img) && loaded(img))).length + outside.filter(loaded).length;
      const errorPattern = /上传失败|无法上传|上传出错|达到.{0,12}上传|上传.{0,12}(?:上限|限额|次数|限制)|文件.{0,8}(?:过大|不支持)|upload failed|failed to upload|couldn't upload|unable to upload|error uploading|upload error|upload limit|too many|file too large|unsupported file/i;
      const messages = [...cards, ...document.querySelectorAll('[role="alert"],[data-sonner-toast]')]
        .filter(visible).filter(node => !node.closest('[data-message-author-role],[data-message-author]'))
        .map(node => (node.innerText || '').split('\n').filter(line => !/\.(?:png|jpe?g|webp|gif)$/i.test(line.trim())).join(' ').replace(/https?:\/\/\S+/g, '[链接]').trim());
      const failedText = messages.find(text => errorPattern.test(text)) || '';
      const failedCard = cards.some(card => card.matches('[data-state="error"],[aria-invalid="true"]') || Array.from(card.querySelectorAll('[data-state="error"],[aria-invalid="true"],[data-testid*="error"],button[aria-label*="Retry"],button[aria-label*="重试"]')).some(visible));
      const uploadError = !failedText ? (failedCard ? 'upload failed' : '') : /upload limit|too many|达到.{0,12}上传|上传.{0,12}(?:上限|限额|次数|限制)/i.test(failedText)
        ? 'upload limit reached' : /too large|过大/i.test(failedText) ? 'file too large'
        : /unsupported|不支持/i.test(failedText) ? 'unsupported file' : 'upload failed';
      return {
        count: cards.length + outside.length,
        ready,
        busy: busyIndicators.size > 0,
        spinnerCount: busyIndicators.size,
        rawImages: rawImages.length,
        roots: 1,
        composerFound: true,
        attachmentRegionFound: true,
        signature,
        uploadError,
      };
    }, this.list('composer'));
  }

  async waitUploadSettled(expectedCount, timeoutSec = 120) {
    const configuredTimeout = Math.max(20, Number(timeoutSec) || 120);
    // Large references can remain in an uploading state well after their
    // previews appear. Keep checking instead of abandoning the task early.
    const timeout = Math.max(configuredTimeout, Math.min(300, 120 + expectedCount * 15));
    const pollMs = 600;
    const stableMs = 2400;
    const deadline = Date.now() + timeout * 1000;
    const graceDeadline = deadline + stableMs + pollMs;
    const startedAt = Date.now();
    let pollCount = 0;
    let nextDiagnosticAt = startedAt + 30000;
    let quietRounds = 0;
    let stableSince = 0;
    let stableSignature = null;
    let lastState = null;
    while (Date.now() < graceDeadline) {
      pollCount += 1;
      const state = await this.composerAttachmentState();
      lastState = state;
      this.checkUploadState(state);
      if (state.count > expectedCount) throw new Error(`输入区存在多余参考图（预期 ${expectedCount} 张，实际 ${state.count} 张），请先清空附件`);
      const settled = !state.busy && state.count === expectedCount && state.ready === expectedCount && this.uploadTransportIdle();
      if (settled) {
        const signature = state.signature || `${state.count}/${state.ready}`;
        if (signature === stableSignature) quietRounds += 1;
        else {
          stableSignature = signature;
          stableSince = Date.now();
          quietRounds = 1;
        }
        if (quietRounds >= 3 && Date.now() - stableSince >= stableMs) {
          logger.info('chatgpt.attachments.confirmed', { slot: this.workerSlot, expectedCount, timeoutSec: timeout, elapsedSec: (Date.now() - startedAt) / 1000, pollCount, transportObserved: !!this.uploadAttempt?.observed, successfulRequests: this.uploadAttempt?.successes || 0, cancelledRequests: this.uploadAttempt?.cancelledRequests || 0, ...state });
          return;
        }
      } else {
        quietRounds = 0;
        stableSince = 0;
        stableSignature = null;
      }
      if (Date.now() >= deadline && !settled) break;
      if (Date.now() >= nextDiagnosticAt) {
        logger.info('chatgpt.attachments.waiting', { slot: this.workerSlot, expectedCount, timeoutSec: timeout, elapsedSec: (Date.now() - startedAt) / 1000, pollCount, pendingRequests: this.uploadAttempt?.inFlight.size || 0, transportObserved: !!this.uploadAttempt?.observed, cancelledRequests: this.uploadAttempt?.cancelledRequests || 0, ...state });
        nextDiagnosticAt = Date.now() + 30000;
      }
      await this.taskSleep(pollMs);
    }
    const elapsedSec = (Date.now() - startedAt) / 1000;
    logger.warn('chatgpt.attachments.timeout', { expectedCount, timeoutSec: timeout, elapsedSec, pollCount, stableRounds: quietRounds, ...lastState });
    const attachmentStatus = lastState?.count === expectedCount && lastState?.ready === expectedCount
      ? (lastState.busy ? '，附件卡片仍显示上传状态' : '，预览状态未能连续稳定')
      : '';
    throw new UploadError("timeout", `参考图上传等待超时（预期 ${expectedCount} 张，实际 ${lastState?.count || 0} 张，就绪 ${lastState?.ready || 0} 张${attachmentStatus}），已等待约 ${Math.round(elapsedSec)} 秒，已阻止发送提示词`, { retryable: true });
  }

  async uploadInputImages(inputImages, progress) {
    const files = normalizeInputImages(inputImages);
    if (!files.length) return [];
    for (const filePath of files) {
      if (!path.isAbsolute(filePath) || !pathExists(filePath)) {
        throw new UploadError("file", "参考图不存在或路径不可访问，请重新添加参考图");
      }
    }
    if (this.pendingAutomationAttachments) {
      if (this.pendingAutomationAttachments.submissionAttempted) {
        throw new Error('上一个任务的发送状态不确定，请检查浏览器后再继续');
      }
      if (!(await this.clearPendingAutomationAttachments())) {
        throw new Error('上一个任务的参考图未能自动清除，请显示浏览器检查输入区');
      }
    }
    const before = await this.composerAttachmentState();
    if (before.count) throw new Error('输入区已有附件，请先移除残留参考图再重试，避免混入其他任务');
    await this.performReferenceUpload(files, progress, uploadFiles => this.withInputLock(async () => {
      const input = await this.findUploadInput(uploadFiles.length);
      logger.info('chatgpt.attachment.input', { selector: input.configuredSelector, index: input.index, multiple: input.multiple, expectedCount: files.length, batch: true, slot: this.workerSlot });
      await this.setFileInputFiles(input.selector, uploadFiles);
    }), async () => {
      await this.taskSleep(this.timing('after_upload_settle', 0.5) * 1000);
      await this.waitUploadSettled(files.length, this.timing('upload_timeout', 45));
    });
    if (progress) await progress('uploading', `参考图已确认 ${files.length}/${files.length} 张`);
    return files;
  }

  async clearPendingAutomationAttachments() {
    const pending = this.pendingAutomationAttachments;
    if (!pending || pending.submissionAttempted) return !pending;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const state = await this.composerAttachmentState();
        if (state.count > pending.count) return false;
        if (state.composerFound && state.count === 0) {
          this.pendingAutomationAttachments = null;
          logger.info('chatgpt.attachments.cleanup.confirmed', { attempt, removed: pending.count });
          return true;
        }
        if (!state.composerFound) break;
        const result = await this.evaluate((composerSelectors, maximum) => {
          const visible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
          };
          let composer = null;
          for (const selector of composerSelectors) {
            try { composer = Array.from(document.querySelectorAll(selector)).find(visible) || null; } catch (_) {}
            if (composer) break;
          }
          const root = composer
            ? composer.closest('#composer-background') || composer.closest('[class*="ComposerLayoutRoot"]') || composer.closest('form') || composer.parentElement
            : null;
          const layoutRoot = root?.closest('[class*="ComposerLayoutRoot"]') || root;
          const region = root?.querySelector('[class*="ComposerLayoutAttachments"]')
            || layoutRoot?.querySelector('[class*="ComposerLayoutAttachments"]')
            || root;
          if (!region) return { clicked: 0, cards: 0 };
          const cards = Array.from(region.querySelectorAll('div[class*="composer-attachment-surface"]'))
            .filter(visible)
            .slice(0, Math.max(0, Number(maximum) || 0));
          const removable = item => {
            const label = item.getAttribute('aria-label') || item.getAttribute('title') || item.getAttribute('data-testid') || '';
            return !item.disabled && /^(?:remove|delete|移除|删除|去除|清除)|(?:remove|delete).*(?:file|attachment)|(?:file|attachment).*(?:remove|delete)/i.test(label.trim());
          };
          let buttons = cards.map(card => Array.from(card.querySelectorAll('button,[role="button"]')).find(removable)).filter(Boolean);
          if (!buttons.length) {
            buttons = Array.from(region.querySelectorAll('button,[role="button"]')).filter(item => {
              if (!visible(item) || !removable(item)) return false;
              let container = item.parentElement;
              for (let level = 0; container && container !== region && level < 4; level += 1, container = container.parentElement) {
                if (container.querySelector('img')) return true;
              }
              return /attachment|file|image|photo|附件|文件|图片|照片/i.test(item.getAttribute('aria-label') || item.getAttribute('title') || '');
            });
          }
          let clicked = 0;
          for (const button of [...new Set(buttons)].slice(0, maximum).reverse()) { button.click(); clicked += 1; }
          return { clicked, cards: cards.length };
        }, this.list('composer'), pending.count);
        logger.info('chatgpt.attachments.cleanup_progress', { slot: this.workerSlot, attempt, count: state.count, ...result });
        if (!result.clicked) break;
        await this.taskSleep(500);
      }
      const finalState = await this.composerAttachmentState();
      if (finalState.composerFound && finalState.count === 0) {
        this.pendingAutomationAttachments = null;
        logger.info('chatgpt.attachments.cleanup.confirmed', { removed: pending.count });
        return true;
      }
      logger.warn('chatgpt.attachments.cleanup.incomplete', { expectedToRemove: pending.count, ...finalState });
      return false;
    } catch (error) {
      logger.warn('chatgpt.attachments.cleanup.failed', { error: error.message || String(error) });
      return false;
    }
  }

  safeSendButtonSelectors() {
    // Older portable installations may retain their previous selectors.json.
    // Never allow a positional fallback here: it can point at the attachment,
    // microphone, or another composer button while the send control is disabled.
    return this.list("send_button").filter((selector) => selector && selector !== "div#composer-background button:last-of-type");
  }

  async capturePromptSubmissionState(prompt) {
    const expected = String(prompt || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
    return this.evaluate((composerSelectors, expectedText) => {
      const normalize = (value) => String(value || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      };
      let composerText = "";
      let composerFound = false;
      for (const selector of composerSelectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (isVisible(el)) {
            composerText = normalize(typeof el.value === "string" ? el.value : (el.innerText || el.textContent || ""));
            composerFound = true;
            break;
          }
        }
        if (composerFound) break;
      }
      const userSelector = '[data-message-author-role="user"], [data-message-author="user"], [class~="group/user-message"]';
      const userMessages = Array.from(document.querySelectorAll(userSelector)).filter(el => !el.parentElement?.closest(userSelector));
      const user = userMessages[userMessages.length - 1];
      const message = user?.closest('[data-message-id], [data-chatgpt-search-message-ids]');
      const turn = user?.closest('[data-turn-key], [data-testid^="conversation-turn-"]');
      if (user && !user.__imageChatGptMessageKey) {
        window.__imageChatGptMessageSequence = (window.__imageChatGptMessageSequence || 0) + 1;
        user.__imageChatGptMessageKey = `node:${window.__imageChatGptMessageSequence}`;
      }
      const lastUserKey = message?.getAttribute('data-message-id') || message?.getAttribute('data-chatgpt-search-message-ids') || turn?.getAttribute('data-turn-key') || turn?.getAttribute('data-testid') || user?.__imageChatGptMessageKey || '';
      return {
        composerFound,
        composerText,
        composerMatchesExpected: expectedText.length > 0 && composerText === expectedText,
        userCount: userMessages.length,
        lastUserKey,
        lastUserMatches: expectedText.length > 0 && normalize(user?.innerText || user?.textContent || '').includes(expectedText),
      };
    }, this.list("composer"), expected).catch(() => {
      this.assertTaskActive();
      return { composerFound: false, composerText: "", composerMatchesExpected: false, userCount: 0, lastUserKey: "", lastUserMatches: false };
    });
  }

  async waitForPromptSubmission(beforeState, prompt) {
    const timeoutSec = Math.max(20, this.timing("send_confirm_timeout", 20));
    const deadline = Date.now() + timeoutSec * 1000;
    let lastState = null;
    while (Date.now() < deadline) {
      const current = await this.capturePromptSubmissionState(prompt);
      lastState = current;
      const newMessage = current.lastUserKey && current.lastUserKey !== beforeState.lastUserKey;
      if (newMessage && current.lastUserMatches) {
        if (this.automationDraft) {
          this.automationDraft.submissionConfirmed = true;
          this.automationDraft.userKey = current.lastUserKey;
        }
        if (current.composerFound && !current.composerText) {
          const attachments = await this.composerAttachmentState();
          if (attachments.count === 0) return current;
        }
      }
      await this.taskSleep(350);
    }
    logger.warn("chatgpt.prompt.confirmation_timeout", { slot: this.workerSlot, beforeUserCount: beforeState.userCount, currentUserCount: lastState?.userCount, newMessage: !!lastState?.lastUserKey && lastState.lastUserKey !== beforeState.lastUserKey, fullPromptMatches: !!lastState?.lastUserMatches, composerFound: !!lastState?.composerFound, composerLength: lastState?.composerText?.length });
    throw Object.assign(new Error(this.automationDraft?.submissionConfirmed
      ? "ChatGPT 已收到本次提示词，但输入区尚未清空，请检查后恢复该环境"
      : "未能确认 ChatGPT 收到本次完整提示词，已阻止重复发送，请检查后恢复该环境"), { blockWorker: true });
  }

  async waitForSendControl(selectors, expectedAttachments, progress) {
    const deadline = Date.now() + (expectedAttachments ? 30000 : 8000);
    let notified = false;
    while (Date.now() < deadline) {
      let ready = true;
      if (expectedAttachments) {
        const state = typeof this.inputState === "function" ? await this.inputState() : await this.composerAttachmentState();
        this.checkUploadState(state);
        ready = !state.busy && state.count === expectedAttachments && state.ready === expectedAttachments && this.uploadTransportIdle();
      }
      if (ready) {
        const control = await this.tryEnabledSelectors(selectors, { timeout: 700 }).catch(() => null);
        this.assertTaskActive();
        if (control) return control;
      }
      if (!notified && expectedAttachments && progress) {
        await progress("uploading", "参考图仍在网页处理中，等待发送按钮就绪");
        notified = true;
      }
      await this.taskSleep(350);
    }
    throw Object.assign(new Error(expectedAttachments
      ? "参考图预览已出现，但网页始终未启用发送按钮，已保留该环境，请显示浏览器检查"
      : "网页发送按钮尚未就绪，请显示浏览器检查"), { blockWorker: true });
  }

  async clickSend(prompt, expectedAttachments = 0, progress) {
    const beforeState = await this.capturePromptSubmissionState(prompt);
    if (!beforeState.composerMatchesExpected) throw new Error("ChatGPT 输入框未完整写入提示词，已阻止发送");
    await this.taskSleep(300);
    let sentByButton = false;
    try {
      const selectors = this.safeSendButtonSelectors();
      if (!selectors.length) throw new Error("未配置可靠的发送按钮选择器");
      const { sel, index } = await this.waitForSendControl(selectors, expectedAttachments, progress);
      if (expectedAttachments) {
        const attachments = await this.composerAttachmentState();
        this.checkUploadState(attachments);
        if (attachments.busy || attachments.count !== expectedAttachments || attachments.ready !== expectedAttachments) throw new Error(`参考图数量或上传状态发生变化（预期 ${expectedAttachments} 张，实际 ${attachments.count} 张），已阻止发送`);
        if (this.pendingAutomationAttachments) this.pendingAutomationAttachments.submissionAttempted = true;
      }
      if (this.automationDraft) {
        this.automationDraft.before = beforeState;
        this.automationDraft.submissionAttempted = true;
      }
      await this.clickSelector(sel, index);
      sentByButton = true;
    } catch (e) {
      this.assertTaskActive();
      if (this.automationDraft?.submissionAttempted) throw e;
      if (e.uploadKind || e.blockWorker) throw e;
      if (expectedAttachments) throw new Error(`图生图未发送：${e.message || String(e)}`);
      logger.warn("chatgpt.send_button.unavailable", { error: e.message || String(e) });
      try {
        const { sel, index } = await this.trySelectors(this.list("composer"), { timeout: 3000 });
        await this.clickSelector(sel, index);
        if (this.automationDraft) {
          this.automationDraft.before = beforeState;
          this.automationDraft.submissionAttempted = true;
        }
        await this.dispatchKey("Enter", "Enter", 13);
      } catch (fallbackError) { throw fallbackError; }
    }
    await this.taskSleep(500);
    const submitted = await this.waitForPromptSubmission(beforeState, prompt);
    if (expectedAttachments) this.pendingAutomationAttachments = null;
    this.automationDraft = null;
    logger.info("chatgpt.prompt_submitted", { sentByButton, slot: this.workerSlot, newMessageConfirmed: true, composerCleared: true });
    return submitted;
  }

  async submitPrompt(prompt, progress, expectedAttachments = 0) {
    if (progress) await progress("typing", "等待填写与发送");
    return this.withInputLock(() => this.submitPromptWithInputLock(prompt, progress, expectedAttachments));
  }

  async submitPromptWithInputLock(prompt, progress, expectedAttachments = 0) {
    const attempts = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (attempt > 1) {
          if (progress) await progress("sending", `未确认发送，正在重试 (${attempt}/${attempts})`);
          await this.assertChatReady();
          await this.taskSleep(800);
        } else if (progress) {
          await progress("typing", "输入提示词");
        }
        await this.waitForChatPageReady({ stableRounds: 2 });
        await this.fillComposer(prompt);
        if (expectedAttachments) await this.waitUploadSettled(expectedAttachments, this.timing('upload_timeout', 45));
        if (progress && attempt === 1) await progress("sending", "发送");
        return await this.clickSend(prompt, expectedAttachments, progress);
      } catch (e) {
        lastError = e;
        const message = e && (e.message || String(e));
        const canRetry = !this.automationDraft?.submissionAttempted && /输入框未(?:完整)?(?:接受|写入)提示词/.test(message || "");
        if (!canRetry || attempt === attempts) throw e;
        logger.warn("chatgpt.prompt_submission.retry", { attempt, error: message || "未知错误" });
        await this.taskSleep(1200);
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

  async captureResponseBoundary() {
    return this.evaluate(() => {
      const selector = '[data-message-author-role="user"], [data-message-author="user"], [class~="group/user-message"]';
      const users = Array.from(document.querySelectorAll(selector)).filter(el => !el.parentElement?.closest(selector));
      const user = users[users.length - 1];
      const message = user?.closest('[data-message-id], [data-chatgpt-search-message-ids]');
      const turn = user?.closest('[data-turn-key], [data-testid^="conversation-turn-"]');
      return {
        users: users.length,
        assistants: document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author="assistant"]').length,
        previousUserKey: message?.getAttribute('data-message-id') || message?.getAttribute('data-chatgpt-search-message-ids') || turn?.getAttribute('data-turn-key') || turn?.getAttribute('data-testid') || '',
      };
    });
  }

  async collectCurrentResponse(previousAssistantCount, previousUserCount, task = {}) {
    return this.evaluate((assistantCount, userCount, boundary) => {
      const userSelector = '[data-message-author-role="user"], [data-message-author="user"], [class~="group/user-message"]';
      const assistantSelector = '[data-message-author-role="assistant"], [data-message-author="assistant"]';
      const users = Array.from(document.querySelectorAll(userSelector)).filter(el => !el.parentElement?.closest(userSelector));
      // Upload previews can acquire new URLs after sending. They are never results.
      // Only inspect new assistant messages following this task's submitted user turn.
      const currentUser = users[users.length - 1];
      const message = currentUser?.closest('[data-message-id], [data-chatgpt-search-message-ids]');
      const userTurn = currentUser?.closest('[data-turn-key], [data-testid^="conversation-turn-"]');
      const userKey = message?.getAttribute('data-message-id') || message?.getAttribute('data-chatgpt-search-message-ids') || userTurn?.getAttribute('data-turn-key') || userTurn?.getAttribute('data-testid') || currentUser?.__imageChatGptMessageKey || '';
      const empty = (reason) => ({ images: [], text: '', busy: false, userKey, diagnostics: { reason, userCount: users.length, previousUserCount: userCount } });
      if (!currentUser) return empty('user_message_missing');
      if (boundary.userKey && userKey !== boundary.userKey) return empty('task_message_changed');
      if (!boundary.userKey) {
        if (userKey && boundary.previousUserKey) {
          if (userKey === boundary.previousUserKey) return empty('waiting_for_submitted_message');
        } else if (users.length <= userCount) return empty('waiting_for_message_boundary');
      }
      const expected = String(boundary.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLocaleLowerCase();
      const userText = (currentUser.innerText || currentUser.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
      if (expected && !userText.includes(expected)) return empty('submitted_prompt_mismatch');
      const replies = Array.from(document.querySelectorAll(assistantSelector))
        .filter((reply) => currentUser.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING);
      // New ChatGPT layouts have no author-role attributes. Generated galleries
      // carry explicit result markers; user attachment thumbnails do not.
      const galleries = Array.from(document.querySelectorAll('[data-testid="generated-image-gallery"], [data-testid="generated-image-preview"]'))
        .filter((gallery) => currentUser.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING);
      const images = [];
      const seen = new Set();
      const turnState = currentUser.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') || '';
      let busy = turnState === 'in_progress';
      for (const reply of [...replies, ...galleries]) {
        const turn = reply.closest('[data-testid^="conversation-turn-"], article') || reply;
        if (turn.matches('.result-streaming, [aria-busy="true"]') || turn.querySelector('.result-streaming, [aria-busy="true"]')) busy = true;
        for (const img of reply.querySelectorAll('img[src], img[srcset]')) {
          if (img.closest(userSelector) || img.closest('#composer-background, form')) continue;
          const src = img.currentSrc || img.src || img.getAttribute('src') || '';
          if (!src || seen.has(src) || src.startsWith('data:image/svg') || src.includes('avatar') || src.includes('icon')) continue;
          if (!src.startsWith('blob:') && !src.startsWith('http')) continue;
          seen.add(src);
          images.push({ src, loaded: img.complete && img.naturalWidth >= 64 && img.naturalHeight >= 64,
            width: img.naturalWidth, height: img.naturalHeight });
        }
      }
      return { images, busy, userKey, text: replies.map((reply) => (reply.innerText || '').trim()).filter(Boolean).join('\n').slice(-500),
        diagnostics: { reason: images.length ? 'result_images_found' : 'waiting_for_result_images', userCount: users.length, previousUserCount: userCount, turnState, replies: replies.length, galleries: galleries.length } };
    }, previousAssistantCount, previousUserCount, task).catch((error) => ({ images: [], text: "", busy: true, diagnostics: { reason: 'page_evaluation_failed', error: error.message || String(error) } }));
  }

  async isGenerationFinished() {
    const activeTurn = await this.evaluate(() => {
      const users = document.querySelectorAll('[data-message-author-role="user"], [data-message-author="user"], [class~="group/user-message"]');
      const lastUser = users[users.length - 1];
      return lastUser?.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') === 'in_progress';
    }).catch(() => true);
    if (activeTurn) return false;
    for (const sel of this.list("generating_indicator")) {
      if (await this.isSelectorVisible(sel)) return false;
    }
    return true;
  }

  async waitForNewImage(prevSrcs, previousAssistantMessageCount = 0, previousUserMessageCount = 0, task = {}) {
    const generationTimeoutSec = Math.max(600, this.timing("generation_timeout", 600));
    const startedAt = Date.now();
    const deadline = startedAt + generationTimeoutSec * 1000;
    const noImgCheckAfter = startedAt + Math.max(90, this.timing("no_image_response_delay", 90)) * 1000;
    let pollCount = 0;
    let noImgConfirm = 0;
    let stableImage = "";
    let stableRounds = 0;
    let stableSince = 0;
    let nextDiagnosticAt = 0;
    let lastDiagnostic = null;
    while (Date.now() < deadline) {
      pollCount += 1;
      const response = await this.collectCurrentResponse(previousAssistantMessageCount, previousUserMessageCount, task);
      if (!task.userKey && response.userKey && response.diagnostics?.reason === 'result_images_found') task.userKey = response.userKey;
      const fresh = response.images.filter((image) => !prevSrcs.has(image.src));
      const finished = !response.busy && await this.isGenerationFinished();
      const composer = finished ? await this.composerInteractionState() : null;
      const ready = composer && composer.documentReady && composer.hasComposer && composer.writable;
      const candidate = fresh.find((image) => image.loaded);
      lastDiagnostic = { jobId: task.jobId, ...response.diagnostics, images: response.images.length, fresh: fresh.length, loaded: fresh.filter(image => image.loaded).length, busy: response.busy, finished, ready: !!ready, elapsedSec: (Date.now() - startedAt) / 1000, pollCount };
      if (Date.now() >= nextDiagnosticAt) {
        logger.info('generate.image_wait', lastDiagnostic);
        nextDiagnosticAt = Date.now() + 30000;
      }
      if (candidate && finished && ready) {
        const fingerprint = `${candidate.src}|${candidate.width}x${candidate.height}`;
        if (fingerprint !== stableImage) {
          stableImage = fingerprint;
          stableRounds = 0;
          stableSince = Date.now();
        }
        stableRounds += 1;
        if (stableRounds >= 3 && Date.now() - stableSince >= 3000) {
          logger.info('generate.image_confirmed', lastDiagnostic);
          return candidate.src;
        }
      } else {
        stableImage = "";
        stableRounds = 0;
      }
      if (Date.now() > noImgCheckAfter) {
        if (!fresh.length && finished && ready) {
          noImgConfirm += 1;
          if (noImgConfirm >= 2) {
            const aiText = response.text;
            if (aiText && aiText.length > 5) {
              throw new Error(`ChatGPT 未生成图片(可能提示词违规或被拒绝)。ChatGPT 回复: ${aiText.slice(0, 200)}`);
            }
          }
        } else {
          noImgConfirm = 0;
        }
      }
      await this.taskSleep(this.timing("image_appear_poll_interval", 0.8) * 1000);
    }
    logger.warn('generate.image_wait.timeout', { ...lastDiagnostic, timeoutSec: generationTimeoutSec, elapsedSec: (Date.now() - startedAt) / 1000, pollCount });
    throw new Error(`等待图片生成超时(${generationTimeoutSec}s)。请显示浏览器查看实际情况。`);
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
    this.assertTaskActive();
    fs.writeFileSync(outPath, Buffer.from(result.b64, "base64"));
    return outPath;
  }

  async generate({ prompt, jobId, name, inputImages = [], queueIndex = 1, queuePart = null, progress, signal }) {
    this.taskSignal = signal || null;
    this.busy = true;
    const start = Date.now();
    const savedPaths = [];
    const requestedImages = normalizeInputImages(inputImages);
    logger.info("generate.start", { jobId, hasName: !!name, inputImageCount: requestedImages.length });
    try {
      this.assertTaskActive();
      await this.ensurePage();
      if (progress) await progress("ready", "等待 ChatGPT 页面就绪");
      const initialComposer = await this.composerInteractionState();
      await this.waitForChatPageReady({
        minWaitSec: initialComposer.centered ? this.timing("new_chat_page_settle", 3) : 1,
        stableRounds: initialComposer.centered ? this.timing("new_chat_page_stable_rounds", 4) : undefined,
      });
      await this.withInputLock(async () => {
        await this.recoverAutomationDraft();
        await this.assertPrimaryComposerClear({ requireComposer: true });
        this.automationDraft = { jobId, prompt, submissionAttempted: false, submissionConfirmed: false };
      });
      if (!requestedImages.length) {
        const existingAttachments = await this.composerAttachmentState();
        if (existingAttachments.count) throw new Error('输入区已有附件，已阻止文生图误带上次参考图');
      }
      const { uploadedImages, prevSrcs, previousMessages, submitted } = await this.withUploadLock(requestedImages, progress, async () => {
        const uploadedImages = await this.uploadInputImages(requestedImages, progress);
        const prevSrcs = await this.collectImageSrcs();
        const previousMessages = await this.captureResponseBoundary();
        const submitted = await this.submitPrompt(prompt, progress, uploadedImages.length);
        return { uploadedImages, prevSrcs, previousMessages, submitted };
      });
      if (progress) await progress("generating", "等待图片生成");
      const src = await this.waitForNewImage(prevSrcs, previousMessages.assistants, previousMessages.users, { userKey: submitted.lastUserKey, previousUserKey: previousMessages.previousUserKey, prompt, jobId });
      const saved = await this.downloadImage(src, jobId, prompt, name, queueIndex, queuePart);
      savedPaths.push(saved);
      if (progress) await progress("image_done", "已保存图片");
      if (progress) await progress("settling", "图片已保存，等待页面恢复");
      try {
        await this.waitForChatPageReady({
          timeoutSec: this.timing("post_generation_timeout", 45),
          minWaitSec: this.timing("post_generation_settle", 3),
        });
      } catch (e) {
        this.assertTaskActive();
        // The image is already safely written. Do not mark that completed work
        // as failed solely because ChatGPT is still rendering its post-response UI.
        logger.warn("generate.post_image_page_not_ready", { jobId, error: e.message || String(e) });
        if (progress) await progress("settling", "图片已保存；页面仍在恢复，下一任务会继续等待");
      }
      this.assertTaskActive();
      this.setLastChatUrl(this.pageUrl());
      logger.info("generate.done", { jobId, imageCount: 1, elapsed: (Date.now() - start) / 1000 });
      return { success: true, image_paths: [saved], input_images: uploadedImages, elapsed: (Date.now() - start) / 1000 };
    } catch (e) {
      if (signal?.aborted) return { success: false, cancelled: true, error: "已停止", image_paths: savedPaths };
      let error = e.message || String(e);
      let pauseQueue = false;
      let blockWorker = !!e.blockWorker;
      let recoverable = !!e.uploadCleaned && !!e.uploadUnsent;
      // Clean only this app's exact draft. A preflight conflict must never
      // erase a manual draft or append an unrelated attachment-cleanup error.
      if (!this.isolatedWorkersUseNewPages && this.automationDraft?.jobId === jobId) {
        const unsent = !this.automationDraft.submissionAttempted;
        try {
          await this.withInputLock(() => this.recoverAutomationDraft());
          recoverable = unsent;
        } catch (cleanupError) {
          this.assertTaskActive();
          blockWorker = true;
          if (cleanupError.message !== error) error += `（${cleanupError.message}）`;
        }
      }
      if (e.uploadFatal) {
        this.uploadCoordinator.block(e);
        blockWorker = false;
        recoverable = false;
      }
      pauseQueue = !recoverable && !blockWorker;
      logger.error("generate.failed", { jobId, slot: this.workerSlot, error, kind: e.uploadKind || null, status: e.httpStatus || 0, pauseQueue, blockWorker, recoverable, elapsed: (Date.now() - start) / 1000 });
      return { success: false, error, pauseQueue, blockWorker, recoverable, elapsed: (Date.now() - start) / 1000 };
    } finally {
      this.busy = false;
      this.taskSignal = null;
    }
  }
}

module.exports = { ChatGPTDriver };
