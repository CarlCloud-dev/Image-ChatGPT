const fs = require("fs");
const path = require("path");
const os = require("os");
const logger = require("./logger");

const ownedStaging = new Set();

class UploadError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = "UploadError";
    this.uploadKind = kind;
    this.retryable = !!options.retryable;
    this.uploadFatal = !!options.fatal;
    this.httpStatus = options.status || 0;
    this.retryAfterMs = options.retryAfterMs || 0;
    this.retryUntil = this.retryAfterMs ? Date.now() + this.retryAfterMs : 0;
  }
}

function uploadProblem(text = "", status = 0, retryAfterMs = 0) {
  if (status === 429 || /rate.?limit|upload.?limit|too many|quota|上传.{0,12}(?:上限|限额|限制|次数已用完)|(?:达到|超过).{0,12}上传|存储.{0,8}(?:已满|上限)/i.test(text)) {
    return new UploadError("limit", `网页提示上传限额或频率受限${status ? `（HTTP ${status}）` : ""}，已暂停后续上传，请按网页提示等待后再继续`, { fatal: true, status, retryAfterMs });
  }
  if ([401, 403].includes(status) || /sign.?in|log.?in|unauthorized|forbidden|登录.{0,8}(?:过期|失效)|请.{0,5}登录/i.test(text)) {
    return new UploadError("access", `参考图上传授权或访问被拒绝${status ? `（HTTP ${status}）` : ""}，请显示浏览器检查登录及网页提示`, { fatal: true, status });
  }
  if ([413, 415, 422].includes(status) || /too large|unsupported|invalid image|invalid file|file.{0,8}corrupt|图片.{0,8}(?:过大|损坏)|不支持.{0,8}(?:格式|文件)/i.test(text)) {
    return new UploadError("file", `网页拒绝此参考图${status ? `（HTTP ${status}）` : ""}，请检查大小、格式及图片内容`, { status });
  }
  if (status >= 400 && status < 500 && ![408, 409, 425].includes(status)) {
    return new UploadError("rejected", `网页拒绝参考图上传（HTTP ${status}），请查看浏览器中的具体提示`, { status });
  }
  return new UploadError(status >= 500 ? "server" : "network", status
    ? `参考图上传服务暂时出错（HTTP ${status}）`
    : "网页显示参考图上传失败或上传连接中断", { status, retryable: true });
}

function validateReferences(files, maxBytes = 20 * 1024 * 1024) {
  const metadata = [];
  for (const name of files) {
    let file;
    try { file = fs.statSync(name); } catch { throw new UploadError("file", "参考图不存在或无法读取，请重新添加参考图"); }
    if (!path.isAbsolute(name) || !file.isFile() || file.size === 0) throw new UploadError("file", "参考图不是有效的本地图片文件");
    if (file.size > maxBytes) throw new UploadError("file", `参考图超过单张 ${Math.floor(maxBytes / 1048576)} MB，请缩小图片后重新添加`);
    const header = Buffer.alloc(16);
    const fd = fs.openSync(name, "r");
    try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
    const format = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
      : header[0] === 255 && header[1] === 216 && header[2] === 255 ? "jpeg"
      : /^GIF8[79]a/.test(header.toString("ascii", 0, 6)) ? "gif"
      : header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP" ? "webp" : "";
    if (!format) throw new UploadError("file", "参考图文件内容不是可识别的 PNG/JPEG/WebP/GIF 图片，请重新导出后添加");
    metadata.push({ format, bytes: file.size });
  }
  return metadata;
}

async function stageReferenceFiles(files, metadata, signal) {
  if (signal?.aborted) throw signal.reason;
  let directory;
  try {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "image-chatgpt-ref-")));
  } catch {
    throw new UploadError("local", "无法创建参考图上传临时目录，请检查临时目录权限和磁盘空间", { fatal: true });
  }
  let retries = 0, timer = null;
  const staged = {
    files: [],
    dispose(retry = true) {
      if (timer) { clearTimeout(timer); timer = null; }
      let failed = false;
      try {
        // Delete only the generated files inside this exact owned directory.
        if (fs.realpathSync(directory) !== directory) throw new Error("staging_directory_changed");
        for (const file of staged.files) {
          if (path.dirname(file) !== directory) throw new Error("staging_file_outside_directory");
          try { fs.unlinkSync(file); }
          catch (error) { if (error.code !== "ENOENT") failed = true; }
        }
        if (!failed) fs.rmdirSync(directory);
      } catch (error) { if (error.code !== "ENOENT") failed = true; }
      if (!failed) { ownedStaging.delete(staged); return; }
      if (retry && retries < 3) {
        timer = setTimeout(() => staged.dispose(), [2000, 10000, 30000][retries++]);
        timer.unref?.();
      }
      logger.warn("upload.staging.cleanup_deferred", { files: staged.files.length, retries });
    },
  };
  ownedStaging.add(staged);
  try {
    for (let index = 0; index < files.length; index += 1) {
      if (signal?.aborted) throw signal.reason;
      const format = metadata[index]?.format;
      if (!["png", "jpeg", "gif", "webp"].includes(format)) throw new Error("invalid_reference_format");
      const extension = format === "jpeg" ? "jpg" : format;
      // Never rename originals. Strip Chinese and punctuation from the upload
      // basename; an ordered suffix also prevents collisions after filtering.
      const stem = path.basename(files[index], path.extname(files[index]))
        .replace(/[^A-Za-z0-9]/g, "").slice(0, 48) || "image";
      const target = path.join(directory, `${stem}_${String(index + 1).padStart(3, "0")}.${extension}`);
      staged.files.push(target);
      await fs.promises.copyFile(files[index], target, fs.constants.COPYFILE_EXCL);
      if ((await fs.promises.stat(target)).size !== metadata[index].bytes) throw new Error("reference_changed_during_copy");
    }
    if (signal?.aborted) throw signal.reason;
  } catch (error) {
    staged.dispose();
    if (signal?.aborted) throw signal.reason;
    throw new UploadError(error.code === "ENOSPC" ? "local" : "file", "无法准备参考图上传副本，请检查原图读取权限及磁盘空间", { fatal: error.code === "ENOSPC" });
  }
  logger.info("upload.staging.created", { count: staged.files.length, safeNames: true, policy: "ascii-alphanumeric" });
  return staged;
}

process.once("exit", () => {
  for (const staged of ownedStaging) {
    try { staged.dispose(false); } catch {}
  }
});

class UploadCoordinator {
  constructor() {
    this.tail = Promise.resolve();
    this.pending = new Set();
    this.parsing = new Set();
    this.blocked = null;
    this.cooldownUntil = 0;
    this.lastFinishedAt = 0;
  }

  block(error) {
    if (!error.uploadFatal) return;
    if (!this.blocked || (error.uploadKind === "limit" && this.blocked.uploadKind !== "limit")) this.blocked = error;
    if (error.retryUntil) this.cooldownUntil = Math.max(this.cooldownUntil, error.retryUntil);
  }

  check() {
    if (this.blocked) {
      const seconds = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
      if (seconds > 0) throw new UploadError(this.blocked.uploadKind, `${this.blocked.message}；上传通道仍需等待 ${seconds} 秒`, { fatal: true, status: this.blocked.httpStatus });
      throw this.blocked;
    }
  }

  resume() {
    if (!this.blocked) return;
    if (this.cooldownUntil > Date.now()) this.check();
    if (this.pending.size || this.parsing.size) throw new UploadError("pending", "浏览器仍有未结束的上传请求，请检查该标签后再继续", { fatal: true });
    this.blocked = null;
  }

  async run(driver, progress, action) {
    this.check();
    const previous = this.tail.catch(() => {});
    let release;
    const turn = new Promise(resolve => { release = resolve; });
    this.tail = previous.then(() => turn);
    try {
      if (progress) await progress("uploading", "等待参考图上传通道（每次一个任务）");
      await driver.taskOperation(previous);
      driver.assertTaskActive();
      this.check();
      const pendingDeadline = Date.now() + 15000;
      while ((this.pending.size || this.parsing.size) && Date.now() < pendingDeadline) {
        this.check();
        await driver.taskSleep(500);
      }
      if (this.pending.size || this.parsing.size) {
        const error = new UploadError("pending", "上次参考图上传请求尚未结束，已暂停后续上传，请检查浏览器", { fatal: true });
        this.block(error);
        throw error;
      }
      const delay = Math.max(this.lastFinishedAt + 1000, this.cooldownUntil) - Date.now();
      if (delay > 0) await driver.taskSleep(delay);
      this.check();
      return await action();
    } finally {
      this.lastFinishedAt = Date.now();
      release();
    }
  }
}

function isUploadRequest(request) {
  if (!["POST", "PUT", "PATCH"].includes(request.method())) return false;
  try {
    const url = new URL(request.url());
    return ((url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com")) && /\/backend-api\/(?:f\/)?(?:files?|uploads?|attachments?)(?:\/|$)/i.test(url.pathname))
      || url.hostname === "files.openai.com"
      || /(?:\.blob\.core\.windows\.net|\.oaiusercontent\.com|\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com)$/.test(url.hostname)
      || ((url.hostname.endsWith(".google.com") || /\.(?:googleapis|googleusercontent)\.com$/.test(url.hostname)) && /upload|UploadFile|fileupload/i.test(url.pathname));
  } catch { return false; }
}

function watchUpload(page, coordinator, slot, files, maxBytes) {
  const metadata = validateReferences(files, maxBytes);
  const attempt = { failure: null, inFlight: new Set(), parsing: new Set(), successes: 0, cancelledRequests: 0, observed: false };
  let accepting = true, detached = false;
  const idleCallbacks = new Set();
  const flushIdle = () => {
    if (accepting || attempt.inFlight.size || attempt.parsing.size) return;
    for (const callback of idleCallbacks) {
      idleCallbacks.delete(callback);
      try { callback(); } catch { logger.warn("upload.staging.cleanup_failed", { slot }); }
    }
  };
  const mark = (error, host, networkCode = null) => {
    if (attempt.failure?.uploadFatal && !error.uploadFatal) return;
    attempt.failure = error;
    coordinator.block(error);
    logger.warn("upload.transport.failed", { slot, host, kind: error.uploadKind, status: error.httpStatus, networkCode, retryAfterMs: error.retryAfterMs });
  };
  const request = item => {
    if (!accepting || !isUploadRequest(item)) return;
    attempt.observed = true;
    attempt.inFlight.add(item);
    coordinator.pending.add(item);
  };
  const detach = () => {
    if (detached) { flushIdle(); return; }
    detached = true;
    page.off("request", request);
    page.off("response", response);
    page.off("requestfinished", finished);
    page.off("requestfailed", failed);
    page.off("close", closed);
    flushIdle();
  };
  const finished = item => {
    if (!attempt.inFlight.delete(item)) return;
    coordinator.pending.delete(item);
    if (!accepting && !attempt.inFlight.size && !attempt.parsing.size) detach();
  };
  const failed = item => {
    if (attempt.inFlight.has(item) && accepting && !attempt.cleaning && !attempt.failure) {
      let host = "";
      try { host = new URL(item.url()).hostname; } catch {}
      const failure = item.failure()?.errorText || "";
      const networkCode = failure.match(/(?:net::)?ERR_[A-Z0-9_]+/)?.[0] || "REQUEST_FAILED";
      // A cancelled request may be replaced by the page's own upload retry.
      // Keep waiting for attachment readiness or an explicit error/timeout;
      // cancellation alone must not cause us to remove the attachments.
      if (/^(?:net::)?ERR_ABORTED$/.test(networkCode)) {
        attempt.cancelledRequests += 1;
        logger.info("upload.transport.cancelled", { slot, host, networkCode, awaitingPageState: true });
      } else mark(uploadProblem(""), host, networkCode);
    }
    finished(item);
  };
  const response = item => {
    if (!attempt.inFlight.has(item.request())) return;
    const status = item.status();
    if (status < 400) { attempt.successes += 1; return; }
    const parse = (async () => {
      const headers = item.headers();
      const after = headers["retry-after"] || "";
      const retryAfterMs = /^\d+$/.test(after) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now()) || 0;
      let text = "";
      if (/json/i.test(headers["content-type"] || "") && Number(headers["content-length"] || 0) <= 32768) {
        let timer;
        try { text = await Promise.race([item.text(), new Promise(resolve => { timer = setTimeout(() => resolve(""), 2000); })]); }
        catch {} finally { clearTimeout(timer); }
        if (text.length > 32768) text = "";
      }
      // Error bodies are classified in memory only. Never log credentials,
      // response bodies, file names, query strings, or signed upload URLs.
      if (!page.isClosed()) mark(uploadProblem(text, status, retryAfterMs), new URL(item.url()).hostname);
    })();
    attempt.parsing.add(parse);
    coordinator.parsing.add(parse);
    parse.then(() => { attempt.parsing.delete(parse); coordinator.parsing.delete(parse); if (!accepting && !attempt.inFlight.size) detach(); }, () => {
      attempt.parsing.delete(parse);
      coordinator.parsing.delete(parse);
      if (!page.isClosed()) mark(uploadProblem("", status), "");
      if (!accepting && !attempt.inFlight.size) detach();
    });
  };
  const closed = () => {
    accepting = false;
    for (const item of attempt.inFlight) coordinator.pending.delete(item);
    attempt.inFlight.clear();
    detach();
  };
  attempt.dispose = () => {
    accepting = false;
    page.off("request", request);
    if (!attempt.inFlight.size && !attempt.parsing.size) detach();
  };
  attempt.onIdle = callback => { idleCallbacks.add(callback); flushIdle(); };
  page.on("request", request);
  page.on("response", response);
  page.on("requestfinished", finished);
  page.on("requestfailed", failed);
  page.on("close", closed);
  logger.info("upload.attempt.started", { slot, files: metadata });
  return attempt;
}

module.exports = { UploadCoordinator, UploadError, uploadProblem, validateReferences, stageReferenceFiles, watchUpload };
