// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
var $ = function (id) { return document.getElementById(id); };
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
  if (path === '/api/chat/new') return window.imgcpt.invoke('chat-new');
  if (path === '/api/chat/open-last') return window.imgcpt.invoke('chat-open-last');
  if (path === '/api/chat/status') return window.imgcpt.invoke('chat-status');
  if (path === '/api/generate') return window.imgcpt.invoke('generate', body || {});
  if (path === '/api/generate/batch') return window.imgcpt.invoke('generate-batch', body || {});
  if (path === '/api/jobs') return window.imgcpt.invoke('jobs');
  if (path === '/api/jobs/clear-completed') return window.imgcpt.invoke('clear-completed-jobs');
  if (/^\/api\/jobs\/[^/]+\/retry$/.test(path)) {
    return window.imgcpt.invoke('retry-job', path.split('/')[3]);
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
function refreshHealth() {
  api('/api/health').then(function (h) {
    var dot = $('loginDot'), txt = $('loginText');
    if (!dot || !txt) return;
    if (h.initializing) {
      dot.className = 'dot warn'; txt.textContent = '浏览器启动中…';
    } else if (!h.driver_ready) {
      dot.className = 'dot warn'; txt.textContent = '浏览器未启动 — 点"显示浏览器"';
    } else if (h.logged_in) {
      dot.className = 'dot ok'; txt.textContent = '已登录 ChatGPT';
    } else {
      dot.className = 'dot warn'; txt.textContent = '未登录 — 点"显示浏览器"登录';
    }
  }).catch(function () {
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

// 浏览器窗口显示/隐藏切换(后台 CDP 模式专属)
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
  api('/api/browser/state').then(function (s) {
    if (s.ok && s.cdp) {
      updateToggleBrowserBtn(s.visible);
      $('toggleBrowserBtn').disabled = false;
    } else {
      // 非 CDP 模式:禁用按钮(可见模式下窗口本来就在)
      $('toggleBrowserBtn').disabled = true;
      $('toggleBrowserBtn').textContent = '显示浏览器';
    }
  }).catch(function () { /* 启动早期接口可能未就绪,忽略 */ });
}
if (window.imgcpt.onBrowserStateEvent) {
  window.imgcpt.onBrowserStateEvent(function (s) {
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

// 对话滑块:切换即导航浏览器
var chatMode = 'new'; // 当前选中的模式(初始化时根据记忆状态覆盖)
function setChatMode(mode, navigate) {
  chatMode = mode;
  document.querySelectorAll('#chatToggle .toggle-opt').forEach(function (x) {
    x.classList.toggle('active', x.dataset.mode === mode);
  });
  if (!navigate) return;
  if (mode === 'new') {
    api('/api/chat/new', { method: 'POST' }).then(function (d) {
      toast(d.ok ? '已进入新对话' : '打开失败: ' + (d.error || ''));
    }).catch(function (e) { toast('打开失败: ' + e.message); });
  } else {
    api('/api/chat/open-last', { method: 'POST' }).then(function (d) {
      toast(d.ok ? '已打开上次对话' : '打开失败: ' + (d.error || '还没有上次对话'));
    }).catch(function (e) { toast('打开失败: ' + e.message); });
  }
}
document.querySelectorAll('#chatToggle .toggle-opt').forEach(function (opt) {
  opt.onclick = function () { setChatMode(opt.dataset.mode, true); };
});

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
    lbl.textContent = '通用提示词(图生图,可选)';
    ta.placeholder = '例如:保持主体姿态,改成电影海报风格。也可以在每张参考图卡片里填写独立提示词。';
  }
}
document.querySelectorAll('#genModeToggle .toggle-opt').forEach(function (opt) {
  opt.onclick = function () { setGenMode(opt.dataset.mode); };
});
setGenMode('single');

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
  dz.textContent = hasImages ? '拖拽图片到这里继续添加，或点击“添加参考图”' : '拖拽图片到这里，或点击“添加参考图”';
}
function removeImageRef(id) {
  var removed = inputImages.find(function (x) { return x.id === id; });
  if (removed && removed.preview && removed.preview.indexOf('blob:') === 0) URL.revokeObjectURL(removed.preview);
  inputImages = inputImages.filter(function (x) { return x.id !== id; });
  if (selectedImageId === id) selectedImageId = inputImages.length ? inputImages[0].id : null;
  renderImageRefs();
}
function renderImageRefEditor() {
  var editor = $('imageRefEditor');
  var item = selectedImageRef();
  if (!item) {
    editor.classList.add('hidden');
    $('imageRefName').textContent = '';
    $('imageRefPrompt').value = '';
    return;
  }
  editor.classList.remove('hidden');
  $('imageRefName').textContent = item.name;
  $('imageRefName').title = item.path;
  $('imageRefPrompt').value = item.prompt || '';
}
function renderImageRefs() {
  var root = $('imageRefs');
  if (!inputImages.length) {
    root.innerHTML = '';
    selectedImageId = null;
    updateImageCount();
    updateImageDropzone();
    renderImageRefEditor();
    return;
  }
  if (!selectedImageRef()) selectedImageId = inputImages[0].id;
  root.innerHTML = inputImages.map(function (it, i) {
    var active = it.id === selectedImageId ? ' active' : '';
    var hasPrompt = String(it.prompt || '').trim() ? ' has-prompt' : '';
    return '<div class="image-ref-chip' + active + hasPrompt + '" data-id="' + esc(it.id) + '" title="' + esc(it.name) + '">' +
      '<img src="' + esc(it.preview) + '" alt="">' +
      '<span class="image-ref-index">' + (i + 1) + '</span>' +
      '<button class="image-ref-remove" type="button" title="移除">×</button>' +
      '<span class="image-ref-dot"></span>' +
    '</div>';
  }).join('');
  root.querySelectorAll('.image-ref-chip').forEach(function (card) {
    var id = card.dataset.id;
    card.onclick = function () {
      selectedImageId = id;
      renderImageRefs();
    };
    card.querySelector('.image-ref-remove').onclick = function (e) {
      e.stopPropagation();
      removeImageRef(id);
    };
  });
  updateImageCount();
  updateImageDropzone();
  renderImageRefEditor();
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
      preview: URL.createObjectURL(file),
      prompt: ''
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
  var mode = $('imageQueueMode').value;
  if (!inputImages.length) throw new Error('请先添加参考图');
  if (mode === 'multi-ref') {
    var notes = inputImages.map(function (it, i) {
      var p = String(it.prompt || '').trim();
      return p ? ('参考图' + (i + 1) + '(' + it.name + '): ' + p) : '';
    }).filter(Boolean).join('\n');
    var merged = globalText;
    if (notes) merged = merged ? (merged + '\n' + notes) : notes;
    if (!merged.trim()) throw new Error('请输入通用提示词或至少一张图的独立提示词');
    return [{
      prompt: makePrompt(withSelectedStyle(merged), ratio),
      display_prompt: merged,
      input_images: inputImages.map(function (it) { return it.path; }),
      name: inputImages.length > 1 ? 'multi_reference' : inputImages[0].name,
      count: count
    }];
  }
  return inputImages.map(function (it) {
    var text = String(it.prompt || '').trim() || globalText;
    if (!text) return null;
    return {
      prompt: makePrompt(withSelectedStyle(text), ratio),
      display_prompt: text,
      input_images: [it.path],
      name: it.name,
      count: count
    };
  }).filter(Boolean);
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
$('imageRefPrompt').oninput = function (e) {
  var item = selectedImageRef();
  if (!item) return;
  item.prompt = e.target.value;
  var card = null;
  document.querySelectorAll('.image-ref-chip').forEach(function (x) {
    if (x.dataset.id === item.id) card = x;
  });
  if (card) card.classList.toggle('has-prompt', String(item.prompt || '').trim().length > 0);
};
$('imagePreviewBtn').onclick = function () {
  var item = selectedImageRef();
  if (item) openPreview(item.preview);
};
$('imageRemoveBtn').onclick = function () {
  var item = selectedImageRef();
  if (item) removeImageRef(item.id);
};
$('imageFileInput').onchange = function (e) {
  addImageFiles(e.target.files);
  e.target.value = '';
};
$('imageDropzone').onclick = function () { $('imageFileInput').click(); };
$('imageDropzone').ondragover = function (e) {
  e.preventDefault();
  $('imageDropzone').classList.add('drag');
};
$('imageDropzone').ondragleave = function () {
  $('imageDropzone').classList.remove('drag');
};
$('imageDropzone').ondrop = function (e) {
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

$('batchEnq').onclick = function () {
  var text = $('batchText').value.trim();
  var ratio = $('batchRatio').value;
  var count = parseInt($('batchCount').value, 10) || 1;
  var mode = chatMode === 'last' ? 'reuse' : 'new';
  if (genMode !== 'image' && !text) { toast('请输入提示词'); return; }
  if (genMode === 'single') {
    // 单图:整段作为一个 prompt,生成 count 张
    var prompt = makePrompt(withSelectedStyle(text), ratio);
    api('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, display_prompt: text, count: count, chat_mode: mode })
    }).then(function (d) {
      toast(count > 1 ? '已加入队列(×' + count + ')' : '已加入队列');
    }).catch(function (e) { toast('加入失败: ' + e.message); });
  } else if (genMode === 'batch') {
    // 批量:按行分割,每行生成 count 张
    var rawPrompts = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var prompts = rawPrompts.map(function (p) {
      return { prompt: makePrompt(withSelectedStyle(p), ratio), display_prompt: p };
    }).filter(function (it) { return it.prompt.length > 6; });
    if (!prompts.length) { toast('没有有效的 prompt'); return; }
    api('/api/generate/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts: prompts, chat_mode: mode, count: count })
    }).then(function (d) {
      toast('已加入 ' + d.enqueued + ' 个任务' + (count > 1 ? '(每个×' + count + ')' : ''));
    }).catch(function (e) { toast('加入失败: ' + e.message); });
  } else {
    try {
      var imageJobs = buildImageJobs(text, ratio, count);
      if (!imageJobs.length) { toast('请填写通用提示词或每张图的独立提示词'); return; }
      api('/api/generate/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts: imageJobs, chat_mode: mode, count: 1 })
      }).then(function (d) {
        toast('已加入 ' + d.enqueued + ' 个图生图任务');
      }).catch(function (e) { toast('加入失败: ' + e.message); });
    } catch (e) {
      toast(e.message || String(e));
    }
  }
};

$('batchClear').onclick = function () {
  api('/api/jobs/clear-completed', { method: 'POST' }).then(function (d) {
    jobs = d.jobs || [];
    renderTable();
  }).catch(function (e) { toast('清空失败: ' + e.message); });
};
$('stopBtn').onclick = function () {
  api('/api/stop', { method: 'POST' }).then(function () { toast('已清空排队任务'); })
    .catch(function (e) { toast('停止失败: ' + e.message); });
};

// ---------------------------------------------------------------------------
// 任务表
// ---------------------------------------------------------------------------
var jobs = [];
function statusBadge(s) {
  return '<span class="badge ' + s + '">' + (STATUS_LABEL[s] || s) + '</span>';
}
function escJs(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}
function jobDisplayPrompt(job) {
  return String((job && (job.display_prompt || job.prompt)) || '').trim();
}
function thumbMarkup(src, kind, label, title) {
  var url = imgPath(src);
  return '<div class="thumb-wrap ' + kind + '" onclick="openPreview(\'' + escJs(url) + '\')" title="' + esc(title || '') + '">' +
    '<img src="' + esc(url) + '">' +
    '<span class="thumb-tag">' + esc(label) + '</span>' +
    '<div class="thumb-overlay"><svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg></div>' +
    '</div>';
}
function renderTable() {
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
    var sourceImages = first.input_images || [];
    var sourceHtml = sourceImages.map(function (src, k) {
      return thumbMarkup(src, 'source', '原', '参考图 ' + (k + 1));
    }).join('');
    // 缩略图:先显示参考图,再显示同组所有生成图;没有生成图的显示占位框
    var outputHtml = g.map(function (j, k) {
      var imgs = j.image_paths || [];
      if (imgs.length) {
        return thumbMarkup(imgs[0], 'result', '出', '生成结果 ' + (k + 1));
      }
      // 占位框:运行中显示序号,排队显示 …,失败显示 ✗
      var label = (j.status === 'running') ? (k + 1) : (j.status === 'failed' ? '✗' : '…');
      return '<div class="thumb-placeholder">' + label + '</div>';
    }).join('');
    var thumbHtml = sourceHtml + outputHtml;
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
    var runningJob = g.find(function (j) { return j.status === 'running'; });
    if (runningJob && runningJob.detail) {
      prog = '<div class="progress-line">' + esc(runningJob.detail) + '</div>';
    }
    // 错误文案:失败的 Job 显示 error
    var errLine = '';
    var failedJob = g.find(function (j) { return j.status === 'failed' && j.error; });
    if (failedJob) {
      errLine = '<div class="progress-line" style="color:var(--err)">' + esc(failedJob.error) + '</div>';
    }
    // 操作:每个子 Job 独立保存/重试
    var actionsHtml = g.map(function (j, k) {
      var imgs = j.image_paths || [];
      var copy = '<button class="small" onclick="copyJobPrompt(\'' + j.job_id + '\')">复制提示词' + (isGroup ? (k + 1) : '') + '</button>';
      var dl = imgs.length ?
        '<a class="save-btn" href="' + imgPath(imgs[0]) + '" download target="_blank">保存' + (isGroup ? (k + 1) : '') + '</a>' : '';
      var retry = (j.status === 'failed') ?
        '<button class="small" onclick="retryJob(\'' + j.job_id + '\')">重试' + (isGroup ? (k + 1) : '') + '</button>' : '';
      return copy + dl + retry;
    }).filter(Boolean).join(' ');
    var shownPrompt = jobDisplayPrompt(first);
    // 序号 + ×N badge
    var idxHtml = (gi + 1) + (isGroup ? '<span class="count-badge">×' + g.length + '</span>' : '');
    html += '<tr class="' + (isGroup ? 'job-group' : '') + '">' +
      '<td>' + idxHtml + '</td>' +
      '<td class="thumb"><div class="thumb-row">' + thumbHtml + '</div></td>' +
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
    if (data.type === 'job_added' || data.type === 'job_updated') {
      upsertJob(data.job);
    } else if (data.type === 'progress') {
      for (var i = 0; i < jobs.length; i++) {
        if (jobs[i].job_id === data.job_id) {
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
api('/api/jobs').then(function (d) {
  if (d.jobs) { jobs = d.jobs; renderTable(); }
}).catch(function () {});
connectSSE();
refreshHealth();
setInterval(refreshHealth, 30000);
refreshBrowserState();  // 查询浏览器窗口初始显示状态
// 初始化对话模式:有上次对话记忆则选中"上次对话",否则"新对话"
// 注意:不触发导航,因为 driver init 时已经根据记忆加载了对应 URL
api('/api/chat/status').then(function (s) {
  setChatMode(s.has_memory ? 'last' : 'new', false);
}).catch(function () { setChatMode('new', false); });
