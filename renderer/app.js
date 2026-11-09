// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
var $ = function (id) { return document.getElementById(id); };
var activeProvider = 'chatgpt';
var providerDrafts = {};
var providerSwitching = false;
var apiUpdating = false;
var localApiState = null;
function apiIcon(name) {
  var paths = {
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    hidden: '<path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3.1 3.8M6.2 6.2A19 19 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.8-1.6M10 10a3 3 0 0 0 4 4"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + '</svg>';
}
async function copyApiText(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch (_) { toast('复制失败，请手动选择文本复制'); }
}
function localApiInstructions(state, includeKey) {
  return [
    '# 本地图片生成 API 接入说明 (ChatGPT & Gemini 双模型统一接口)',
    '请使用以下 HTTP API 完成文生图或图生图。单端口统一支持 ChatGPT 与 Gemini，有传参考图即自动图生图，未传即文生图。',
    '',
    'Base URL: ' + state.base_url,
    'Authorization: Bearer ' + (includeKey ? state.api_key : '<API_KEY>'),
    'Content-Type: application/json（所有 POST 请求）',
    '',
    '运行条件：Agent 必须运行在应用所在电脑。用户需保持应用运行、已登录账号并手动开启 API。当前 API 状态：' + (state.enabled ? '已开启' : '已关闭，请先手动开启') + '。',
    '仅允许本地程序调用，不支持跨域调用；不要设置 Origin 请求头。',
    '',
    '1. 检查服务健康：GET ' + state.base_url + '/api/health',
    '返回 JSON：{"ok":true,"supported_models":["chatgpt","gemini"]}',
    'queues 按模型提供 concurrency、active、queued、paused、pause_reason 和 blocked_slots；会话准备失败的环境会被暂时隔离，其他环境继续。提交返回 queue_paused 为 true 时，任务已入队但暂停派发，pause_reason 说明原因，请用户检查浏览器后在应用中点击“继续队列”。',
    '参考图上传每个平台每次只处理一个任务，确认发送后才上传下一批；已经提交的生成仍按并发设置执行。普通上传网络错误最多冷却重传一次，上传限额或授权失败会暂停队列；遇到此类失败不要循环提交新任务，应检查 health 中的 paused 和 pause_reason 并提示用户处理。',
    'input_images 使用本机可读取的绝对路径，按数组顺序上传；应用过滤上传文件名中的中文和特殊符号，保留英文数字，无有效名称时使用 image，并附加顺序号。只处理上传临时副本，原图名称、内容和队列路径保持不变。',
    '',
    '2. 统一生图接口（文生图 / 图生图合并）：POST ' + state.base_url + '/api/generate',
    '示例 A (文生图)：',
    '{"model":"gemini","prompt":"一只在月光下弹钢琴的橘猫，水彩风格","count":1}',
    '',
    '示例 B (图生图 - 传入 input_images 即可自动以图生图)：',
    '{"model":"chatgpt","prompt":"保留参考图人物主体，改成赛博朋克风格","input_images":["D:/images/ref1.png"],"count":1}',
    '',
    '参数说明：',
    '- model（或 provider / id）：可选 "chatgpt" 或 "gemini"（大小写不限），不传默认调用当前应用界面选中的平台。',
    '- prompt：必填字符串，生图提示词，最多 50000 字符。',
    '- input_images：可选数组，包含本机图片的绝对路径 (PNG/JPG/WebP/GIF)。有传即图生图，不传即文生图。',
    '- count：可选 1–4 的整数，生成张数，默认 1。',
    '',
    '3. 提交成功返回 HTTP 202：',
    '{"ok":true,"model":"gemini","mode":"img2img","jobs":["job_id_1"]}',
    '',
    '4. 轮询任务状态：GET ' + state.base_url + '/api/jobs/<任务ID>',
    '返回 JSON 包含 job_id、model、status、detail、error、images。',
    'status 为 queued（排队）、running（生成中）、done（完成）或 failed（失败）。建议每 3–5 秒轮询一次。',
    '',
    '5. 读取已生成的图片：',
    '- 通过相对路径读取流：GET ' + state.base_url + '/api/jobs/<任务ID>/images/0（携带 Authorization 请求头直接下载二进制图片流）。',
    '- 或直接从 job 的 image_paths 数组中获取本机保存的绝对路径。'
  ].join('\n');
}
function renderLocalApi(state) {
  localApiState = state;
  $('apiSwitch').setAttribute('aria-checked', String(state.enabled));
  $('apiSwitch').title = state.enabled ? '关闭本地 API：' + state.base_url : '开启本地 API';
  $('apiSwitch').setAttribute('aria-label', state.enabled ? '关闭本地 API' : '开启本地 API');
}
$('apiSwitch').disabled = true;
window.imgcpt.invoke('local-api-status').then(function (state) {
  renderLocalApi(state);
  $('apiSwitch').disabled = false;
}).catch(function (error) { toast('API 配置读取失败：' + error.message); });
$('apiSwitch').onclick = async function () {
  apiUpdating = true;
  this.disabled = true;
  try {
    renderLocalApi(await window.imgcpt.invoke('local-api-update', { enabled: !localApiState.enabled }));
    toast(localApiState.enabled ? 'API 已开启：' + localApiState.base_url : 'API 已关闭，已入队任务继续执行');
  } catch (error) { toast('API 切换失败：' + error.message); }
  finally { apiUpdating = false; this.disabled = false; }
};
$('apiSettings').onclick = async function () {
  if (document.getElementById('localApiModal')) return;
  var requestedProvider = activeProvider;
  try {
    var state = await window.imgcpt.invoke('local-api-status');
    if (requestedProvider !== activeProvider || providerSwitching) return;
    renderLocalApi(state);
  }
  catch (error) { toast(error.message); return; }
  var mask = document.createElement('div');
  mask.id = 'localApiModal';
  mask.className = 'style-modal-mask';
  mask.innerHTML = '<div class="style-modal api-modal" role="dialog" aria-modal="true" aria-labelledby="apiModalTitle">' +
    '<div class="style-modal-header"><div class="style-modal-title" id="apiModalTitle">本地 API 配置</div><button class="style-modal-close" type="button" aria-label="关闭">×</button></div>' +
    '<div class="style-modal-body api-modal-body">' +
    '<p id="apiModalStatus"></p><p>仅允许本机程序调用。每次启动应用后，需要手动开启 API；关闭 API 不会停止已加入队列的任务。</p>' +
    '<label for="apiPort">端口</label><input id="apiPort" type="number" min="1024" max="65535">' +
    '<label for="apiKey">访问密钥（16–128 位字母、数字、下划线或短横线）</label>' +
    '<div class="api-key-row"><input id="apiKey" type="password" autocomplete="off" spellcheck="false"><button id="apiReveal" class="api-icon-button" type="button" aria-label="显示密钥" title="显示密钥" aria-pressed="false">' + apiIcon('eye') + '</button><button id="apiCopyKey" class="api-icon-button" type="button" aria-label="复制密钥" title="复制密钥">' + apiIcon('copy') + '</button></div>' +
    '<div class="api-guide-head"><div><strong>Agent 接入说明</strong><p>一键复制完整说明，包含已保存的地址和密钥</p></div><button id="apiCopyGuide" class="small api-copy-guide" type="button">' + apiIcon('copy') + '<span>复制接入说明</span></button></div>' +
    '<textarea id="apiGuide" class="api-guide" readonly aria-label="Agent API 接入说明" spellcheck="false"></textarea>' +
    '<p id="apiConfigError" role="alert"></p></div>' +
    '<div class="style-modal-footer"><span class="selected-info">端口和密钥会自动保存在本地</span><div class="spacer"></div><button id="apiSave" class="small primary" type="button">保存配置</button></div></div>';
  document.body.appendChild(mask);
  var port = mask.querySelector('#apiPort');
  var key = mask.querySelector('#apiKey');
  var save = mask.querySelector('#apiSave');
  port.value = localApiState.port;
  key.value = localApiState.api_key;
  var guideState = Object.assign({}, localApiState);
  mask.querySelector('#apiGuide').value = localApiInstructions(guideState, false);
  mask.querySelector('#apiCopyKey').onclick = function () { copyApiText(key.value, '密钥已复制'); };
  mask.querySelector('#apiCopyGuide').onclick = function () {
    copyApiText(localApiInstructions(guideState, true), '接入说明已复制，可直接发送给 Agent');
  };
  port.disabled = key.disabled = save.disabled = localApiState.enabled;
  mask.querySelector('#apiModalStatus').textContent = (localApiState.enabled ? '运行中：' : '已关闭：') + localApiState.base_url + (localApiState.enabled ? '（修改配置前请关闭 API）' : '');
  function close() { mask.remove(); $('apiSettings').focus(); }
  mask.querySelector('.style-modal-close').onclick = close;
  mask.onclick = function (event) { if (event.target === mask) close(); };
  mask.onkeydown = function (event) {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      var controls = Array.from(mask.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea'));
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  mask.querySelector('#apiReveal').onclick = function () {
    key.type = key.type === 'password' ? 'text' : 'password';
    var visible = key.type === 'text';
    this.innerHTML = apiIcon(visible ? 'hidden' : 'eye');
    this.title = visible ? '隐藏密钥' : '显示密钥';
    this.setAttribute('aria-label', this.title);
    this.setAttribute('aria-pressed', String(visible));
  };
  save.onclick = async function () {
    save.disabled = true;
    try {
      renderLocalApi(await window.imgcpt.invoke('local-api-update', { config: { port: Number(port.value), api_key: key.value } }));
      close(); toast('API 配置已保存');
    } catch (error) { mask.querySelector('#apiConfigError').textContent = error.message; }
    finally { save.disabled = false; }
  };
  mask.querySelector('.style-modal-close').focus();
};
function api(path, opts) {
  var body = null;
  try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = null; }
  if (path === '/api/window/minimize') return window.imgcpt.invoke('window-minimize');
  if (path === '/api/window/toggle-maximize') return window.imgcpt.invoke('window-toggle-maximize');
  if (path === '/api/window/close') return window.imgcpt.invoke('window-close');
  if (path === '/api/health') return window.imgcpt.invoke('health');
  if (path === '/api/styles') return window.imgcpt.invoke('styles');
  if (path === '/api/open-output-dir') return window.imgcpt.invoke('open-output-dir');
  if (path === '/api/output-dir') {
    return opts && opts.method === 'POST'
      ? window.imgcpt.invoke('set-output-dir', body || {})
      : window.imgcpt.invoke('output-dir');
  }
  if (path === '/api/pick-directory') return window.imgcpt.invoke('pick-directory');
  if (path === '/api/login') return window.imgcpt.invoke('login');
  if (path === '/api/browser/toggle') return window.imgcpt.invoke('browser-toggle');
  if (path === '/api/browser/state') return window.imgcpt.invoke('browser-state');
  if (path === '/api/browser/engine') {
    return window.imgcpt.invoke('browser-engine', body || {});
  }
  if (path === '/api/chat/new') return window.imgcpt.invoke('chat-new');
  if (path === '/api/chat/open-last') return window.imgcpt.invoke('chat-open-last');
  if (path === '/api/chat/status') return window.imgcpt.invoke('chat-status');
  if (path === '/api/generate') return window.imgcpt.invoke('generate', body || {});
  if (path === '/api/generate/batch') return window.imgcpt.invoke('generate-batch', body || {});
  if (path === '/api/jobs') return window.imgcpt.invoke('jobs');
  if (path === '/api/queue/status') return window.imgcpt.invoke('queue-status', { provider: activeProvider });
  if (path === '/api/queue/concurrency') return window.imgcpt.invoke('queue-concurrency', body || {});
  if (path === '/api/queue/resume') return window.imgcpt.invoke('queue-resume', body || {});
  if (path === '/api/jobs/clear-completed') return window.imgcpt.invoke('clear-completed-jobs');
  if (path === '/api/jobs/retry-all') return window.imgcpt.invoke('retry-all-jobs', body || {});
  if (/^\/api\/jobs\/[^/]+\/stop$/.test(path)) {
    return window.imgcpt.invoke('cancel-running-job', Object.assign({}, body || {}, { job_id: path.split('/')[3] }));
  }
  if (/^\/api\/jobs\/[^/]+\/retry$/.test(path)) {
    return window.imgcpt.invoke('retry-job', path.split('/')[3]);
  }
  if (/^\/api\/jobs\/[^/]+\/cancel$/.test(path)) {
    return window.imgcpt.invoke('cancel-queued-job', path.split('/')[3]);
  }
  if (/^\/api\/jobs\/[^/]+\/remove$/.test(path)) {
    return window.imgcpt.invoke('remove-failed-job', path.split('/')[3]);
  }
  if (path === '/api/stop') return window.imgcpt.invoke('stop-queue');
  if (path === '/api/app/exit') return window.imgcpt.invoke('app-exit');
  return Promise.reject(new Error('未知接口: ' + path));
}
function toast(msg) {
  var t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { t.remove(); }, 2600);
}
// 本地文件路径 -> file:// URL
function imgPath(p) {
  if (!p) return '';
  var norm = String(p).replace(/\\/g, '/');
  if (norm.indexOf('file://') === 0) return norm;
  if (/^[A-Za-z]:\//.test(norm)) {
    var drive = norm.slice(0, 2);
    var rest = norm.slice(3).split('/').map(encodeURIComponent).join('/');
    return 'file:///' + drive + '/' + rest;
  }
  return 'file:///' + norm.split('/').map(encodeURIComponent).join('/');
}

// ---------------------------------------------------------------------------
// 全屏预览蒙版:点缩略图弹大图,点非图片区域关闭,点保存按钮下载
// ---------------------------------------------------------------------------
function openPreview(src) {
  if (!src) return;
  // 已有蒙版则先移除
  closePreview();
  var mask = document.createElement('div');
  mask.className = 'preview-mask';
  mask.innerHTML =
    '<div class="preview-close">点击空白区域关闭</div>' +
    '<button class="preview-save" type="button">' +
      '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>保存图片' +
    '</button>' +
    '<img class="preview-img" src="' + src + '">';
  // 点击蒙版背景关闭(图片和保存按钮都已 stopPropagation,点它们不会触发关闭)
  mask.addEventListener('click', function () {
    closePreview();
  });
  // ESC 关闭
  function onKey(e) { if (e.key === 'Escape') { closePreview(); } }
  // 保存按钮:触发下载
  mask.querySelector('.preview-save').addEventListener('click', function (e) {
    e.stopPropagation();
    var a = document.createElement('a');
    a.href = src;
    // 从 src 提取文件名
    var name = src.split('/').pop() || 'image.png';
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已开始下载');
  });
  // 阻止图片本身点击关闭(让用户能右键等)
  mask.querySelector('.preview-img').addEventListener('click', function (e) {
    e.stopPropagation();
  });
  document.addEventListener('keydown', onKey);
  // 把 onKey 存到 mask 上,closePreview 时移除
  mask._onKey = onKey;
  document.body.appendChild(mask);
}
function closePreview() {
  var mask = document.querySelector('.preview-mask');
  if (!mask) return;
  if (mask._onKey) document.removeEventListener('keydown', mask._onKey);
  mask.remove();
}
function openReferenceGallery(images, title) {
  var paths = Array.isArray(images) ? images.filter(Boolean) : [];
  if (!paths.length) return;
  if (paths.length === 1) {
    openPreview(imgPath(paths[0]));
    return;
  }
  closeReferenceGallery();
  var mask = document.createElement('div');
  mask.className = 'reference-gallery-mask';
  var heading = title || ('参考图 (' + paths.length + ' 张)');
  mask.innerHTML =
    '<div class="reference-gallery" role="dialog" aria-modal="true" aria-label="' + esc(heading) + '">' +
      '<div class="reference-gallery-head"><span>' + esc(heading) + '</span><button type="button" class="reference-gallery-close" title="关闭">×</button></div>' +
      '<div class="reference-gallery-grid">' + paths.map(function (src, index) {
        var url = imgPath(src);
        return '<button type="button" class="reference-gallery-item" data-index="' + index + '" title="查看参考图 ' + (index + 1) + '">' +
          '<img src="' + esc(url) + '" alt="参考图 ' + (index + 1) + '">' +
          '<span>参考图 ' + (index + 1) + '</span>' +
        '</button>';
      }).join('') + '</div>' +
    '</div>';
  mask.addEventListener('click', function (event) {
    if (event.target === mask) closeReferenceGallery();
  });
  mask.querySelector('.reference-gallery-close').onclick = closeReferenceGallery;
  mask.querySelectorAll('.reference-gallery-item').forEach(function (item) {
    item.onclick = function () {
      var index = Number(item.dataset.index);
      closeReferenceGallery();
      openPreview(imgPath(paths[index]));
    };
  });
  function onKey(event) { if (event.key === 'Escape') closeReferenceGallery(); }
  mask._onKey = onKey;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(mask);
}
function closeReferenceGallery() {
  var mask = document.querySelector('.reference-gallery-mask');
  if (!mask) return;
  if (mask._onKey) document.removeEventListener('keydown', mask._onKey);
  mask.remove();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
var STATUS_LABEL = { queued: '排队', running: '生成中', done: '完成', failed: '失败' };

// ---------------------------------------------------------------------------
// 窗口标题栏
// ---------------------------------------------------------------------------
$('winMinBtn').onclick = function () {
  api('/api/window/minimize').catch(function () {});
};
$('winMaxBtn').onclick = function () {
  api('/api/window/toggle-maximize').catch(function () {});
};
$('winCloseBtn').onclick = function () {
  api('/api/window/close').catch(function () {});
};
$('appTitlebar').ondblclick = function (event) {
  if (event.target && event.target.closest && event.target.closest('.titlebar-controls')) return;
  api('/api/window/toggle-maximize').catch(function () {});
};

// ---------------------------------------------------------------------------
// 登录态
// ---------------------------------------------------------------------------
var healthRequestSequence = 0;
function refreshHealth() {
  var requestedProvider = activeProvider;
  var sequence = ++healthRequestSequence;
  api('/api/health').then(function (h) {
    if (requestedProvider !== activeProvider || sequence !== healthRequestSequence) return;
    var dot = $('loginDot'), txt = $('loginText');
    if (!dot || !txt) return;
    $('firstUseHint').classList.toggle('hidden', !!h.logged_in);
    if (h.initializing) {
      dot.className = 'dot warn'; txt.textContent = '浏览器启动中…';
    } else if (!h.driver_ready) {
      dot.className = 'dot warn'; txt.textContent = h.browser_connected ? '浏览器已连接，页面未就绪' : '浏览器未启动 — 点"显示浏览器"';
    } else if (h.logged_in) {
      dot.className = 'dot ok'; txt.textContent = '已登录 ' + (activeProvider === 'gemini' ? 'Gemini' : 'ChatGPT');
    } else if (h.login_unknown) {
      dot.className = 'dot warn'; txt.textContent = h.login_check_timeout ? '状态检测超时 — 请显示浏览器检查' : '登录状态未确认 — 请显示浏览器检查';
    } else {
      dot.className = 'dot warn'; txt.textContent = '未登录 — 点"显示浏览器"登录';
    }
  }).catch(function () {
    if (requestedProvider !== activeProvider || sequence !== healthRequestSequence) return;
    var dot = $('loginDot'), txt = $('loginText');
    if (!dot || !txt) return;
    dot.className = 'dot err';
    txt.textContent = '服务异常';
  });
}

// 打开 output 图片目录(系统资源管理器)
$('openOutputBtn').onclick = function () {
  api('/api/open-output-dir', { method: 'POST' }).then(function (d) {
    if (!d.ok) toast('打开失败: ' + (d.error || ''));
  }).catch(function (e) { toast('打开失败: ' + e.message); });
};

// 设置保存目录:弹系统原生文件夹选择对话框,选完直接应用
$('setOutputBtn').onclick = function () {
  api('/api/pick-directory', { method: 'POST' }).then(function (d) {
    if (!d.ok) {
      if (d.canceled) return;  // 用户取消,不提示
      toast('打开选择器失败: ' + (d.error || ''));
      return;
    }
    // 选完直接应用,不再二次确认
    return api('/api/output-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: d.dir })
    });
  }).then(function (r) {
    if (!r) return;
    if (r.ok) toast('保存目录: ' + r.dir);
    else toast('设置失败: ' + (r.error || ''));
  }).catch(function (e) { toast('设置失败: ' + e.message); });
};

// 主题切换:浅色/深色,localStorage 持久化。active = 当前主题
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('imgcpt_theme', t); } catch (e) {}
  document.querySelectorAll('#themeToggle .toggle-opt').forEach(function (x) {
    x.classList.toggle('active', x.dataset.theme === t);
  });
}
document.querySelectorAll('#themeToggle .toggle-opt').forEach(function (opt) {
  opt.onclick = function () {
    var cur = document.documentElement.getAttribute('data-theme') || 'dark';
    if (opt.dataset.theme !== cur) applyTheme(opt.dataset.theme);
  };
});
// 初始化高亮当前主题(head 内联脚本已提前设置 data-theme)
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

// Chrome / Edge 窗口显示、隐藏与切换
var browserToggleBusy = false;
function updateToggleBrowserBtn(visible) {
  var btn = $('toggleBrowserBtn');
  if (visible) {
    btn.textContent = '隐藏浏览器';
    btn.classList.add('success');
  } else {
    btn.textContent = '显示浏览器';
    btn.classList.remove('success');
  }
}
function refreshBrowserState() {
  var requestedProvider = activeProvider;
  api('/api/browser/state').then(function (s) {
    if (requestedProvider !== activeProvider) return;
    if (s.ok && s.managed_browser) {
      updateToggleBrowserBtn(s.visible);
      $('toggleBrowserBtn').disabled = false;
    } else {
      $('toggleBrowserBtn').disabled = true;
      $('toggleBrowserBtn').textContent = '显示浏览器';
    }
  }).catch(function () { /* 启动早期接口可能未就绪,忽略 */ });
}
if (window.imgcpt.onBrowserStateEvent) {
  window.imgcpt.onBrowserStateEvent(function (s) {
    if (s && s.provider && s.provider !== activeProvider) return;
    if (s && typeof s.visible === 'boolean') updateToggleBrowserBtn(s.visible);
    if (s && s.msg) toast(s.msg);
  });
}
$('toggleBrowserBtn').onclick = function () {
  if (browserToggleBusy) return;
  browserToggleBusy = true;
  $('toggleBrowserBtn').disabled = true;
  api('/api/browser/toggle', { method: 'POST' }).then(function (r) {
    if (r.ok) {
      updateToggleBrowserBtn(r.visible);
      toast(r.msg);
      refreshHealth();
    } else {
      toast(r.msg || '切换失败');
    }
  }).catch(function (e) {
    toast('切换失败: ' + e.message);
  }).finally(function () {
    browserToggleBusy = false;
    $('toggleBrowserBtn').disabled = false;
    setTimeout(refreshBrowserState, 400);
  });
};

// ---------------------------------------------------------------------------
// 生成模式 tab:单图 / 批量 / 图生图
// ---------------------------------------------------------------------------
var genMode = 'single'; // 'single' | 'batch' | 'image'
var inputImages = [];
var selectedImageId = null;
function makePrompt(p, ratio) {
  var s = '创建图片:' + p;
  if (ratio && ratio !== 'auto') s += '。图片比例:' + ratio;
  return s;
}
function withSelectedStyle(text) {
  var s = String(text || '').trim();
  if (selectedStyle && selectedStyle.kw) s = s + ', ' + selectedStyle.kw;
  return s;
}
function refreshBrowserEngine() {
  var requestedProvider = activeProvider;
  api('/api/browser/engine').then(function (s) {
    if (requestedProvider !== activeProvider) return;
    if (s.ok && (s.engine === 'chrome' || s.engine === 'edge')) {
      $('browserEngineSelect').value = s.engine;
    }
  }).catch(function () {});
}
$('browserEngineSelect').onchange = function () {
  var select = this;
  var engine = select.value;
  select.disabled = true;
  api('/api/browser/engine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: engine })
  }).then(function (r) {
    if (!r.ok) throw new Error(r.error || '切换失败');
    select.value = r.engine;
    updateToggleBrowserBtn(false);
    toast('已切换到 ' + (r.engine === 'edge' ? 'Edge' : 'Chrome') + '，点击“显示浏览器”即可启动');
    refreshHealth();
    refreshBrowserState();
  }).catch(function (e) {
    toast('浏览器切换失败: ' + e.message);
    refreshBrowserEngine();
  }).finally(function () {
    select.disabled = false;
  });
};
function withAdditionalPrompt(text) {
  var base = String(text || '').trim();
  if (!base) return '';
  var additional = String($('additionalPromptText').value || '').trim();
  return additional ? (base + '\n' + additional) : base;
}
function buildGenerationPrompt(text, ratio) {
  return makePrompt(withSelectedStyle(withAdditionalPrompt(text)), ratio);
}
function updateAdditionalPromptState() {
  var hasValue = String($('additionalPromptText').value || '').trim().length > 0;
  $('additionalPromptPanel').classList.toggle('has-value', hasValue);
  $('additionalPromptState').textContent = hasValue ? '已启用，全局追加' : '可选，全局追加';
}
function updateAdditionalPromptHint() {
  var hint = $('additionalPromptHint');
  if (genMode === 'batch') {
    hint.textContent = '填写后会追加到每一行批量提示词的后面';
  } else if (genMode === 'image') {
    hint.textContent = '填写后会追加到每个图生图任务最终使用的提示词后面';
  } else {
    hint.textContent = '填写后会追加到本次生成的主提示词后面';
  }
}
function setGenMode(mode) {
  genMode = mode;
  document.querySelectorAll('#genModeToggle .toggle-opt').forEach(function (x) {
    x.classList.toggle('active', x.dataset.mode === mode);
  });
  var lbl = $('promptLabel');
  var ta = $('batchText');
  $('imageModePanel').classList.toggle('hidden', mode !== 'image');
  if (mode === 'single') {
    lbl.textContent = '提示词';
    ta.placeholder = '例如:一只在月光下弹钢琴的橘猫,赛博朋克霓虹风格';
  } else if (mode === 'batch') {
    lbl.textContent = '提示词(每张图之间用回车换行)';
    ta.placeholder = '例如:\n一只在月光下弹钢琴的橘猫,赛博朋克霓虹风格\n极简水墨山水,宋代风格';
  } else {
    updateImagePromptUI();
  }
  updateAdditionalPromptHint();
}
document.querySelectorAll('#genModeToggle .toggle-opt').forEach(function (opt) {
  opt.onclick = function () { setGenMode(opt.dataset.mode); };
});
setGenMode('single');
$('additionalPromptText').oninput = updateAdditionalPromptState;
updateAdditionalPromptState();

function imageId() {
  return 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}
function updateImageCount() {
  $('imageCountText').textContent = inputImages.length + ' 张参考图';
}
function selectedImageRef() {
  return inputImages.find(function (x) { return x.id === selectedImageId; }) || null;
}
function updateImageDropzone() {
  var dz = $('imageDropzone');
  var hasImages = inputImages.length > 0;
  dz.classList.toggle('compact', hasImages);
  $('imageDropzoneHint').textContent = hasImages
    ? '可继续拖入参考图；按住图片拖动可调整顺序'
    : '拖拽图片到这里，或点击“添加参考图”';
}
function updateImagePromptUI() {
  if (genMode === 'image') {
    $('promptLabel').textContent = '提示词(图生图，必填)';
    $('batchText').placeholder = '例如:以全部参考图为依据，统一角色、服装与场景，生成电影海报风格画面。';
  }
}
function removeImageRef(id) {
  var removed = inputImages.find(function (x) { return x.id === id; });
  if (removed && removed.preview && removed.preview.indexOf('blob:') === 0) URL.revokeObjectURL(removed.preview);
  inputImages = inputImages.filter(function (x) { return x.id !== id; });
  if (selectedImageId === id) selectedImageId = inputImages.length ? inputImages[0].id : null;
  renderImageRefs();
}
function renderImageRefs() {
  var root = $('imageRefs');
  if (!inputImages.length) {
    root.innerHTML = '';
    selectedImageId = null;
    updateImageCount();
    updateImageDropzone();
    return;
  }
  if (!selectedImageRef()) selectedImageId = inputImages[0].id;
  root.innerHTML = inputImages.map(function (it, i) {
    var active = it.id === selectedImageId ? ' active' : '';
    return '<div class="image-ref-chip' + active + '" data-id="' + esc(it.id) + '" draggable="true" title="点击预览，拖动调整顺序：' + esc(it.name) + '">' +
      '<img src="' + esc(it.preview) + '" alt="">' +
      '<span class="image-ref-index">' + (i + 1) + '</span>' +
      '<button class="image-ref-remove" type="button" title="移除">×</button>' +
    '</div>';
  }).join('');
  root.querySelectorAll('.image-ref-chip').forEach(function (card) {
    var id = card.dataset.id;
    card.onclick = function (e) {
      e.stopPropagation();
      selectedImageId = id;
      renderImageRefs();
      var item = selectedImageRef();
      if (item) openPreview(item.preview);
    };
    card.querySelector('.image-ref-remove').onclick = function (e) {
      e.stopPropagation();
      removeImageRef(id);
    };
    card.ondragstart = function (e) {
      draggingImageId = id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-image-chatgpt-ref', id);
    };
    card.ondragend = function () {
      draggingImageId = null;
      clearImageRefDropIndicators();
      card.classList.remove('dragging');
    };
    card.ondragover = function (e) {
      if (!draggingImageId || draggingImageId === id) return;
      e.preventDefault();
      e.stopPropagation();
      var before = e.clientX < card.getBoundingClientRect().left + card.getBoundingClientRect().width / 2;
      clearImageRefDropIndicators();
      card.classList.add(before ? 'drop-before' : 'drop-after');
      e.dataTransfer.dropEffect = 'move';
    };
    card.ondragleave = function () {
      card.classList.remove('drop-before', 'drop-after');
    };
    card.ondrop = function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (draggingImageId && draggingImageId !== id) {
        var before = e.clientX < card.getBoundingClientRect().left + card.getBoundingClientRect().width / 2;
        moveImageRef(draggingImageId, id, before);
      } else if (e.dataTransfer.files && e.dataTransfer.files.length) {
        addImageFiles(e.dataTransfer.files);
      }
    };
  });
  updateImageCount();
  updateImageDropzone();
}
var draggingImageId = null;
function clearImageRefDropIndicators() {
  document.querySelectorAll('.image-ref-chip.drop-before, .image-ref-chip.drop-after').forEach(function (card) {
    card.classList.remove('drop-before', 'drop-after');
  });
}
function moveImageRef(sourceId, targetId, before) {
  var sourceIndex = inputImages.findIndex(function (item) { return item.id === sourceId; });
  var targetIndex = inputImages.findIndex(function (item) { return item.id === targetId; });
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
  var moved = inputImages.splice(sourceIndex, 1)[0];
  targetIndex = inputImages.findIndex(function (item) { return item.id === targetId; });
  inputImages.splice(before ? targetIndex : targetIndex + 1, 0, moved);
  selectedImageId = moved.id;
  renderImageRefs();
}
function addImageFiles(fileList) {
  var files = Array.prototype.slice.call(fileList || []);
  var added = 0;
  var firstAddedId = null;
  files.forEach(function (file) {
    if (!file || !/^image\//i.test(file.type || '')) return;
    var filePath = window.imgcpt.filePath(file);
    if (!filePath) return;
    if (inputImages.some(function (x) { return x.path === filePath; })) return;
    var item = {
      id: imageId(),
      path: filePath,
      name: file.name || filePath.split(/[\\/]/).pop() || 'image',
      preview: URL.createObjectURL(file)
    };
    inputImages.push(item);
    if (!firstAddedId) firstAddedId = item.id;
    added += 1;
  });
  if (firstAddedId && !selectedImageId) selectedImageId = firstAddedId;
  renderImageRefs();
  if (added) toast('已添加 ' + added + ' 张参考图');
  else toast('没有添加新的图片');
}
function buildImageJobs(baseText, ratio, count) {
  var globalText = String(baseText || '').trim();
  if (!inputImages.length) throw new Error('请先添加参考图');
  if (!globalText) throw new Error('请输入图生图提示词');
  return [{
    prompt: buildGenerationPrompt(globalText, ratio),
    display_prompt: withAdditionalPrompt(globalText),
    input_images: inputImages.map(function (it) { return it.path; }),
    name: inputImages.length > 1 ? 'multi_reference' : inputImages[0].name,
    count: count
  }];
}
$('imagePickBtn').onclick = function () { $('imageFileInput').click(); };
$('imageClearBtn').onclick = function () {
  inputImages.forEach(function (it) {
    if (it.preview && it.preview.indexOf('blob:') === 0) URL.revokeObjectURL(it.preview);
  });
  inputImages = [];
  selectedImageId = null;
  renderImageRefs();
};
$('imageFileInput').onchange = function (e) {
  addImageFiles(e.target.files);
  e.target.value = '';
};
$('imageDropzone').onclick = function () { $('imageFileInput').click(); };
$('imageDropzone').ondragover = function (e) {
  if (draggingImageId) return;
  e.preventDefault();
  $('imageDropzone').classList.add('drag');
};
$('imageDropzone').ondragleave = function () {
  if (draggingImageId) return;
  $('imageDropzone').classList.remove('drag');
};
$('imageDropzone').ondrop = function (e) {
  if (draggingImageId) return;
  e.preventDefault();
  $('imageDropzone').classList.remove('drag');
  addImageFiles(e.dataTransfer.files);
};

// ---------------------------------------------------------------------------
// 风格选择弹窗
// ---------------------------------------------------------------------------
// 预设风格数据:从 /api/styles 加载,按分类组织
var STYLE_DATA = [];
var selectedStyle = null; // 当前选中的风格对象
var styleModalCurrentCat = 0;

// 启动时加载风格数据
api('/api/styles').then(function (data) {
  if (data && data.length) {
    STYLE_DATA = data;
  }
}).catch(function (e) {
  console.warn('加载风格数据失败:', e);
});

function openStyleModal() {
  closeStyleModal();
  var mask = document.createElement('div');
  mask.className = 'style-modal-mask';
  mask.innerHTML =
    '<div class="style-modal">' +
      '<div class="style-modal-header">' +
        '<div class="style-modal-title">选择预设风格</div>' +
        '<button class="style-modal-close" type="button" title="关闭">×</button>' +
      '</div>' +
      '<div class="style-tabs" id="styleTabs"></div>' +
      '<div class="style-modal-body" id="styleModalBody"></div>' +
      '<div class="style-modal-footer">' +
        '<span class="selected-info" id="styleSelectedInfo">未选择</span>' +
        '<div class="spacer"></div>' +
        '<button class="small" id="styleClearBtn" type="button">清除选择</button>' +
        '<button class="primary small" id="styleConfirmBtn" type="button" style="margin-bottom:0">确认</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(mask);
  // 渲染 tabs
  var tabsHtml = STYLE_DATA.map(function (cat, i) {
    return '<div class="style-tab' + (i === styleModalCurrentCat ? ' active' : '') + '" data-idx="' + i + '">' + cat.cat + '</div>';
  }).join('');
  mask.querySelector('#styleTabs').innerHTML = tabsHtml;
  mask.querySelectorAll('.style-tab').forEach(function (t) {
    t.onclick = function () {
      styleModalCurrentCat = parseInt(t.dataset.idx, 10);
      mask.querySelectorAll('.style-tab').forEach(function (x) { x.classList.toggle('active', x === t); });
      renderStyleGrid();
    };
  });
  // 点击蒙版关闭
  mask.addEventListener('click', function (e) { if (e.target === mask) closeStyleModal(); });
  // 关闭按钮
  mask.querySelector('.style-modal-close').onclick = closeStyleModal;
  // 清除选择
  mask.querySelector('#styleClearBtn').onclick = function () {
    selectedStyle = null;
    updateStylePanel();
    closeStyleModal();
  };
  // 确认
  mask.querySelector('#styleConfirmBtn').onclick = function () {
    if (!selectedStyle) { toast('请先选择一个风格'); return; }
    updateStylePanel();
    closeStyleModal();
  };
  // ESC 关闭
  function onKey(e) { if (e.key === 'Escape') closeStyleModal(); }
  document.addEventListener('keydown', onKey);
  mask._onKey = onKey;
  renderStyleGrid();
}

function renderStyleGrid() {
  var body = document.querySelector('#styleModalBody');
  if (!body) return;
  if (!STYLE_DATA.length) {
    body.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:30px">风格数据加载中...</div>';
    return;
  }
  var cat = STYLE_DATA[styleModalCurrentCat];
  var html = '<div class="style-grid">';
  cat.items.forEach(function (it) {
    var sel = selectedStyle && selectedStyle.id === it.id ? ' selected' : '';
    html +=
      '<div class="style-card' + sel + '" data-id="' + it.id + '">' +
        '<div class="style-card-preview"><img src="' + it.cover + '" alt="' + esc(it.name) + '" onerror="this.style.display=\'none\';this.parentElement.innerHTML+=\'<span class=\\\'style-card-emoji\\\'>🖼️</span>\'"></div>' +
        '<div class="style-card-title">' + esc(it.name) + '</div>' +
      '</div>';
  });
  html += '</div>';
  body.innerHTML = html;
  body.querySelectorAll('.style-card').forEach(function (card) {
    card.onclick = function () {
      var id = card.dataset.id;
      var found = null;
      STYLE_DATA.forEach(function (c) {
        c.items.forEach(function (it) { if (it.id === id) found = it; });
      });
      if (found) {
        selectedStyle = found;
        body.querySelectorAll('.style-card').forEach(function (x) { x.classList.toggle('selected', x === card); });
        var info = document.querySelector('#styleSelectedInfo');
        if (info) info.textContent = '已选择: ' + found.name;
      }
    };
  });
}

function closeStyleModal() {
  var mask = document.querySelector('.style-modal-mask');
  if (mask) {
    if (mask._onKey) document.removeEventListener('keydown', mask._onKey);
    mask.remove();
  }
}

function updateStylePanel() {
  var sub = $('styleSubText');
  if (!sub) return;
  var iconBox = document.querySelector('#stylePanel .style-icon-box');
  if (selectedStyle) {
    sub.textContent = '已选: ' + selectedStyle.name;
    sub.style.color = 'var(--accent)';
    // 面板小图标显示选中风格的封面图
    if (iconBox) {
      iconBox.innerHTML = '<img src="' + selectedStyle.cover + '" style="width:100%;height:100%;object-fit:cover;border-radius:8px" onerror="this.parentElement.innerHTML=\'<svg viewBox=\\\'0 0 24 24\\\'><path d=\\\'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z\\\'/></svg>\'">';
    }
  } else {
    sub.textContent = '当前无预设风格';
    sub.style.color = '';
    // 恢复默认图片图标
    if (iconBox) {
      iconBox.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';
    }
  }
}

$('stylePanel').onclick = openStyleModal;

function showEnqueuedResult(data, message, provider) {
  if (provider !== activeProvider) return;
  refreshQueueStatus();
  toast(data.queue_paused ? message + '，队列已暂停，请点击“继续队列”' : message);
}

$('batchEnq').onclick = function () {
  var provider = activeProvider;
  var text = $('batchText').value.trim();
  var ratio = $('batchRatio').value;
  var count = parseInt($('batchCount').value, 10) || 1;
  if (genMode !== 'image' && !text) { toast('请输入提示词'); return; }
  if (genMode === 'single') {
    // 单图:整段作为一个 prompt,生成 count 张
    var displayPrompt = withAdditionalPrompt(text);
    var prompt = buildGenerationPrompt(text, ratio);
    api('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, display_prompt: displayPrompt, count: count })
    }).then(function (d) {
      showEnqueuedResult(d, count > 1 ? '已加入队列(×' + count + ')' : '已加入队列', provider);
    }).catch(function (e) { toast('加入失败: ' + e.message); });
  } else if (genMode === 'batch') {
    // 批量:按行分割,每行生成 count 张
    var rawPrompts = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var prompts = rawPrompts.map(function (p) {
      return { prompt: buildGenerationPrompt(p, ratio), display_prompt: withAdditionalPrompt(p) };
    }).filter(function (it) { return it.prompt.length > 6; });
    if (!prompts.length) { toast('没有有效的 prompt'); return; }
    api('/api/generate/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts: prompts, count: count })
    }).then(function (d) {
      showEnqueuedResult(d, '已加入 ' + d.enqueued + ' 个任务' + (count > 1 ? '(每个×' + count + ')' : ''), provider);
    }).catch(function (e) { toast('加入失败: ' + e.message); });
  } else {
    try {
      var imageJobs = buildImageJobs(text, ratio, count);
      api('/api/generate/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts: imageJobs, count: 1 })
      }).then(function (d) {
        showEnqueuedResult(d, '已加入 ' + d.enqueued + ' 个图生图任务', provider);
      }).catch(function (e) { toast('加入失败: ' + e.message); });
    } catch (e) {
      toast(e.message || String(e));
    }
  }
};

$('batchClear').onclick = function () {
  var provider = activeProvider;
  api('/api/jobs/clear-completed', { method: 'POST' }).then(function (d) {
    if (provider !== activeProvider) return;
    jobs = d.jobs || [];
    renderTable();
  }).catch(function (e) { toast('清空失败: ' + e.message); });
};
$('stopBtn').onclick = function () {
  api('/api/stop', { method: 'POST' }).then(function () { toast('已清空排队任务'); })
    .catch(function (e) { toast('停止失败: ' + e.message); });
};

var queueStatusSequence = 0;
function refreshQueueStatus() {
  var requestedProvider = activeProvider;
  var sequence = ++queueStatusSequence;
  api('/api/queue/status').then(function (status) {
    if (requestedProvider !== activeProvider || sequence !== queueStatusSequence) return;
    $('queueConcurrency').value = String(status.concurrency);
    $('queueConcurrency').disabled = status.active > 0;
    var blocked = status.blocked_slots || [];
    $('queueResume').classList.toggle('hidden', !status.paused && !blocked.length);
    $('queueResume').textContent = status.paused ? '继续队列' : '恢复环境';
    $('queueConcurrencyHint').textContent = status.paused ? '队列已暂停，请检查浏览器' : (blocked.length ? '环境 ' + blocked.join('、') + ' 暂不可用，其他环境继续' : '各环境复用对话 · 参考图依次上传');
    $('queuePauseNotice').classList.toggle('hidden', !status.paused);
    $('queuePauseReason').textContent = status.paused
      ? (status.queued || 0) + ' 个任务等待执行。' + (status.pause_reason || '浏览器状态需要检查。')
      : '';
  }).catch(function () {});
}
$('queueConcurrency').onchange = function () {
  var provider = activeProvider;
  this.disabled = true;
  api('/api/queue/concurrency', { method: 'POST', body: JSON.stringify({ provider: provider, concurrency: Number(this.value) }) })
    .then(function (status) { if (provider === activeProvider) toast(status.paused ? '并发设置已保存；队列仍暂停，请点击“继续队列”' : '并发设置已保存'); })
    .catch(function (error) { if (provider === activeProvider) toast('设置失败: ' + error.message); })
    .finally(function () { if (provider === activeProvider) refreshQueueStatus(); });
};
$('queueResume').onclick = function () {
  var provider = activeProvider;
  api('/api/queue/resume', { method: 'POST', body: JSON.stringify({ provider: provider }) }).then(function () { if (provider === activeProvider) { refreshQueueStatus(); toast('队列和环境已恢复'); } })
    .catch(function (error) { if (provider === activeProvider) toast('继续队列失败: ' + error.message); });
};

// ---------------------------------------------------------------------------
// 任务表
// ---------------------------------------------------------------------------
var jobs = [];
var retryAllBusy = false;
function statusBadge(s) {
  return '<span class="badge ' + s + '">' + (STATUS_LABEL[s] || s) + '</span>';
}
function escJs(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}
function jobDisplayPrompt(job) {
  return String((job && (job.display_prompt || job.prompt)) || '').trim();
}
function thumbMarkup(src, kind, label, title, extraClass) {
  var url = imgPath(src);
  return '<div class="thumb-wrap ' + kind + (extraClass ? (' ' + extraClass) : '') + '" onclick="openPreview(\'' + escJs(url) + '\')" title="' + esc(title || '') + '">' +
    '<img src="' + esc(url) + '">' +
    (label ? ('<span class="thumb-tag">' + esc(label) + '</span>') : '') +
    '<div class="thumb-overlay"><svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg></div>' +
    '</div>';
}
function referenceStackMarkup(job) {
  var images = (job && job.input_images) || [];
  if (!images.length) return '';
  var firstUrl = imgPath(images[0]);
  var countText = images.length > 1 ? ('×' + images.length) : '参考';
  return '<button type="button" class="reference-stack" onclick="openJobReferenceGallery(\'' + job.job_id + '\')" title="查看 ' + images.length + ' 张参考图">' +
    '<img src="' + esc(firstUrl) + '" alt="参考图">' +
    '<span class="reference-stack-tag">参</span>' +
    '<span class="reference-stack-count">' + countText + '</span>' +
  '</button>';
}
function queueMediaMarkup(group) {
  var first = group[0];
  var results = [];
  group.forEach(function (job, jobIndex) {
    (job.image_paths || []).forEach(function (src) {
      if (src) results.push({ src: src, jobIndex: jobIndex });
    });
  });
  var referenceHtml = referenceStackMarkup(first);
  if (!results.length) {
    var waitingText = group.length > 1 ? ('待生成 ×' + group.length) : '待生成';
    return '<div class="queue-media queue-media-pending">' +
      (referenceHtml || '<div class="thumb-placeholder queue-empty">…</div>') +
      '<span class="queue-media-pending-text">' + waitingText + '</span>' +
    '</div>';
  }
  var visibleResults = results.slice(0, 4);
  var gridClass = visibleResults.length === 1 ? ' single' : '';
  var outputHtml = visibleResults.map(function (item, index) {
    return thumbMarkup(item.src, 'result', String(index + 1), '生成结果 ' + (index + 1), 'queue-result');
  }).join('');
  var more = results.length > visibleResults.length ? '<span class="queue-output-more">+' + (results.length - visibleResults.length) + '</span>' : '';
  return '<div class="queue-media">' +
    referenceHtml +
    '<div class="queue-output-wrap"><div class="queue-output-grid' + gridClass + '">' + outputHtml + '</div>' + more + '</div>' +
  '</div>';
}
window.openJobReferenceGallery = function (jobId) {
  var job = jobs.find(function (item) { return item.job_id === jobId; });
  if (!job) { toast('参考图任务不存在'); return; }
  var images = job.input_images || [];
  openReferenceGallery(images, '参考图 (' + images.length + ' 张)');
};
function renderTable() {
  $('retryAllBtn').disabled = retryAllBusy || !jobs.some(function (job) { return job.status === 'failed'; });
  var body = $('batchBody');
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">还没有任务。在上面输入 prompt 后点"加入队列"。</td></tr>';
    return;
  }
  // 按 group_id 分组:同组 Job 合并成一行展示
  // 无 group_id 的 Job 单独成组(组大小 1)
  var groups = [];
  var groupMap = {};
  jobs.forEach(function (j) {
    var gid = j.group_id;
    if (gid) {
      if (!groupMap[gid]) { groupMap[gid] = []; groups.push(groupMap[gid]); }
      groupMap[gid].push(j);
    } else {
      groups.push([j]);
    }
  });
  var html = '';
  groups.forEach(function (g, gi) {
    var isGroup = g.length > 1;
    var first = g[0];
    var thumbHtml = queueMediaMarkup(g);
    // 状态汇总:同组的话显示 x/N 完成
    var doneCnt = g.filter(function (j) { return j.status === 'done'; }).length;
    var failedCnt = g.filter(function (j) { return j.status === 'failed'; }).length;
    var runningCnt = g.filter(function (j) { return j.status === 'running'; }).length;
    var queuedCnt = g.filter(function (j) { return j.status === 'queued'; }).length;
    var statusHtml;
    if (!isGroup) {
      statusHtml = statusBadge(first.status);
    } else {
      // 组模式:汇总显示
      if (doneCnt === g.length) {
        statusHtml = '<span class="badge done">全部完成 ' + doneCnt + '/' + g.length + '</span>';
      } else if (runningCnt > 0) {
        statusHtml = '<span class="badge running">生成中 ' + doneCnt + '/' + g.length + '</span>';
      } else if (failedCnt > 0 && queuedCnt === 0) {
        statusHtml = '<span class="badge failed">失败 ' + failedCnt + '/' + g.length + '</span>';
      } else {
        statusHtml = '<span class="badge queued">排队 ' + (doneCnt) + '/' + g.length + '</span>';
      }
    }
    // 进度文案:运行中的 Job 显示 detail
    var prog = '';
    prog = g.filter(function (j) { return j.status === 'running' && j.detail; }).map(function (j) {
      var prefix = j.queue_part ? (j.queue_index + '-' + j.queue_part + '：') : '';
      return '<div class="progress-line">' + esc(prefix + j.detail) + '</div>';
    }).join('');
    // 错误文案:失败的 Job 显示 error
    var errLine = '';
    var failedJob = g.find(function (j) { return j.status === 'failed' && j.error; });
    if (failedJob) {
      errLine = '<div class="progress-line" style="color:var(--err)">' + esc(failedJob.error) + '</div>';
    }
    // 操作:每个子 Job 独立保存/重试
    var actionsHtml = g.map(function (j, k) {
      var imgs = j.image_paths || [];
      var part = isGroup ? (j.queue_part || k + 1) : '';
      var copy = '<button class="small" onclick="copyJobPrompt(\'' + j.job_id + '\')">复制提示词' + part + '</button>';
      var dl = imgs.length ?
        '<a class="save-btn" href="' + imgPath(imgs[0]) + '" download target="_blank">保存' + part + '</a>' : '';
      var retry = (j.status === 'failed') ?
        '<button class="small" onclick="retryJob(\'' + j.job_id + '\')">重试' + part + '</button>' : '';
      var stop = (j.status === 'queued') ?
        '<button class="small danger" onclick="stopQueuedJob(\'' + j.job_id + '\')">停止' + part + '</button>' : (j.status === 'running' ?
        '<button class="small danger" ' + (j.stop_requested ? 'disabled' : 'onclick="stopRunningJob(\'' + j.job_id + '\')"') + '>' + (j.stop_requested ? '正在停止…' : '停止' + part) + '</button>' : '');
      var clear = (j.status === 'failed') ?
        '<button class="small danger" onclick="clearFailedJob(\'' + j.job_id + '\')">清除' + part + '</button>' : '';
      return copy + dl + retry + stop + clear;
    }).filter(Boolean).join(' ');
    var shownPrompt = jobDisplayPrompt(first);
    // 序号 + ×N badge
    var idxHtml = (first.queue_index || gi + 1) + (isGroup ? '<span class="count-badge">×' + g.length + '</span>' : '');
    html += '<tr class="' + (isGroup ? 'job-group' : '') + '">' +
      '<td>' + idxHtml + '</td>' +
      '<td class="thumb">' + thumbHtml + '</td>' +
      '<td class="prompt" title="' + esc(shownPrompt) + '">' + esc(shownPrompt) + prog + errLine + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td class="actions">' + actionsHtml + '</td>' +
      '</tr>';
  });
  body.innerHTML = html;
}
function upsertJob(j) {
  var found = false;
  for (var i = 0; i < jobs.length; i++) {
    if (jobs[i].job_id === j.job_id) { jobs[i] = j; found = true; break; }
  }
  if (!found) jobs.push(j);
  renderTable();
}
window.retryJob = function (jobId) {
  api('/api/jobs/' + jobId + '/retry', { method: 'POST' })
    .then(function () { toast('已重新入队'); })
    .catch(function (e) { toast('重试失败: ' + e.message); });
};
$('retryAllBtn').onclick = function () {
  if (retryAllBusy || !jobs.some(function (job) { return job.status === 'failed'; })) return;
  var provider = activeProvider;
  retryAllBusy = true;
  renderTable();
  api('/api/jobs/retry-all', { method: 'POST', body: JSON.stringify({ provider: provider }) })
    .then(function (result) {
      if (provider !== activeProvider) return;
      jobs = result.jobs || [];
      toast(result.retried ? '已将 ' + result.retried + ' 个失败任务重新加入队列' : '没有需要重试的失败任务');
      refreshQueueStatus();
    })
    .catch(function (error) { if (provider === activeProvider) toast('全部重试失败: ' + error.message); })
    .finally(function () { retryAllBusy = false; renderTable(); });
};

function confirmStopRunningTask(job, provider) {
  if (document.querySelector('.task-stop-mask')) return Promise.resolve(false);
  var previousFocus = document.activeElement;
  return new Promise(function (resolve) {
    var mask = document.createElement('div');
    mask.className = 'style-modal-mask task-stop-mask';
    mask.innerHTML = '<div class="style-modal task-stop-modal" role="alertdialog" aria-modal="true" aria-labelledby="stopTaskTitle" aria-describedby="stopTaskDescription">' +
      '<button class="style-modal-close task-stop-close" type="button" aria-label="关闭">×</button>' +
      '<div class="task-stop-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></div>' +
      '<h2 id="stopTaskTitle">停止这个任务？</h2>' +
      '<p id="stopTaskDescription">停止后将标记为失败，可稍后重试。其他并发任务会继续执行。</p>' +
      '<div class="task-stop-summary"><span class="task-stop-label"></span><p class="task-stop-prompt"></p></div>' +
      '<p class="task-stop-note">将尝试停止网页生成。已发送的请求可能仍会继续；已保存的图片会保留。</p>' +
      '<div class="task-stop-actions"><button class="task-stop-cancel" type="button">继续生成</button><button class="task-stop-confirm" type="button">停止任务</button></div></div>';
    var index = String(job.queue_index || '') + (job.queue_part ? '-' + job.queue_part : '');
    mask.querySelector('.task-stop-label').textContent = (provider === 'gemini' ? 'Gemini' : 'ChatGPT') + ' · 任务 ' + index + (job.worker_slot ? ' · 环境 ' + job.worker_slot : '');
    mask.querySelector('.task-stop-prompt').textContent = jobDisplayPrompt(job).slice(0, 160);
    var settled = false;
    function finish(confirmed) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      resolve(confirmed);
    }
    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
      if (event.key === 'Tab') {
        var buttons = Array.from(mask.querySelectorAll('button:not(:disabled)'));
        var first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || !mask.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !mask.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    }
    mask.querySelector('.task-stop-close').onclick = function () { finish(false); };
    mask.querySelector('.task-stop-cancel').onclick = function () { finish(false); };
    mask.querySelector('.task-stop-confirm').onclick = function () { finish(true); };
    mask.onclick = function (event) { if (event.target === mask) finish(false); };
    document.body.appendChild(mask);
    document.addEventListener('keydown', onKey, true);
    mask.querySelector('.task-stop-cancel').focus();
  });
}

window.stopRunningJob = async function (jobId) {
  var provider = activeProvider;
  var job = jobs.find(function (item) { return item.job_id === jobId; });
  if (!job || job.status !== 'running' || job.stop_requested) return;
  if (!(await confirmStopRunningTask(job, provider))) return;
  try {
    var result = await api('/api/jobs/' + jobId + '/stop', { method: 'POST', body: JSON.stringify({ provider: provider }) });
    if (provider === activeProvider) toast(result.stop_requested ? '正在停止任务，请稍候' : '任务已结束，无需停止');
  } catch (error) {
    if (provider === activeProvider) toast('停止失败: ' + error.message);
  }
};
window.stopQueuedJob = function (jobId) {
  api('/api/jobs/' + jobId + '/cancel', { method: 'POST' })
    .then(function () { toast('已停止该排队任务'); })
    .catch(function (e) { toast('停止失败: ' + e.message); });
};
window.clearFailedJob = function (jobId) {
  api('/api/jobs/' + jobId + '/remove', { method: 'POST' })
    .then(function () { toast('已清除失败任务'); })
    .catch(function (e) { toast('清除失败: ' + e.message); });
};
window.copyJobPrompt = function (jobId) {
  var job = jobs.find(function (j) { return j.job_id === jobId; });
  if (!job) { toast('任务不存在'); return; }
  var prompt = jobDisplayPrompt(job);
  $('batchText').value = prompt;
  $('batchText').focus();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(prompt).then(function () {
      toast('已复制并填入提示词');
    }).catch(function () {
      toast('已填入提示词');
    });
  } else {
    toast('已填入提示词');
  }
};

// ---------------------------------------------------------------------------
// SSE 订阅
// ---------------------------------------------------------------------------
function connectSSE() {
  window.imgcpt.onQueueEvent(function (data) {
    if (data.provider && data.provider !== activeProvider) return;
    if (data.type === 'queue_state' || data.type === 'job_added' || data.type === 'job_updated') refreshQueueStatus();
    if (data.type === 'job_added' || data.type === 'job_updated') {
      upsertJob(data.job);
    } else if (data.type === 'job_removed') {
      jobs = jobs.filter(function (job) { return job.job_id !== data.job_id; });
      renderTable();
    } else if (data.type === 'progress') {
      for (var i = 0; i < jobs.length; i++) {
        if (jobs[i].job_id === data.job_id) {
          if (jobs[i].stop_requested || jobs[i].status !== 'running') break;
          jobs[i].stage = data.stage;
          jobs[i].detail = data.detail;
          if (jobs[i].status !== 'running') jobs[i].status = 'running';
          break;
        }
      }
      renderTable();
    }
  });
}

// ---------------------------------------------------------------------------
// 初始化:拉一次快照 + 连 SSE + 检查登录
// ---------------------------------------------------------------------------
connectSSE();
setInterval(refreshHealth, 10000);
async function selectProvider(next, initial) {
  if (providerSwitching || (!initial && (next === activeProvider || browserToggleBusy || $('browserEngineSelect').disabled || apiUpdating))) return;
  if (!initial && document.querySelector('.api-modal, .task-stop-modal')) { toast('请先关闭当前弹窗'); return; }
  providerSwitching = true;
  document.querySelectorAll('#providerTabs .provider-tab').forEach(function (tab) { tab.disabled = true; });
  providerDrafts[activeProvider] = { prompt: $('batchText').value, additional: $('additionalPromptText').value, expanded: $('additionalPromptPanel').open, ratio: $('batchRatio').value, count: $('batchCount').value, mode: genMode, images: inputImages, selectedImageId: selectedImageId, style: selectedStyle };
  var previous = activeProvider;
  var switched = false;
  var apiReady = false;
  try {
    await window.imgcpt.invoke('provider-select', next);
    activeProvider = next;
    switched = true;
    try { localStorage.setItem('imgcpt_provider', next); } catch (e) {}
    var draft = providerDrafts[next] || { prompt: '', additional: '', expanded: false, ratio: 'auto', count: '1', mode: 'single', images: [], selectedImageId: null, style: null };
    $('batchText').value = draft.prompt;
    $('additionalPromptText').value = draft.additional;
    $('additionalPromptPanel').open = draft.expanded;
    $('batchRatio').value = draft.ratio;
    $('batchCount').value = draft.count;
    inputImages = draft.images;
    selectedImageId = draft.selectedImageId;
    selectedStyle = draft.style;
    setGenMode(draft.mode);
    renderImageRefs();
    updateAdditionalPromptState();
    updateStylePanel();
    document.querySelectorAll('#providerTabs .provider-tab').forEach(function (tab) { tab.classList.toggle('active', tab.dataset.provider === next); });
    $('providerNotice').textContent = '⚠️ 请勿直接关闭 ' + (next === 'gemini' ? 'Gemini' : 'ChatGPT') + ' 浏览器窗口 — 如需隐藏请点击“隐藏浏览器”按钮。切换 Chrome / Edge 会关闭当前平台的受控浏览器。';
    $('toggleBrowserBtn').title = '显示/隐藏所选浏览器的 ' + (next === 'gemini' ? 'Gemini' : 'ChatGPT') + ' 窗口';
    jobs = [];
    renderTable();
    var result = await api('/api/jobs');
    if (activeProvider === next && result.jobs) { jobs = result.jobs; renderTable(); }
    if (activeProvider !== next) return;
    refreshHealth();
    refreshBrowserState();
    refreshBrowserEngine();
    refreshQueueStatus();
  } catch (error) {
    if (!switched) activeProvider = previous;
    toast((switched ? '平台已切换，刷新状态失败: ' : '切换平台失败: ') + error.message);
  } finally {
    providerSwitching = false;
    document.querySelectorAll('#providerTabs .provider-tab').forEach(function (tab) { tab.disabled = false; });
  }
}
document.querySelectorAll('#providerTabs .provider-tab').forEach(function (tab) {
  tab.onclick = function () { selectProvider(tab.dataset.provider, false); };
});
var initialProvider = 'chatgpt';
try { if (localStorage.getItem('imgcpt_provider') === 'gemini') initialProvider = 'gemini'; } catch (e) {}
selectProvider(initialProvider, true);
