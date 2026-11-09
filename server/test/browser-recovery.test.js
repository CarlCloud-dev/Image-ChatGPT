"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatGPTDriver } = require("../../electron/chatgptDriver");

function driver() {
  return Object.assign(Object.create(ChatGPTDriver.prototype), {
    isolatedWorkersUseNewPages: true, workerGeneration: 4, activeWorkers: 2,
  });
}

function worker(generation) {
  return {
    workerGeneration: generation, usesPrimaryPage: false,
    page: { isClosed: () => true },
    async detachDebugger() {}, releaseDeferredReferences() {},
  };
}

test("browser disconnect retires old reservations and late releases cannot affect new workers", async () => {
  const d = driver();
  const old = worker(4);
  d.resetRuntimeRefs();
  assert.equal(d.workerGeneration, 5);
  assert.equal(d.activeWorkers, 0);
  d.activeWorkers = 2;
  await d.releaseIsolatedWorker(old);
  assert.equal(d.activeWorkers, 2);
  const current = worker(5);
  await d.releaseIsolatedWorker(current);
  await d.releaseIsolatedWorker(current);
  assert.equal(d.activeWorkers, 1);
});

test("a failed old page creation cannot release a new browser reservation", async () => {
  const d = driver();
  d.activeWorkers = 0;
  let rejectPage, startedPage;
  const started = new Promise(resolve => { startedPage = resolve; });
  d.context = { newPage: () => { startedPage(); return new Promise((_, reject) => { rejectPage = reject; }); } };
  d.ensurePage = async () => {};
  const pending = d.createIsolatedWorker(null, 1);
  await started;
  assert.equal(d.activeWorkers, 1);
  d.resetRuntimeRefs();
  d.activeWorkers = 1;
  rejectPage(new Error("old browser disconnected"));
  await assert.rejects(pending, /old browser disconnected/);
  assert.equal(d.activeWorkers, 1);
});

test("a page arriving after browser replacement is closed and never returned", async () => {
  const d = driver();
  d.activeWorkers = 0;
  let resolvePage, startedPage, closed = false;
  const started = new Promise(resolve => { startedPage = resolve; });
  d.context = { newPage: () => { startedPage(); return new Promise(resolve => { resolvePage = resolve; }); } };
  d.ensurePage = async () => {};
  const pending = d.createIsolatedWorker(null, 1);
  await started;
  d.resetRuntimeRefs();
  d.activeWorkers = 1;
  resolvePage({ isClosed: () => closed, async close() { closed = true; } });
  await assert.rejects(pending, /环境已重置/);
  assert.equal(closed, true);
  assert.equal(d.activeWorkers, 1);
});
