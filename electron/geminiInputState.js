"use strict";

// This function runs in the Gemini page; keep it self-contained so the
// browser driver can serialize it into the existing authenticated tab.
function inspectGeminiInput() {
  const root = document.querySelector('input-area-v2');
  if (!root) return { found: false, count: 0, ready: 0, busy: true };
  const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const loadingSelector = '[role="progressbar"],[aria-busy="true"],mat-spinner,[class*="gem-attachment-content"][class*="loading"]';
  const legacyImages = [...root.querySelectorAll('img[alt="attachment"]')].filter(visible);
  const cardSelector = '[class*="gem-attachment-content"]';
  const cards = [...root.querySelectorAll(cardSelector)].filter(visible).filter(card => !card.parentElement?.closest(cardSelector));
  const tiles = [...root.querySelectorAll('gem-media-attachment')].filter(visible).filter(tile => !tile.parentElement?.closest('gem-media-attachment'));
  const units = tiles.length ? tiles : cards;
  const outside = legacyImages.filter(img => !units.some(unit => unit.contains(img)));
  const loaded = img => visible(img) && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
  const unitReady = unit => {
    const images = tiles.length ? [...unit.querySelectorAll('img.gem-attachment-style-img, img[alt="attachment"]')] : legacyImages.filter(img => unit.contains(img));
    const busy = [...unit.querySelectorAll(loadingSelector)].some(visible) || (unit.matches(loadingSelector) && visible(unit));
    return !busy && images.some(loaded);
  };
  const busy = [...root.querySelectorAll(loadingSelector)].some(visible);
  const editor = root.querySelector('.ql-editor[contenteditable="true"][role="textbox"]');
  const messages = [...units, ...document.querySelectorAll('[role="alert"],mat-snack-bar-container')].filter(visible)
    .filter(node => !node.closest('user-query,model-response'))
    .map(node => (node.innerText || '').split('\n').filter(line => !/\.(?:png|jpe?g|webp|gif)$/i.test(line.trim())).join(' '));
  const failedText = messages.find(text => /上传失败|无法上传|上传.{0,12}(?:限额|上限|限制)|upload failed|failed to upload|couldn't upload|upload limit|too many|file too large|unsupported file/i.test(text)) || '';
  const failedCard = units.some(unit => unit.matches('[data-state="error"],[aria-invalid="true"]') || [...unit.querySelectorAll('[data-state="error"],[aria-invalid="true"],[data-test-id*="error"],[fonticon="error"],button[aria-label*="Retry"],button[aria-label*="重试"]')].some(visible));
  const uploadError = !failedText ? (failedCard ? 'upload failed' : '') : /upload limit|too many|上传.{0,12}(?:限额|上限|限制)/i.test(failedText) ? 'upload limit reached'
    : /too large|过大/i.test(failedText) ? 'file too large' : /unsupported|不支持/i.test(failedText) ? 'unsupported file' : 'upload failed';
  return { found: !!editor, count: units.length + outside.length,
    ready: units.filter(unitReady).length + outside.filter(loaded).length,
    busy, uploadError, text: (editor?.innerText || '').trim().length };
}

module.exports = { inspectGeminiInput };
