const fs = require('fs');
const path = require('path');
const { ChatGPTDriver } = require('./chatgptDriver');
const logger = require('./logger');
const { UploadError } = require('./uploadManager');
const { inspectGeminiInput } = require('./geminiInputState');

const EDITOR = 'input-area-v2 .ql-editor[contenteditable="true"][role="textbox"]';

function conversationUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'gemini.google.com' && /^\/app\/[^/]+/.test(url.pathname);
  } catch { return false; }
}

class GeminiDriver extends ChatGPTDriver {
  constructor(paths) {
    super(paths);
    this.cfg = { ...this.cfg, chatgpt_url: 'https://gemini.google.com/app', login_url: 'https://gemini.google.com/app', new_chat_url: 'https://gemini.google.com/app', browser: { ...this.cfg.browser, cdp_port: 9322 } };
  }

  loadState() {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(this.paths.stateJson, 'utf8')); } catch {}
    this.lastChatUrl = conversationUrl(state.last_chat_url) ? state.last_chat_url : null;
    this.browserEngine = state.browser_engine === 'edge' ? 'edge' : 'chrome';
    if (state.output_dir && path.isAbsolute(state.output_dir)) this.outputDirValue = state.output_dir;
  }

  saveState() {
    fs.mkdirSync(path.dirname(this.paths.stateJson), { recursive: true });
    fs.writeFileSync(this.paths.stateJson, JSON.stringify({ last_chat_url: this.lastChatUrl || null, browser_engine: this.browserEngine, output_dir: this.outputDirValue === this.paths.outputDir ? null : this.outputDirValue }, null, 2), 'utf8');
  }

  setLastChatUrl(url) {
    if (!conversationUrl(url)) return false;
    this.lastChatUrl = url;
    this.saveState();
    return true;
  }

  conversationKey(url) {
    if (!conversationUrl(url)) return null;
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  }

  browserProfileDir(engine = this.browserEngine) {
    return path.join(this.paths.dataRoot, engine === 'edge' ? 'browser_profile_gemini_edge' : 'browser_profile_gemini_chrome');
  }

  isManagedPageUrl(url) {
    try { return new URL(url).hostname === 'gemini.google.com'; } catch { return false; }
  }

  async isLoggedIn({ start = true } = {}) {
    try {
      if (start) await this.ensurePage();
      if (!this.hasLivePage() || !this.pageUrl().startsWith('https://gemini.google.com/')) return false;
      return await this.evaluate(() => !!document.querySelector('input-area-v2 .ql-editor[contenteditable="true"]') && !!document.querySelector('a[href*="accounts.google.com/SignOutOptions"],a[aria-label*="Google 账号"],a[aria-label*="Google Account"]'));
    } catch { return false; }
  }

  async openLogin() {
    if (this.busy) throw new Error('正在生成中，无法切换页面');
    await this.ensurePage({ headless: false });
    await this.showWindow();
    if (!this.pageUrl().startsWith('https://gemini.google.com/')) await this.goto('https://gemini.google.com/app');
  }

  async openNewChat() {
    if (this.busy) throw new Error('正在生成中，无法新建对话');
    await this.ensurePage();
    await this.goto('https://gemini.google.com/app');
    return this.pageUrl();
  }

  async openLastChat() {
    if (this.busy) throw new Error('正在生成中，无法切换对话');
    if (!this.lastChatUrl) throw new Error('还没有已完成的 Gemini 对话');
    await this.ensurePage();
    await this.goto(this.lastChatUrl);
    return this.pageUrl();
  }

  async inputState() {
    return this.evaluate(inspectGeminiInput);
  }

  async waitForAttachments(count) {
    const start = Date.now(), deadline = start + Math.min(300, 120 + count * 15) * 1000;
    let stableSince = 0, stableRounds = 0, last = null;
    while (Date.now() < deadline) {
      last = await this.inputState();
      this.checkUploadState(last);
      if (last.count > count) throw new Error(`输入区存在多余参考图（预期 ${count} 张，实际 ${last.count} 张）`);
      if (last.found && last.count === count && last.ready === count && !last.busy && this.uploadTransportIdle()) {
        if (!stableSince) stableSince = Date.now();
        stableRounds++;
        if (stableRounds >= 3 && Date.now() - stableSince >= 2400) {
          logger.info('gemini.attachments.confirmed', { count, elapsedSec: (Date.now() - start) / 1000 });
          return;
        }
      } else { stableSince = 0; stableRounds = 0; }
      await this.taskSleep(600);
    }
    throw new UploadError('timeout', `Gemini 参考图上传等待超时（预期 ${count} 张，实际 ${last?.count || 0} 张，就绪 ${last?.ready || 0} 张），已阻止发送`, { retryable: true });
  }

  async waitForPageReady() {
    const deadline = Date.now() + 60000;
    let stableSince = 0, rounds = 0, loggedIn = false;
    while (Date.now() < deadline) {
      loggedIn = await this.isLoggedIn({ start: false });
      if (loggedIn) {
        const state = await this.inputState();
        if (state.count) throw Object.assign(new Error(`Gemini 输入区已有 ${state.count} 张残留参考图，请显示浏览器清理后恢复该环境`), { blockWorker: true });
        if (state.text) throw Object.assign(new Error('Gemini 输入区已有未发送草稿，已保留，请检查后恢复该环境'), { blockWorker: true });
        const generating = await this.evaluate(() => [...document.querySelectorAll('button')].some(el => /停止回答|stop response|stop generating/i.test(el.getAttribute('aria-label') || '')));
        if (state.found && !state.busy && !generating) {
          if (!stableSince) stableSince = Date.now();
          if (++rounds >= 3 && Date.now() - stableSince >= 1800) {
            await this.ensureAuthenticatedPageWindowControls();
            return;
          }
        } else { stableSince = 0; rounds = 0; }
      } else { stableSince = 0; rounds = 0; }
      await this.taskSleep(900);
    }
    throw new Error(loggedIn ? 'Gemini 页面尚未恢复，请显示浏览器检查' : '请显示 Gemini 浏览器并登录 Google 账号');
  }

  async openToolsMenu() {
    const isExpanded = await this.evaluate(() => {
      const btn = document.querySelector('input-area-v2 button[aria-label*="上传和工具"], input-area-v2 button[aria-label*="Upload and tools"], input-area-v2 button[aria-label*="Upload files and tools"]');
      if (btn && btn.getAttribute('aria-expanded') === 'true') return true;
      return !!document.querySelector('gem-menu-item');
    }).catch(() => false);
    if (isExpanded) return;
    const button = this.page.locator('input-area-v2 button[aria-label*="上传和工具"], input-area-v2 button[aria-label*="Upload and tools"], input-area-v2 button[aria-label*="Upload files and tools"]').first();
    await button.waitFor({ state: 'visible', timeout: 15000 });
    this.assertTaskActive();
    await button.click();
    await this.taskSleep(300);
  }

  async ensureImageMode() {
    try {
      const selected = this.page.locator('input-area-v2 button[aria-label*="取消选择"][aria-label*="图片"],input-area-v2 button[aria-label*="Deselect"][aria-label*="image"],input-area-v2 button[aria-label*="Remove image"]');
      if (await selected.count() && await selected.first().isVisible()) return;
      await this.openToolsMenu();
      const imageTool = this.page.locator('gem-menu-item[role="menuitemcheckbox"]').filter({ hasText: /制作图片|create images|create image/i }).first();
      if (await imageTool.count() && await imageTool.isVisible()) {
        this.assertTaskActive();
        await imageTool.click();
        await selected.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
      }
    } catch (e) {
      this.assertTaskActive();
      logger.warn('gemini.ensure_image_mode.skipped', { error: e.message || String(e) });
    }
  }

  async uploadImages(files, progress) {
    for (const file of files) if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new UploadError('file', '参考图不存在或路径不可访问，请重新添加参考图');
    await this.performReferenceUpload(files, progress, uploadFiles => this.withInputLock(async () => {
      await this.openToolsMenu();
      const upload = this.page.locator('gem-menu-item[role="menuitem"][aria-label*="上传文件"], gem-menu-item[role="menuitem"][aria-label*="Upload files"], button[data-test-id="local-images-files-uploader-button"]').first();
      await upload.waitFor({ state: 'visible', timeout: 10000 });
      this.assertTaskActive();
      const [chooser] = await Promise.all([this.page.waitForEvent('filechooser', { timeout: 15000 }), upload.click()]);
      this.assertTaskActive();
      if (!chooser.isMultiple() && files.length > 1) throw new Error('Gemini 上传控件不支持批量文件，已阻止发送');
      await chooser.setFiles(uploadFiles);
    }), () => this.waitForAttachments(files.length));
  }

  async clearUnsentUpload() {
    const draft = this.automationDraft;
    if (!draft || draft.submissionAttempted) return false;
    return this.withInputLock(async () => {
      const composer = await this.readComposerDraft();
      const expected = String(draft.prompt || '').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();
      if (!composer.found || (composer.text && (!draft.inputStarted || composer.text !== expected))) return false;
      if (composer.text) await this.typeText(EDITOR, '');
      for (let round = 0; round < 8; round += 1) {
        const state = await this.inputState();
        if (state.count > (this.pendingAutomationAttachments?.count || draft.referenceCount || 0)) return false;
        if (state.found && !state.count && !state.busy) {
          this.pendingAutomationAttachments = null;
          this.automationDraft = null;
          this.releaseDeferredReferences();
          return true;
        }
        const removed = await this.evaluate(maximum => {
          const root = document.querySelector('input-area-v2');
          if (!root) return 0;
          const controls = [...root.querySelectorAll('button,[role="button"]')].filter(button => {
            const label = button.getAttribute('aria-label') || button.getAttribute('title') || '';
            return !button.disabled && /^(?:remove|delete|移除|删除|去除)/i.test(label.trim())
              && (button.closest('[class*="gem-attachment-content"]') || /file|attachment|文件|附件/i.test(label));
          }).slice(0, maximum);
          controls.forEach(button => button.click());
          return controls.length;
        }, this.pendingAutomationAttachments?.count || draft.referenceCount || 0);
        if (!removed) return false;
        await this.taskSleep(500);
      }
      return false;
    }).catch(error => { this.assertTaskActive(); logger.warn('gemini.upload.cleanup_failed', { kind: error.uploadKind || 'composer_not_clear' }); return false; });
  }

  async responseState() {
    return this.evaluate(() => ({
      users: document.querySelectorAll('user-query').length,
      lastUserImages: [...document.querySelectorAll('user-query')].at(-1)?.querySelectorAll('img').length || 0,
      responses: document.querySelectorAll('model-response').length,
      generating: [...document.querySelectorAll('button')].some(el => /停止回答|stop response|stop generating/i.test(el.getAttribute('aria-label') || '')),
      results: [...document.querySelectorAll('model-response')].map(r => {
        const hasDownloadBtn = !!r.querySelector('button[aria-label*="下载完整尺寸"],button[aria-label*="Download full"]');
        return [...r.querySelectorAll('img')].filter(img => {
          if (!img.complete || img.naturalWidth < 80 || img.naturalHeight < 80) return false;
          const alt = (img.alt || '').toLowerCase();
          const isAiAlt = /ai 生成|generated|imagen/i.test(alt);
          return isAiAlt || hasDownloadBtn || (img.naturalWidth >= 200 && img.naturalHeight >= 200);
        }).map(img => ({ width: img.naturalWidth, height: img.naturalHeight, src: img.currentSrc || img.src }));
      }),
    }));
  }

  async downloadImageFromDom(responseIndex, outPath) {
    const b64 = await this.evaluate(async (idx) => {
      const resp = document.querySelectorAll('model-response')[idx];
      if (!resp) return null;
      const img = resp.querySelector('img');
      if (!img) return null;
      try {
        const response = await fetch(img.currentSrc || img.src);
        const blob = await response.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const res = String(reader.result || '');
            const base64 = res.includes(',') ? res.split(',')[1] : res;
            resolve(base64);
          };
          reader.readAsDataURL(blob);
        });
      } catch {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        return dataUrl.split(',')[1];
      }
    }, responseIndex);
    if (!b64) throw new Error('从页面提取图片数据失败');
    this.assertTaskActive();
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    return outPath;
  }

  async saveFullImage(responseIndex, jobId, prompt, name, queueIndex, queuePart) {
    const base = String(name || prompt || 'image').replace(/[\\/:*"<>|\r\n\t]/g, '_').replace(/\s+/g, '_').trim().slice(0, 30) || 'image';
    const prefix = queuePart ? `${Math.max(1, queueIndex)}-${queuePart}` : String(Math.max(1, queueIndex));
    const dir = path.join(this.outputDirValue, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });

    // 通过 CDP 允许静默下载并指定下载目录，防止系统弹出“另存为”对话框卡死任务
    try {
      await this.sendDevToolsCommand('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dir,
      });
    } catch (_) {}

    const root = this.page.locator('model-response').nth(responseIndex);
    const button = root.locator('button[aria-label*="下载完整尺寸"],button[aria-label*="Download full size"],button[aria-label*="Download full-size"]').first();

    let file = null;
    try {
      if (await button.count() && await button.first().isVisible()) {
        this.assertTaskActive();
        const [download] = await this.withInputLock(() => Promise.all([
          this.page.waitForEvent('download', { timeout: 30000 }),
          button.click(),
        ]));
        this.assertTaskActive();
        const ext = path.extname(download.suggestedFilename()).toLowerCase();
        const suffix = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';
        file = path.join(dir, `${prefix}_${base}${suffix}`);
        let duplicate = 2;
        while (fs.existsSync(file)) file = path.join(dir, `${prefix}_${base}_${duplicate++}${suffix}`);
        this.assertTaskActive();
        await download.saveAs(file);
      }
    } catch (downloadErr) {
      this.assertTaskActive();
      logger.warn('gemini.download_button.fallback', { jobId, error: downloadErr.message || String(downloadErr) });
    }

    // 如果原尺寸下载未触发或未成功，Fallback 从 DOM 提取已渲染的图片
    if (!file || !fs.existsSync(file) || !fs.statSync(file).size) {
      const fallbackFile = path.join(dir, `${prefix}_${base}.png`);
      let duplicate = 2;
      let finalPath = fallbackFile;
      while (fs.existsSync(finalPath)) finalPath = path.join(dir, `${prefix}_${base}_${duplicate++}.png`);
      file = await this.downloadImageFromDom(responseIndex, finalPath);
      logger.info('gemini.image_saved_via_dom_fallback', { jobId, file });
    }

    if (!fs.existsSync(file) || !fs.statSync(file).size) throw new Error('Gemini 图片保存为空');
    return file;
  }

  async fillGeminiPrompt(prompt) {
    const text = String(prompt || '');
    const normalize = value => String(value || '').replace(/[\u200b\ufeff]/g, '').replace(/\s+/gu, ' ').trim();
    const expected = normalize(text);
    if (!expected) throw new Error('Gemini 提示词不能为空');
    await this.assertAutomationCanWrite(text);
    await this.clickSelector(EDITOR);
    try {
      await this.dispatchKey('a', 'KeyA', 65, 2);
      await this.dispatchKey('Delete', 'Delete', 46);
      await this.sendDevToolsCommand('Input.insertText', { text });
    } catch (error) {
      throw new Error(`Gemini 提示词输入状态不确定，请检查输入框：${error.message || String(error)}`);
    }
    const deadline = Date.now() + 5000;
    let actual = '';
    while (Date.now() < deadline) {
      actual = await this.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? String(el.innerText || el.textContent || '') : '';
      }, EDITOR);
      if (normalize(actual) === expected) return;
      await this.taskSleep(250);
    }
    logger.warn('gemini.prompt.verification_failed', { expectedLength: expected.length, actualLength: normalize(actual).length });
    throw new Error('Gemini 输入框的提示词未能完整确认，请显示浏览器检查');
  }

  async generate({ prompt, jobId, name, inputImages = [], queueIndex = 1, queuePart = null, progress, signal }) {
    this.taskSignal = signal || null;
    const savedPaths = [];
    let touched = false, sent = false;
    this.busy = true;
    try {
      this.assertTaskActive();
      await this.ensurePage();
      if (progress) await progress('ready', '等待 Gemini 页面就绪');
      await this.waitForPageReady();
      await this.assertPrimaryComposerClear({ requireComposer: true });
      const files = [...new Set(inputImages.map(v => String(v || '').trim()).filter(Boolean))];
      this.automationDraft = { jobId, prompt, referenceCount: files.length, submissionAttempted: false };
      const before = await this.withUploadLock(files, progress, async () => {
        if (files.length) {
          touched = true;
          await this.uploadImages(files, progress);
        } else {
          await this.withInputLock(() => this.ensureImageMode());
        }
        if (progress) await progress('typing', '等待填写与发送');
        return this.withInputLock(async () => {
          const before = await this.responseState();
          touched = true;
          if (progress) await progress('typing', '输入提示词');
          await this.fillGeminiPrompt(prompt);
          if (files.length) {
            const state = await this.inputState();
            this.checkUploadState(state);
            if (!state.found || state.count !== files.length || state.ready !== files.length || state.busy || !this.uploadTransportIdle()) {
              await this.waitForAttachments(files.length);
            }
          }
          const selectors = ['input-area-v2 button[aria-label*="发送"], input-area-v2 button[aria-label*="Send message"], input-area-v2 button[aria-label*="Send"]'];
          const control = await this.waitForSendControl(selectors, files.length, progress);
          const send = this.page.locator(control.sel).nth(control.index);
          this.assertTaskActive();
          if (this.automationDraft) this.automationDraft.submissionAttempted = true;
          sent = true;
          await send.click();
          const confirmDeadline = Date.now() + 20000;
          let confirmed = false;
          while (Date.now() < confirmDeadline) {
            const current = await this.responseState();
            if (current.users > before.users && current.lastUserImages === files.length) {
              const input = await this.inputState();
              if (input.found && !input.count && !input.text) { confirmed = true; break; }
            }
            if (current.users > before.users && current.lastUserImages > files.length) throw new Error('Gemini 已发送的参考图数量异常');
            await this.taskSleep(600);
          }
          if (!confirmed) throw new Error(`无法确认 Gemini 已接收任务及全部 ${files.length} 张参考图`);
          this.pendingAutomationAttachments = null;
          this.automationDraft = null;
          return before;
        });
      });
      if (progress) await progress('generating', '等待 Gemini 生成图片');
      const deadline = Date.now() + 600000;
      let fingerprint = '', stableSince = 0, rounds = 0;
      while (Date.now() < deadline) {
        const current = await this.responseState();
        const index = current.responses - 1;
        const image = current.responses > before.responses ? current.results[index]?.[0] : null;
        if (image && !current.generating) {
          const next = `${image.src}|${image.width}x${image.height}`;
          if (next !== fingerprint) { fingerprint = next; stableSince = Date.now(); rounds = 0; }
          if (++rounds >= 3 && Date.now() - stableSince >= 3000) {
            if (progress) await progress('image_done', '下载 Gemini 原尺寸图片');
            const file = await this.saveFullImage(index, jobId, prompt, name, queueIndex, queuePart);
            savedPaths.push(file);
            this.assertTaskActive();
            this.setLastChatUrl(this.pageUrl());
            return { success: true, image_paths: [file] };
          }
        } else { fingerprint = ''; rounds = 0; }
        await this.taskSleep(900);
      }
      throw new Error('等待 Gemini 图片生成超时（600 秒），请显示浏览器检查');
    } catch (error) {
      if (signal?.aborted) return { success: false, cancelled: true, error: '已停止', image_paths: savedPaths };
      if (error.uploadFatal) this.uploadCoordinator.block(error);
      const recoverable = !!error.uploadCleaned && !!error.uploadUnsent && !error.uploadFatal;
      const blockWorker = !!error.blockWorker && !error.uploadFatal;
      const pauseQueue = !recoverable && !blockWorker;
      logger.warn('gemini.generate.failed', { jobId, touched, sent, kind: error.uploadKind || null, status: error.httpStatus || 0, pauseQueue, blockWorker, recoverable, error: error.message || String(error) });
      return { success: false, pauseQueue, blockWorker, recoverable, error: error.message || String(error) };
    } finally { this.busy = false; this.taskSignal = null; }
  }
}

module.exports = { GeminiDriver };
