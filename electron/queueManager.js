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

class QueueManager extends EventEmitter {
  constructor(driver, { stateFile = null } = {}) {
    super();
    this.driver = driver;
    this.stateFile = stateFile;
    this.jobs = [];
    this.byId = new Map();
    this.running = false;
    this.stopFlag = false;
    this.loadState();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopFlag = false;
    this.loop();
  }

  stop() {
    this.stopFlag = true;
    this.running = false;
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
    const unfinished = status === "queued" || status === "running";
    return {
      job_id: String(raw.job_id || jobId()),
      prompt,
      display_prompt: String(raw.display_prompt || prompt).trim(),
      count: 1,
      name: raw.name || null,
      chat_mode: raw.chat_mode || "new",
      input_images: Array.isArray(raw.input_images) ? raw.input_images.map((p) => String(p || "").trim()).filter(Boolean) : [],
      status: unfinished ? "failed" : status,
      image_paths: Array.isArray(raw.image_paths) ? raw.image_paths.map((p) => String(p || "").trim()).filter(Boolean) : [],
      error: unfinished ? "上次退出时未完成" : (raw.error || null),
      stage: unfinished ? "failed" : (raw.stage || ""),
      detail: unfinished ? "上次退出时未完成" : (raw.detail || ""),
      created_at: Number(raw.created_at || now()),
      started_at: raw.started_at ? Number(raw.started_at) : null,
      finished_at: raw.finished_at ? Number(raw.finished_at) : (unfinished ? now() : null),
      group_id: raw.group_id || null,
    };
  }

  loadState() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const loaded = Array.isArray(raw.jobs) ? raw.jobs.map((j) => this.normalizeLoadedJob(j)).filter(Boolean) : [];
      this.jobs = loaded;
      this.byId = new Map(loaded.map((job) => [job.job_id, job]));
      logger.info("queue.state.loaded", { count: loaded.length, file: this.stateFile });
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
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, saved_at: now(), jobs }, null, 2), "utf8");
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      logger.warn("queue.state.save.failed", e);
    }
  }

  enqueue(prompt, { name = null, chatMode = "new", groupId = null, inputImages = [], displayPrompt = null } = {}) {
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
      const groupId = itemCount > 1 ? jobId() : null;
      for (let i = 0; i < Math.max(1, itemCount); i += 1) {
        jobs.push(this.enqueue(prompt, { name, chatMode, groupId, inputImages, displayPrompt }));
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
    this.saveState();
    return this.snapshot();
  }

  retry(id) {
    const job = this.byId.get(id);
    if (!job) return null;
    if (job.status === "running" || job.status === "queued") return job;
    job.status = "queued";
    job.error = null;
    job.image_paths = [];
    job.stage = "";
    job.detail = "";
    job.started_at = null;
    job.finished_at = null;
    this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
    this.start();
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

  async loop() {
    while (this.running && !this.stopFlag) {
      const job = this.pickNext();
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      await this.runJob(job);
    }
  }

  async runJob(job) {
    job.status = "running";
    job.started_at = now();
    this.emitEvent({ type: "job_updated", job: this.publicJob(job) });

    const progress = async (stage, detail) => {
      job.stage = stage;
      job.detail = detail;
      this.emitEvent({ type: "progress", job_id: job.job_id, stage, detail });
    };

    try {
      const numbering = this.outputNumberingFor(job);
      const result = await this.driver.generate({
        prompt: job.prompt,
        jobId: job.job_id,
        name: job.name,
        inputImages: job.input_images,
        chatMode: job.chat_mode,
        queueIndex: numbering.queueIndex,
        queuePart: numbering.queuePart,
        progress,
      });
      job.finished_at = now();
      if (result.success) {
        job.status = "done";
        job.image_paths = result.image_paths;
        job.stage = "done";
        job.detail = `完成,共 ${job.image_paths.length} 张`;
      } else {
        job.status = "failed";
        job.error = result.error || "未知错误";
        job.stage = "failed";
        job.detail = job.error;
      }
    } catch (e) {
      job.status = "failed";
      job.error = `${e.name || "Error"}: ${e.message || e}`;
      job.finished_at = now();
      job.stage = "failed";
      job.detail = job.error;
    }
    this.emitEvent({ type: "job_updated", job: this.publicJob(job) });
  }
}

module.exports = { QueueManager };
