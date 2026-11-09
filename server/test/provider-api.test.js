"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LocalApi } = require("../../electron/localApi");

test("API dispatches Gemini and ChatGPT to separate queues with ordered references", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "image-provider-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const queues = Object.fromEntries(["chatgpt", "gemini"].map(model => [model, {
    jobs: [],
    enqueueMany(items) { this.jobs.push(...items); return [{ job_id: `${model}-id` }]; },
    start() {}, status() { return { paused: false }; }, snapshot() { return []; },
  }]));
  const api = new LocalApi(Object.fromEntries(Object.entries(queues).map(([key, queue]) => [key, { queue }])), directory);
  const server = http.createServer((req, res) => api.handle(req, res).catch(error => api.json(res, error.status || 500, { error: error.message })));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${api.config.api_key}`, "Content-Type": "application/json" };
  const files = ["first.png", "second.png"].map(name => { const file = path.join(directory, name); fs.writeFileSync(file, "fixture"); return file; });
  const health = await (await fetch(`${base}/api/health`, { headers })).json();
  assert.deepEqual(health.supported_models, ["chatgpt", "gemini"]);
  for (const model of ["gemini", "chatgpt"]) {
    const response = await fetch(`${base}/api/generate`, { method: "POST", headers, body: JSON.stringify({ model, prompt: "test", input_images: files }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).model, model);
    assert.deepEqual(queues[model].jobs[0].input_images, files);
  }
  assert.equal(queues.gemini.jobs[0].prompt, "test");
  assert.equal(queues.chatgpt.jobs[0].prompt, "创建图片:test");
});
