const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class LocalApi {
  constructor(queue, configDir) {
    this.queue = queue;
    this.file = path.join(configDir, "local_api.json");
    this.server = null;
    this.operations = Promise.resolve();
    this.config = { port: 8765, api_key: crypto.randomBytes(24).toString("hex") };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.config = this.validate(saved);
    } catch (_) { /* First run or invalid settings: use defaults, remain off. */ }
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.config, null, 2), "utf8");
  }

  validate(value) {
    const port = Number(value.port);
    const key = String(value.api_key || "").trim();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口须为 1024–65535 的整数");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new Error("访问密钥须为 16–128 位字母、数字、下划线或短横线");
    return { port, api_key: key };
  }

  status() {
    return { ...this.config, enabled: !!this.server, base_url: `http://127.0.0.1:${this.config.port}` };
  }

  update(body) {
    const operation = this.operations.then(async () => {
      if (body.config) {
        if (this.server) throw new Error("请先关闭 API，再修改配置");
        const config = this.validate(body.config);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(config, null, 2), "utf8");
        this.config = config;
      }
      if (body.enabled === false) await this.stop();
      if (body.enabled === true && !this.server) {
        const server = http.createServer((req, res) => {
          this.handle(req, res).catch((error) => {
            if (!res.headersSent) this.json(res, error.status || 500, { error: error.status ? error.message : "服务内部错误" });
            else res.destroy();
          });
        });
        server.requestTimeout = 15000;
        server.headersTimeout = 10000;
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.config.port, "127.0.0.1", resolve);
        });
        server.on("error", () => {});
        this.server = server;
      }
      return this.status();
    });
    this.operations = operation.catch(() => {});
    return operation;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }

  json(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  fail(message, status = 400) {
    throw Object.assign(new Error(message), { status });
  }

  async body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) this.fail("Content-Type 必须为 application/json", 415);
    let size = 0;
    const parts = [];
    for await (const part of req) {
      size += part.length;
      if (size > 1024 * 1024) this.fail("请求体不能超过 1 MB", 413);
      parts.push(part);
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
    catch (_) { this.fail("无效 JSON"); }
  }

  async handle(req, res) {
    const expected = Buffer.from(`Bearer ${this.config.api_key}`);
    const actual = Buffer.from(req.headers.authorization || "");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return this.json(res, 401, { error: "访问密钥无效" });
    }
    if (req.headers.origin) return this.json(res, 403, { error: "仅支持本地程序调用" });
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/health") return this.json(res, 200, { ok: true });
    if (req.method === "POST" && ["/api/generate", "/api/generate/image"].includes(url.pathname)) {
      const body = await this.body(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) this.fail("请求须为 JSON 对象");
      if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 50000) this.fail("prompt 必填，最多 50000 字符");
      const count = body.count === undefined ? 1 : body.count;
      if (!Number.isInteger(count) || count < 1 || count > 4) this.fail("count 须为 1–4 的整数");
      let images = [];
      if (url.pathname === "/api/generate/image") {
        if (!Array.isArray(body.input_images) || !body.input_images.length || body.input_images.length > 20) this.fail("input_images 须包含 1–20 个本机图片绝对路径");
        images = body.input_images.map((file) => {
          if (typeof file !== "string" || !path.isAbsolute(file) || !/\.(png|jpe?g|webp|gif)$/i.test(file)) this.fail("参考图须为 PNG、JPEG、WebP 或 GIF 的绝对路径");
          try { if (!fs.statSync(file).isFile()) this.fail("参考图不是文件"); }
          catch (_) { this.fail("参考图不存在或不可访问"); }
          return path.resolve(file);
        });
      } else if (body.input_images !== undefined) this.fail("图生图请使用 /api/generate/image");
      const prompt = body.prompt.trim();
      const jobs = this.queue.enqueueMany([{ prompt: `创建图片:${prompt}`, display_prompt: prompt, input_images: images }], { chatMode: "reuse", count });
      this.queue.start();
      return this.json(res, 202, { jobs: jobs.map((job) => job.job_id) });
    }
    const match = /^\/api\/jobs\/([^/]+)(?:\/images\/(\d+))?$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      const job = this.queue.snapshot().find((item) => item.job_id === match[1]);
      if (!job) return this.json(res, 404, { error: "任务不存在" });
      if (match[2] !== undefined) {
        const file = job.status === "done" && job.image_paths[Number(match[2])];
        if (!file || !fs.existsSync(file)) return this.json(res, 404, { error: "图片尚未生成或已移除" });
        const stream = fs.createReadStream(file);
        stream.on("error", () => res.destroy());
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { "Content-Type": ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[ext] || "application/octet-stream", "Cache-Control": "no-store" });
        stream.pipe(res);
        return;
      }
      return this.json(res, 200, { ...job, images: job.image_paths.map((_, index) => `/api/jobs/${job.job_id}/images/${index}`) });
    }
    this.json(res, 404, { error: "接口不存在" });
  }
}

module.exports = { LocalApi };
