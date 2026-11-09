"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const modulePath = process.env.GEMINI_INPUT_STATE_MODULE || '../../electron/geminiInputState';
const { inspectGeminiInput } = require(modulePath);
const cdp = process.env.GEMINI_TEST_CDP;

test('Gemini attachment readiness distinguishes loaded previews, uploads and errors', {skip:!cdp}, async () => {
  const browser = await chromium.connectOverCDP(cdp);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="red"/%3E%3C/svg%3E';
    await page.setContent(`<style>gem-media-attachment{display:block;width:100px;height:50px}.gem-attachment-content{display:inline-block;width:15px;height:15px}img{width:20px;height:20px}</style>
      <input-area-v2><div class="ql-editor" contenteditable="true" role="textbox"></div>
      <gem-media-attachment><span class="gem-attachment-content loading"></span><img class="gem-attachment-style-img" alt="preview" src='${image}'></gem-media-attachment>
      <gem-media-attachment><span class="gem-attachment-content"></span><img class="gem-attachment-style-img" alt="preview" src='${image}'></gem-media-attachment></input-area-v2>`);
    await page.waitForFunction(()=>[...document.querySelectorAll('img')].every(img=>img.complete&&img.naturalWidth>0));
    let state = await page.evaluate(inspectGeminiInput);
    assert.equal(state.count,2);
    assert.equal(state.ready,1);
    assert.equal(state.busy,true);
    await page.locator('.loading').evaluate(el=>el.classList.remove('loading'));
    state = await page.evaluate(inspectGeminiInput);
    assert.equal(state.count,2);
    assert.equal(state.ready,2);
    assert.equal(state.busy,false);
    await page.locator('gem-media-attachment').nth(1).evaluate(el=>el.setAttribute('data-state','error'));
    state = await page.evaluate(inspectGeminiInput);
    assert.equal(state.uploadError,'upload failed');
    await page.setContent(`<style>.gem-attachment-content{display:inline-block;width:30px;height:30px}img{width:20px;height:20px}</style><input-area-v2><div class="ql-editor" contenteditable="true" role="textbox"></div><span class="gem-attachment-content"><img alt="attachment" src='${image}'></span></input-area-v2>`);
    await page.waitForFunction(()=>document.querySelector('img').complete&&document.querySelector('img').naturalWidth>0);
    state = await page.evaluate(inspectGeminiInput);
    assert.equal(state.count,1);
    assert.equal(state.ready,1);
    assert.equal(state.busy,false);
  } finally {
    await context.close();
    await browser.close();
  }
});
