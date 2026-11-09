"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { QueueManager } = require("../../electron/queueManager");
const { trackCompletedSessions } = require("../queue-policy");

function fixture(results, options = {}) {
  const closed = [];
  let created = 0;
  const driver = {
    uploadCoordinator: { resume() {} },
    getBrowserEngine: () => "chrome",
    async createIsolatedWorker() {
      const index = created++;
      const worker = {
        id: index,
        hasLivePage: () => true,
        hasPendingTaskOperations: () => false,
        conversationKey: url => url?.includes("/c/") ? url : null,
        pageUrl: () => worker.url || "https://chatgpt.com/",
        generate: () => { worker.url = "https://chatgpt.com/c/example"; return results[index](); },
      };
      if (options.waitForSetup) await options.waitForSetup;
      return worker;
    },
    async releaseIsolatedWorker(worker) { closed.push(worker.id); },
  };
  return { queue: new QueueManager(driver, { resetFailedWorkers: true, taskTimeoutMs: options.timeout || 2000 }), closed, getCreated: () => created };
}

test("failed worker is retired and the next task starts in a new session", async () => {
  const { queue, closed, getCreated } = fixture([
    async () => ({ success: false, pauseQueue: true, error: "upload failed" }),
    async () => ({ success: true, image_paths: ["image.png"] }),
  ]);
  const first = queue.enqueue("first");
  const second = queue.enqueue("second");
  await queue.runJob(first, { slotId: 0 });
  assert.equal(first.status, "failed");
  assert.match(first.error, /upload failed/);
  assert.deepEqual(closed, [0]);
  assert.equal(queue.status().paused, false);
  await queue.runJob(second, { slotId: 0 });
  assert.equal(second.status, "done");
  assert.equal(getCreated(), 2);
});

test("a hung task times out, closes its tab, and leaves other slots alone", async () => {
  const { queue, closed } = fixture([
    () => new Promise(() => {}),
    async () => ({ success: true, image_paths: ["other.png"] }),
  ], { timeout: 50 });
  const first = queue.enqueue("hung");
  const second = queue.enqueue("other");
  await Promise.all([queue.runJob(first, { slotId: 0 }), queue.runJob(second, { slotId: 1 })]);
  assert.equal(first.status, "failed");
  assert.match(first.error, /超时/);
  assert.equal(second.status, "done");
  assert.deepEqual(closed, [0]);
  assert.equal(queue.workerSlots.size, 1);
  assert.equal(queue.status().paused, false);
});

test("worker created after setup timeout is closed on arrival", async () => {
  let resolveSetup;
  const waiting = new Promise(resolve => { resolveSetup = resolve; });
  const { queue, closed } = fixture([async () => ({ success: false })], { timeout: 40, waitForSetup: waiting });
  const job = queue.enqueue("slow setup");
  await queue.runJob(job, { slotId: 0 });
  assert.equal(job.status, "failed");
  assert.equal(queue.workerSlots.size, 0);
  resolveSetup();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(closed, [0]);
});

test("desktop default still pauses and keeps its failed worker", async () => {
  const { queue, closed } = fixture([async () => ({ success: false, pauseQueue: true, error: "page failed" })]);
  queue.resetFailedWorkers = false;
  const job = queue.enqueue("desktop");
  await queue.runJob(job, { slotId: 0 });
  assert.equal(job.status, "failed");
  assert.equal(queue.status().paused, true);
  assert.deepEqual(closed, []);
  assert.equal(queue.workerSlots.size, 1);
});

for (const conversationKey of [null, "https://chatgpt.com/c/old"]) {
  test(`closed server worker starts a fresh session, old address: ${Boolean(conversationKey)}`, async () => {
    const { queue, closed, getCreated } = fixture([async () => ({ success: true, image_paths: ["next.png"] })]);
    const args = [];
    const create = queue.driver.createIsolatedWorker;
    queue.driver.createIsolatedWorker = (...params) => { args.push(params[0]); return create(...params); };
    queue.workerSlots.set("chrome:0", { engine: "chrome", worker: { id: "stale", hasLivePage: () => false }, pending: null, conversationKey, used: true });
    const job = queue.enqueue("next");
    await queue.runJob(job, { slotId: 0 });
    assert.equal(job.status, "done");
    assert.deepEqual(closed, ["stale"]);
    assert.deepEqual(args, [null]);
    assert.equal(getCreated(), 1);
  });
}

test("scheduler dispatches the next queued task after a failure", async () => {
  const { queue, closed } = fixture([
    async () => ({ success: false, blockWorker: true, error: "page failed" }),
    async () => ({ success: true, image_paths: ["next.png"] }),
  ]);
  const first = queue.enqueue("first");
  const second = queue.enqueue("second");
  queue.start();
  try {
    const deadline = Date.now() + 3000;
    while (second.status !== "done" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(first.status, "failed");
    assert.equal(second.status, "done");
    assert.deepEqual(closed, [0]);
    assert.equal(queue.status().paused, false);
  } finally { queue.stop(); }
});

test("both providers can run five tasks concurrently without sharing slots", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const results = name => Array.from({length:5}, (_,index) => async () => {
    started.push(`${name}:${index}`);
    await gate;
    return {success:true,image_paths:[`${name}-${index}.png`]};
  });
  const chatgpt = fixture(results("chatgpt"), {timeout:15000}).queue;
  const gemini = fixture(results("gemini"), {timeout:15000}).queue;
  for (const queue of [chatgpt, gemini]) {
    queue.concurrency = 5;
    trackCompletedSessions(queue, queue.driver, new WeakMap());
    for (let i=0; i<5; i++) queue.enqueue(`task ${i}`);
    queue.start();
  }
  try {
    const deadline = Date.now() + 8000;
    while (started.length < 10 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(started.length, 10);
    assert.equal(chatgpt.status().active, 5);
    assert.equal(gemini.status().active, 5);
  } finally {
    release();
    await Promise.allSettled([...chatgpt.activeRuns, ...gemini.activeRuns]);
    chatgpt.stop();
    gemini.stop();
  }
});
