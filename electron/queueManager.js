const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

function now() {
  return Date.now() / 1000;
}

function jobId() {
  return crypto.randomBytes(4).toString("hex");
}

async function waitForSetup(promise, timeoutMs, slotId, signal, operation = "会话准备") {
  if (signal?.aborted) throw signal.reason;
  let timer, onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`环境 ${slotId + 1} ${operation}超过 ${timeoutMs / 1000} 秒，请检查该标签`)), timeoutMs); }),
      ...(signal ? [new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      })] : []),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function stoppedError() {
  const error = new Error("已停止");
  error.name = "TaskStoppedError";
  error.code = "TASK_STOPPED";
  return error;
}

class QueueManager extends EventEmitter {
  constructor(driver, { stateFile = null, resetFailedWorkers = false, taskTimeoutMs = 0 } = {}) {
    super();
    this.driver = driver;
    this.stateFile = stateFile;
    this.resetFailedWorkers = resetFailedWorkers;
    this.taskTimeoutMs = taskTimeoutMs;
    this.jobs = [];
    this.byId = new Map();
    this.running = false;
    this.stopFlag = false;
    this.recoveryRequired = false;
    this.pauseReason = null;
    this.concurrency = 1;
    this.activeRuns = new Set();
    this.taskControls = new Map();
    this.shuttingDown = false;
    this.activeSlots = new Set();
    this.blockedSlots = new Set();
    this.workerSlots = new Map();
    this.browserSwitching = false;
    this.runToken = 0;
    this.lastDispatchAt = 0;
    this.nextQueueIndex = 1;
    this.loadState();
  }

  start() {
    if (this.shuttingDown) return;
    if (this.recoveryRequired) {
      logger.info("queue.start.paused", { reason: this.pauseReason, queued: this.jobs.filter(job => job.status === "queued").length });
      return;
    }
    if (this.running) return;
    this.running = true;
    this.stopFlag = false;
    const token = ++this.runToken;
    this.loop(token).catch(error => {
      logger.error("queue.loop.failed", error);
      if (this.resetFailedWorkers && !this.shuttingDown) {
        this.stop();
        setTimeout(() => this.start(), 1000);
        return;
      }
      this.pause(`队列调度异常：${error.message || error}`);
    });
  }

  stop() {
    this.stopFlag = true;
    this.running = false;
    this.runToken += 1;
  }

  shutdown() {
    this.shuttingDown = true;
    this.stop();
    for (const control of this.taskControls.values()) control.controller.abort(stoppedError());
    for (const job of this.jobs) {
      if (job.status !== "queued" && job.status !== "running") continue;
      job.status = "failed";
      job.stage = "failed";
      job.error = "应用已退出，任务未完成，请按需重试";
      job.detail = job.error;
      job.finished_at = now();
    }
    this.recoveryRequired = false;
    this.pauseReason = null;
    this.saveState();
  }

  pause(reason) {
    this.recoveryRequired = true;
    this.pauseReason = String(this.driver.uploadCoordinator.blocked?.message || reason || "浏览器状态需要检查").slice(0, 500);
    this.stop();
    this.emitEvent({ type: "queue_state", ...this.status() });
  }

  clearEmptyQueuePause() {
    // Clearing all history must not leave an unused queue paused.
    // Live worker recovery still requires explicit confirmation through Resume.
    if (this.jobs.length || this.activeRuns.size || this.workerSlots.size) return;
    this.recoveryRequired = false;
    this.pauseReason = null;
    this.blockedSlots.clear();
  }

  setConcurrency(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error("并发数须为 1 至 5");
    if (this.browserSwitching || this.activeRuns.size || this.jobs.some(job => job.status === "running")) throw new Error("请等待当前任务或浏览器切换完成后再修改并发数");
    this.concurrency = n;
    this.saveState();
    return n;
  }

  status() {
    return { concurrency: this.concurrency, paused: this.recoveryRequired, pause_reason: this.recoveryRequired ? this.pauseReason : null, queued: this.jobs.filter(job => job.status === "queued").length, active: this.jobs.filter(job => job.status === "running").length, blocked_slots: [...this.blockedSlots].map(slot => slot + 1).sort((a, b) => a - b) };
  }

  healthWorkers() {
    return [...this.workerSlots.values()].map(record => record.worker).filter(worker => worker && worker.hasLivePage());
  }

  resume() {
    this.driver.uploadCoordinator.resume();
    this.recoveryRequired = false;
    this.pauseReason = null;
    this.blockedSlots.clear();
    logger.info("queue.resumed", { concurrency: this.concurrency, queued: this.jobs.filter(job => job.status === "queued").length });
    this.start();
    this.emitEvent({ type: "queue_state", ...this.status() });
    return this.status();
  }

  async prepareBrowserSwitch() {
    if (this.activeRuns.size || this.jobs.some(job => job.status === "running")) throw new Error("请等待当前任务完成后再切换浏览器");
    if (this.recoveryRequired) throw new Error("队列已暂停，请先检查并处理异常会话后再切换浏览器");
    if ([...this.workerSlots.values()].some(record => record.pending || record.cleanupPending)) throw new Error("仍有会话正在准备或停止，请先检查浏览器或退出应用后重试");
    const engine = this.driver.getBrowserEngine();
    for (const record of this.workerSlots.values()) {
      if (record.engine !== engine || !record.worker) continue;
      const current = record.worker.conversationKey(record.worker.pageUrl());
      if (record.conversationKey && current && current !== record.conversationKey) throw new Error("并发环境的对话已改变，请先检查浏览器");
    }
    for (const record of this.workerSlots.values()) {
      if (record.engine !== engine || !record.worker) continue;
      await this.driver.releaseIsolatedWorker(record.worker);
      record.worker = null;
    }
  }

  async switchBrowserEngine(engine) {
    if (this.browserSwitching) throw new Error("浏览器正在切换，请稍后重试");
    this.browserSwitching = true;
    try {
      await this.prepareBrowserSwitch();
      const selected = await this.driver.setBrowserEngine(engine);
      this.blockedSlots.clear();
      return selected;
    } finally {
      this.browserSwitching = false;
    }
  }

  async acquireWorker(slotId, progress, signal) {
    const engine = this.driver.getBrowserEngine();
    const key = `${engine}:${slotId}`;
    let record = this.workerSlots.get(key);
    if (!record) {
      record = { engine, worker: null, pending: null, conversationKey: null, used: false };
      this.workerSlots.set(key, record);
    }
    if (record.cleanupPending) throw new Error(`环境 ${slotId + 1} 的停止操作尚未退出，请稍后恢复环境`);
    if (record.worker && !record.worker.hasLivePage()) {
      if (this.resetFailedWorkers) {
        const stale = record.worker;
        record.retired = true;
        this.workerSlots.delete(key);
        await waitForSetup(this.driver.releaseIsolatedWorker(stale, { keep: true }), 5000, slotId, signal, "旧环境清理");
        record = { engine, worker: null, pending: null, conversationKey: null, used: false };
        this.workerSlots.set(key, record);
      } else {
        if (!record.conversationKey) throw new Error(`环境 ${slotId + 1} 的标签已关闭且对话地址未知，请检查浏览器`);
        await this.driver.releaseIsolatedWorker(record.worker, { keep: true });
        record.worker = null;
      }
    }
    if (!record.worker) {
      if (!record.pending) {
        const pending = this.driver.createIsolatedWorker(record.conversationKey, slotId + 1, progress);
        record.pending = pending;
        pending.then(worker => {
          if (record.retired) {
            this.driver.releaseIsolatedWorker(worker).catch(error => logger.warn("queue.worker.late_release_failed", { error: error.message || String(error) }));
          } else if (record.pending === pending) { record.worker = worker; record.pending = null; }
        }, () => { if (record.pending === pending) record.pending = null; });
      }
      const pending = record.pending;
      if (progress) await progress("ready", "等待会话准备完成");
      const worker = await waitForSetup(pending, 90000, slotId, signal);
      if (!record.worker) record.worker = worker;
    }
    if (record.worker.hasPendingTaskOperations()) throw new Error(`环境 ${slotId + 1} 的上次浏览器操作尚未退出，请稍后恢复环境`);
    const current = record.worker.conversationKey(record.worker.pageUrl());
    if (record.conversationKey && current !== record.conversationKey) throw new Error(`环境 ${slotId + 1} 的会话已改变或尚未登录，请检查浏览器`);
    if (record.stopped) {
      if (current && !record.conversationKey) record.conversationKey = current;
      if (current) record.used = true;
      record.stopped = false;
    }
    if (record.used && !record.conversationKey) {
      if (!current) throw new Error(`环境 ${slotId + 1} 的上次会话地址未能确认，请检查浏览器`);
      record.conversationKey = current;
    }
    if (!record.used && !record.conversationKey && current) throw new Error(`环境 ${slotId + 1} 未处于新对话，请检查浏览器`);
    return record;
  }

  emitEvent(event) {
    this.emit("event", event);
    this.saveState();
  }

  normalizeLoadedJob(raw) {
    if (!raw || typeof raw !== "object") return null;
    const prompt = String(raw.prompt || "").trim();
    if (!prompt) return null;
    const status = ["queued", "running", "done", "failed"].includes(raw.status) ? raw.status : "failed";
    const interrupted = status === "running" || status === "queued";
    const interruptedReason = status === "running"
      ? "上次退出时任务未完成，发送状态不确定，请检查后重试"
      : "上次退出时任务尚未执行，请按需重试";
    return {
      job_id: String(raw.job_id || jobId()),
      prompt,
      display_prompt: String(raw.display_prompt || prompt).trim(),
      count: 1,
      name: raw.name || null,
      chat_mode: raw.chat_mode || "new",
      input_images: Array.isArray(raw.input_images) ? raw.input_images.map((p) => String(p || "").trim()).filter(Boolean) : [],
      status: interrupted ? "failed" : status,
      image_paths: Array.isArray(raw.image_paths) ? raw.image_paths.map((p) => String(p || "").trim()).filter(Boolean) : [],
      error: interrupted ? interruptedReason : (raw.error || null),
      stage: interrupted ? "failed" : (raw.stage || ""),
      detail: interrupted ? interruptedReason : (raw.detail || ""),
      created_at: Number(raw.created_at || now()),
      started_at: raw.started_at ? Number(raw.started_at) : null,
      finished_at: raw.finished_at ? Number(raw.finished_at) : (interrupted ? now() : null),
      group_id: raw.group_id || null,
      queue_index: Number.isInteger(raw.queue_index) && raw.queue_index > 0 ? raw.queue_index : null,
      queue_part: Number.isInteger(raw.queue_part) && raw.queue_part > 0 ? raw.queue_part : null,
    };
  }

  loadState() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const loaded = Array.isArray(raw.jobs) ? raw.jobs.map((j) => this.normalizeLoadedJob(j)).filter(Boolean) : [];
      // A new app session never resumes work or inherits a previous pause.
      this.recoveryRequired = false;
      this.pauseReason = null;
      this.concurrency = [1, 2, 3, 4, 5].includes(Number(raw.concurrency)) ? Number(raw.concurrency) : 1;
      const groups = new Map();
      for (const job of loaded) {
        const key = job.group_id ? `group:${job.group_id}` : `job:${job.job_id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(job);
      }
      const used = new Set(loaded.map(job => job.queue_index).filter(Boolean));
      let next = 1;
      for (const group of groups.values()) {
        let index = group.find(job => job.queue_index)?.queue_index;
        if (!index) { while (used.has(next)) next += 1; index = next++; used.add(index); }
        group.forEach((job, part) => {
          job.queue_index = index;
          if (!job.queue_part && group.length > 1) job.queue_part = part + 1;
        });
      }
      this.nextQueueIndex = Math.max(1, Number(raw.next_queue_index) || 1, ...[...used].map(n => n + 1));
      this.jobs = loaded;
      this.byId = new Map(loaded.map((job) => [job.job_id, job]));
      logger.info("queue.state.loaded", { count: loaded.length, file: this.stateFile, paused: this.recoveryRequired, reason: this.pauseReason });
      this.saveState();
    } catch (e) {
      logger.warn("queue.state.load.failed", e);
      this.jobs = [];
      this.byId = new Map();
    }
  }

  saveState() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      const jobs = this.jobs.slice(-500).map((job) => this.publicJob(job));
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, saved_at: now(), concurrency: this.concurrency, next_queue_index: this.nextQueueIndex, recovery_required: this.recoveryRequired, pause_reason: this.pauseReason, jobs }, null, 2), "utf8");
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      logger.warn("queue.state.save.failed", e);
    }
  }

  enqueue(prompt, { name = null, chatMode = "new", groupId = null, inputImages = [], displayPrompt = null, queueIndex = null, queuePart = null } = {}) {
    const normalizedImages = Array.isArray(inputImages)
      ? inputImages.map((p) => String(p || "").trim()).filter(Boolean)
      : [];
    const job = {
      job_id: jobId(),
      prompt,
      display_prompt: String(displayPrompt || prompt || "").trim(),
      count: 1,
      name,
      chat_mode: chatMode,
      input_images: normalizedImages,
      status: "queued",
      image_paths: [],
      error: null,
      stage: "",
      detail: "",
      created_at: now(),
      started_at: null,
      finished_at: null,
      group_id: groupId,
      queue_index: queueIndex || this.nextQueueIndex++,
      queue_part: queuePart,
    };
    this.jobs.push(job);
    this.byId.set(job.job_id, job);
    this.emitEvent({ type: "job_added", job: this.publicJob(job) });
    return job;
  }

  enqueueMany(prompts, { chatMode = "new", count = 1 } = {}) {
    const jobs = [];
    for (const item of prompts) {
      let prompt = "";
      let itemCount = count;
      let name = null;
      let inputImages = [];
      let displayPrompt = null;
      if (typeof item === "string") {
        prompt = item.trim();
        displayPrompt = prompt;
      } else if (item && typeof item === "object") {
        prompt = String(item.prompt || "").trim();
        displayPrompt = String(item.display_prompt || prompt || "").trim();
        itemCount = Number(item.count || count || 1);
        name = item.name || null;
        inputImages = Array.isArray(item.input_images) ? item.input_images : [];
      }
      if (!prompt) continue;
      const copies = Math.max(1, Math.floor(itemCount) || 1);
      const groupId = copies > 1 ? jobId() : null;
      const queueIndex = this.nextQueueIndex++;
      for (let i = 0; i < copies; i += 1) {
        jobs.push(this.enqueue(prompt, { name, chatMode, groupId, inputImages, displayPrompt, queueIndex, queuePart: groupId ? i + 1 : null }));
      }
    }
    return jobs;
  }

  publicJob(job) {
    return {
      ...job,
      input_images: [...(job.input_images || [])],
      image_paths: [...(job.image_paths || [])],
    };
  }

  snapshot() {
    return this.jobs.map((j) => this.publicJob(j));
  }

  clearCompleted() {
    this.jobs = this.jobs.filter((j) => j.status === "running" || j.status === "queued");
    this.byId = new Map(this.jobs.map((job) => [job.job_id, job]));
    if (!this.jobs.length && !this.activeRuns.size) this.nextQueueIndex = 1;
    this.clearEmptyQueuePause();
    this.emitEvent({ type: "queue_state", ...this.status() });
    return this.snapshot();
  }

  retry(id) {
    const job = this.byId.get(id);
    if (!job) return null;
    if (job.status === "running" || job.status === "queued") return job;
    this.driver.uploadCoordinator.resume();
    job.status = "queued";
    job.error = null;
    job.image_paths = [];
    job.stage = "";
    job.detail = "";
    job.started_at = null;
    job.finished_at = null;
    job.stop_requested = false;
    if (job.worker_slot) this.blockedSlots.delete(job.worker_slot - 1);
    this.recoveryRequired = false;
    this.pauseReason = null;
    this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
    this.start();
    return job;
  }

  retryAll() {
    const failed = this.jobs.filter(job => job.status === "failed");
    if (!failed.length) return [];
    this.driver.uploadCoordinator.resume();
    for (const job of failed) {
      job.status = "queued";
      job.error = null;
      job.image_paths = [];
      job.stage = "";
      job.detail = "";
      job.started_at = null;
      job.finished_at = null;
      job.stop_requested = false;
      if (job.worker_slot) this.blockedSlots.delete(job.worker_slot - 1);
    }
    this.recoveryRequired = false;
    this.pauseReason = null;
    for (const job of failed) this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
    this.start();
    this.emitEvent({ type: "queue_state", ...this.status() });
    return failed;
  }

  cancelRunning(id) {
    const job = this.byId.get(id);
    if (!job) return null;
    if (job.status !== "running" || job.stop_requested) return job;
    const control = this.taskControls.get(id);
    if (!control) throw new Error("任务正在切换状态，请稍后重试");
    job.stop_requested = true;
    job.stage = "stopping";
    job.detail = `环境 ${job.worker_slot}：正在停止任务`;
    control.controller.abort(stoppedError());
    this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
    return job;
  }

  async finishStopped(job, slotId, record, result) {
    if (this.shuttingDown) return;
    if (this.resetFailedWorkers) {
      job.status = "failed";
      job.stage = "failed";
      job.finished_at = now();
      job.error = this.taskControls.get(job.job_id)?.timedOut ? "任务执行超时，环境已重置" : "已停止";
      job.detail = job.error;
      if (result?.image_paths?.length) job.image_paths = result.image_paths;
      return;
    }
    record = record || this.workerSlots.get(`${this.driver.getBrowserEngine()}:${slotId}`);
    if (record) record.stopped = true;
    let reusable = false;
    if (record?.worker && !record.pending && !record.worker.hasPendingTaskOperations()) {
      const worker = record.worker;
      const current = worker.conversationKey(worker.pageUrl());
      const mismatch = record.conversationKey && current !== record.conversationKey;
      try {
        if (!mismatch) {
          const cleanup = worker.stopCurrentGeneration();
          record.cleanupPending = cleanup;
          const settled = () => { if (record.cleanupPending === cleanup) record.cleanupPending = null; };
          cleanup.then(settled, settled);
          reusable = await waitForSetup(cleanup, 15000, slotId, undefined, "停止后的页面检查");
        }
      }
      catch (error) { logger.warn("queue.stop.cleanup_failed", { jobId: job.job_id, error: error.message || String(error) }); }
      const after = worker.conversationKey(worker.pageUrl());
      if (record.conversationKey && record.conversationKey !== after) reusable = false;
      if (after && !record.conversationKey) record.conversationKey = after;
      if (after) record.used = true;
      if (reusable) {
        worker.pendingAutomationAttachments = null;
        worker.releaseDeferredReferences();
      }
    }
    if (this.shuttingDown) return;
    if (!reusable) this.blockedSlots.add(slotId);
    job.status = "failed";
    job.stage = "failed";
    job.finished_at = now();
    job.error = reusable ? "已停止" : `已停止；环境 ${slotId + 1} 需要检查，请清理输入区后点击“恢复环境”`;
    job.detail = job.error;
    if (result?.image_paths?.length) job.image_paths = result.image_paths;
    logger.info("queue.job.stopped", { jobId: job.job_id, slot: slotId + 1, reusable });
    this.emitEvent({ type: "queue_state", ...this.status() });
  }

  cancelQueued(id) {
    const job = this.byId.get(id);
    if (!job || job.status !== "queued") return null;
    job.status = "failed";
    job.error = "已停止";
    job.stage = "failed";
    job.detail = "已停止";
    job.finished_at = now();
    this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
    return job;
  }

  removeFailed(id) {
    const job = this.byId.get(id);
    if (!job || job.status !== "failed") return null;
    this.jobs = this.jobs.filter((item) => item.job_id !== id);
    this.byId.delete(id);
    if (!this.jobs.length && !this.activeRuns.size) this.nextQueueIndex = 1;
    this.clearEmptyQueuePause();
    this.emitEvent({ type: "job_removed", job_id: id });
    this.emitEvent({ type: "queue_state", ...this.status() });
    return job;
  }

  stopAll() {
    for (const job of this.jobs) {
      if (job.status === "queued") {
        job.status = "failed";
        job.error = "已取消(队列清空)";
        job.finished_at = now();
        this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
      }
    }
  }

  pickNext() {
    return this.jobs.find((j) => j.status === "queued") || null;
  }

  outputNumberingFor(job) {
    if (job.queue_index) return { queueIndex: job.queue_index, queuePart: job.queue_part || null };
    const groups = [];
    const groupMap = new Map();
    for (const current of this.jobs) {
      const key = current.group_id ? `group:${current.group_id}` : `job:${current.job_id}`;
      let group = groupMap.get(key);
      if (!group) {
        group = { jobs: [] };
        groupMap.set(key, group);
        groups.push(group);
      }
      group.jobs.push(current);
    }
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      const itemIndex = group.jobs.findIndex((item) => item.job_id === job.job_id);
      if (itemIndex < 0) continue;
      return {
        queueIndex: groupIndex + 1,
        queuePart: group.jobs.length > 1 ? itemIndex + 1 : null,
      };
    }
    return { queueIndex: 1, queuePart: null };
  }

  async loop(token) {
    while (this.running && !this.stopFlag && token === this.runToken) {
      if (this.browserSwitching) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
      while (this.running && !this.stopFlag && !this.browserSwitching && token === this.runToken && this.activeRuns.size < this.concurrency) {
        const job = this.pickNext();
        if (!job) break;
        const delay = this.concurrency > 1 ? 1000 - (Date.now() - this.lastDispatchAt) : 0;
        if (delay > 0) { await new Promise(resolve => setTimeout(resolve, delay)); continue; }
        this.lastDispatchAt = Date.now();
        const slotId = Array.from({ length: this.concurrency }, (_, i) => i).find(i => !this.activeSlots.has(i) && !this.blockedSlots.has(i));
        if (slotId === undefined) {
          if (!this.activeRuns.size && this.blockedSlots.size) {
            this.pause("所有并发环境都暂不可用，请检查各标签后继续");
          }
          break;
        }
        this.activeSlots.add(slotId);
        const run = this.runJob(job, { slotId });
        this.activeRuns.add(run);
        const release = () => { this.activeRuns.delete(run); this.activeSlots.delete(slotId); };
        run.then(release, release);
      }
      // Check for newly queued work even if another environment is still busy.
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }

  async runJob(job, { slotId = 0 } = {}) {
    const controller = new AbortController();
    const control = { controller, timedOut: false };
    this.taskControls.set(job.job_id, control);
    const timer = this.taskTimeoutMs > 0 ? setTimeout(() => {
      control.timedOut = true;
      controller.abort(Object.assign(new Error("任务执行超时"), { code: "TASK_TIMEOUT" }));
    }, this.taskTimeoutMs) : null;
    job.status = "running";
    job.started_at = now();
    job.worker_slot = slotId + 1;
    this.emitEvent({ type: "job_updated", job: this.publicJob(job) });

    const progress = async (stage, detail) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (job.status !== "running") return;
      job.stage = stage;
      job.detail = `环境 ${slotId + 1}：${detail}`;
      this.emitEvent({ type: "progress", job_id: job.job_id, stage, detail: job.detail });
    };

    let record = null;
    let preparing = true;
    try {
      const numbering = this.outputNumberingFor(job);
      await progress("ready", "准备会话");
      record = await this.acquireWorker(slotId, progress, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      preparing = false;
      const worker = record.worker;
      const generation = worker.generate({
        prompt: job.prompt,
        jobId: job.job_id,
        name: job.name,
        inputImages: job.input_images,
        chatMode: job.chat_mode,
        queueIndex: numbering.queueIndex,
        queuePart: numbering.queuePart,
        progress,
        signal: controller.signal,
      });
      const result = this.taskTimeoutMs > 0
        ? await waitForSetup(generation, this.taskTimeoutMs + 1000, slotId, controller.signal, "执行任务")
        : await generation;
      if (this.shuttingDown) return;
      if (controller.signal.aborted || result.cancelled) {
        await this.finishStopped(job, slotId, record, result);
        return;
      }
      job.finished_at = now();
      const current = worker.conversationKey(worker.pageUrl());
      const mismatch = record.conversationKey && current !== record.conversationKey;
      if (current && !record.conversationKey) record.conversationKey = current;
      if (current || result.success) record.used = true;
      if (result.success) {
        job.image_paths = result.image_paths;
        if (mismatch || !current) {
          job.status = "failed";
          job.error = this.resetFailedWorkers ? "图片已保存，但无法确认当前环境的会话地址，环境将重置" : "图片已保存，但无法确认当前环境的会话地址，已暂停队列";
          job.stage = "failed";
          job.detail = job.error;
        } else {
          job.status = "done";
          job.stage = "done";
          job.detail = `完成,共 ${job.image_paths.length} 张`;
        }
      } else {
        job.status = "failed";
        job.error = result.error || "未知错误";
        job.stage = "failed";
        job.detail = job.error;
      }
      if (this.resetFailedWorkers) {
        // The failed tab is retired in finally; other slots keep running.
      } else if (result.blockWorker) {
        this.blockedSlots.add(slotId);
        const available = Array.from({ length: this.concurrency }, (_, i) => i).some(i => !this.blockedSlots.has(i));
        logger.warn("queue.worker.blocked", { jobId: job.job_id, slot: slotId + 1, error: result.error });
        if (!available) this.pause(`所有并发环境都需要检查；环境 ${slotId + 1}：${job.error}`);
        else this.emitEvent({ type: "queue_state", ...this.status() });
      } else if (result?.pauseQueue || (!result.success && !result.recoverable) || mismatch || (result.success && !current)) {
        logger.warn("queue.paused_for_browser_recovery", { jobId: job.job_id, error: result.error || "浏览器输入区需要检查" });
        this.pause(`环境 ${slotId + 1}：${job.error || "发送或结果状态不确定，请检查浏览器"}`);
      }
    } catch (e) {
      if (this.shuttingDown) return;
      if (controller.signal.aborted) {
        await this.finishStopped(job, slotId, record);
        return;
      }
      job.status = "failed";
      job.error = `${e.name || "Error"}: ${e.message || e}`;
      job.finished_at = now();
      job.stage = "failed";
      job.detail = job.error;
      if (this.resetFailedWorkers) {
        // Do not pause the service for an individual session failure.
      } else if (preparing) {
        this.blockedSlots.add(slotId);
        const available = Array.from({ length: this.concurrency }, (_, i) => i).some(i => !this.blockedSlots.has(i));
        if (!available) this.pause(`所有并发环境都暂不可用；环境 ${slotId + 1}：${e.message || e}`);
        else this.emitEvent({ type: "queue_state", ...this.status() });
      } else {
        this.pause(`环境 ${slotId + 1}：${e.message || e}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (!this.shuttingDown && this.resetFailedWorkers && job.status === "failed") {
        await this.resetWorker(slotId);
        if (!job.stop_requested) this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
      }
      this.taskControls.delete(job.job_id);
      if (!this.shuttingDown && job.stop_requested && job.status === "failed") {
        this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
      }
    }
    if (this.resetFailedWorkers && job.status === "failed") return;
    if (!this.resetFailedWorkers && record && job.status === "failed") {
      job.error = `${job.error}（环境 ${slotId + 1} 的标签已保留，请显示浏览器检查）`;
      job.detail = job.error;
    }
    this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
  }

  async resetWorker(slotId) {
    const key = `${this.driver.getBrowserEngine()}:${slotId}`;
    const record = this.workerSlots.get(key);
    this.blockedSlots.delete(slotId);
    if (!record) return;
    record.retired = true;
    this.workerSlots.delete(key);
    const worker = record.worker;
    if (!worker) return; // A pending setup releases its worker when it settles.
    try {
      await waitForSetup(this.driver.releaseIsolatedWorker(worker), 5000, slotId, undefined, "关闭异常标签");
    } catch (error) {
      logger.warn("queue.worker.reset_failed", { slot: slotId + 1, error: error.message || String(error) });
    }
  }
}

module.exports = { QueueManager };
