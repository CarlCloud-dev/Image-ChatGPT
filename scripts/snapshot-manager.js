const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const snapshotRootDir = path.join(root, 'config', 'snapshots');

const profileMap = {
  'chatgpt-chrome': 'browser_profile',
  'chatgpt-edge': 'browser_profile_edge',
  'gemini-chrome': 'browser_profile_gemini_chrome',
  'gemini-edge': 'browser_profile_gemini_edge',
};

const corePatterns = [
  /^Local State$/,
  /^Default[\\/]Preferences$/,
  /^Default[\\/]Secure Preferences$/,
  /^Default[\\/]Network[\\/]Cookies/,
  /^Default[\\/]Local Storage/,
  /^Default[\\/]IndexedDB/,
  /^Default[\\/]Session Storage/,
  /^Default[\\/]Sync Data/,
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function releaseProfileLock(profileDir) {
  try {
    const dirName = path.basename(profileDir);
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "${dirName}" -and ($_.Name -eq "msedge.exe" -or $_.Name -eq "chrome.exe") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000 });
    const waitTill = Date.now() + 1200;
    while (Date.now() < waitTill) {}
  } catch (_) {}
}

function getAuthFiles(profileDir) {
  const files = [];
  function walk(dir, relPath = '') {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = relPath ? path.join(relPath, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'BrowserMetrics', 'Crashpad', 'Service Worker'].includes(entry.name)) {
          continue;
        }
        walk(full, rel);
      } else {
        if (corePatterns.some((p) => p.test(rel))) {
          files.push({ full, rel, size: fs.statSync(full).size });
        }
      }
    }
  }
  walk(profileDir);
  return files;
}

function safeCopyFile(src, dest, profileDir) {
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      releaseProfileLock(profileDir);
      fs.copyFileSync(src, dest);
    } else {
      throw err;
    }
  }
}

function backup(platform, engine = 'edge', tag = 'default') {
  const key = `${platform.toLowerCase()}-${engine.toLowerCase()}`;
  const dirName = profileMap[key];
  if (!dirName) {
    console.error(`[错误] 未知平台或浏览器: ${platform} + ${engine}`);
    process.exit(1);
  }

  const profileDir = path.join(root, dirName);
  if (!fs.existsSync(profileDir)) {
    console.error(`[错误] 浏览器资料目录不存在: ${profileDir}`);
    console.error(`       请先在应用中点击"显示浏览器"并完成账号登录。`);
    process.exit(1);
  }

  // 备份前主动释放受控浏览器对文件的独占锁，避免 EBUSY 异常
  releaseProfileLock(profileDir);

  const files = getAuthFiles(profileDir);
  if (!files.length || !files.some((f) => f.rel.includes('Cookies'))) {
    console.warn(`[警告] 目录 ${profileDir} 中未检测到有效的登录凭据(Cookies)。`);
    console.warn(`       请先在该浏览器中登录 ChatGPT 或 Gemini 账号后再备份。`);
    process.exit(1);
  }

  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeTag = String(tag).replace(/[\\/:*?"<>|\s]/g, '_');
  const snapshotName = `${platform}_${engine}_${safeTag}_${dateStr}`;
  const targetDir = path.join(snapshotRootDir, snapshotName);
  ensureDir(targetDir);

  let totalBytes = 0;
  for (const f of files) {
    const dest = path.join(targetDir, 'data', f.rel);
    ensureDir(path.dirname(dest));
    safeCopyFile(f.full, dest, profileDir);
    totalBytes += f.size;
  }

  const meta = {
    name: snapshotName,
    platform: platform.toLowerCase(),
    engine: engine.toLowerCase(),
    tag: safeTag,
    createdAt: new Date().toISOString(),
    filesCount: files.length,
    sizeBytes: totalBytes,
    sizeMB: (totalBytes / 1024 / 1024).toFixed(2),
  };
  fs.writeFileSync(path.join(targetDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  console.log(`\n[成功] 登录态快照备份完成！`);
  console.log(`- 快照名称: ${snapshotName}`);
  console.log(`- 所属平台: ${platform.toUpperCase()} (${engine})`);
  console.log(`- 核心数据: ${files.length} 个文件 (~${meta.sizeMB} MB)`);
  console.log(`- 存储目录: ${targetDir}\n`);
}

function list() {
  ensureDir(snapshotRootDir);
  const entries = fs.readdirSync(snapshotRootDir, { withFileTypes: true });
  const snapshots = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const metaFile = path.join(snapshotRootDir, entry.name, 'meta.json');
      if (fs.existsSync(metaFile)) {
        try {
          snapshots.push(JSON.parse(fs.readFileSync(metaFile, 'utf8')));
        } catch (_) {}
      }
    }
  }

  if (!snapshots.length) {
    console.log('\n[提示] 当前尚未备份任何账号快照。');
    return [];
  }

  console.log('\n================ 已保存的账号快照列表 ================');
  snapshots.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  snapshots.forEach((s, idx) => {
    console.log(`[${idx + 1}] ${s.name}`);
    console.log(`    平台: ${s.platform.toUpperCase()} | 浏览器: ${s.engine} | 备注: ${s.tag}`);
    console.log(`    大小: ${s.sizeMB} MB (${s.filesCount} 个文件) | 备份时间: ${new Date(s.createdAt).toLocaleString('zh-CN')}`);
  });
  console.log('====================================================\n');
  return snapshots;
}

function restore(snapshotNameOrIndex) {
  const snapshots = list();
  let target = null;
  const num = parseInt(snapshotNameOrIndex, 10);
  if (!isNaN(num) && num >= 1 && num <= snapshots.length) {
    target = snapshots[num - 1];
  } else {
    target = snapshots.find((s) => s.name === snapshotNameOrIndex);
  }

  if (!target) {
    console.error(`[错误] 未找到指定的快照: ${snapshotNameOrIndex}`);
    process.exit(1);
  }

  const key = `${target.platform}-${target.engine}`;
  const dirName = profileMap[key];
  const profileDir = path.join(root, dirName);
  const snapshotDataDir = path.join(snapshotRootDir, target.name, 'data');

  if (!fs.existsSync(snapshotDataDir)) {
    console.error(`[错误] 快照数据目录不存在: ${snapshotDataDir}`);
    process.exit(1);
  }

  // 还原前主动释放锁
  releaseProfileLock(profileDir);

  console.log(`\n正在还原快照 [${target.name}] 到 ${dirName} ...`);
  ensureDir(profileDir);

  let restoredCount = 0;
  function copyRecursive(src, dest) {
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, item.name);
      const destPath = path.join(dest, item.name);
      if (item.isDirectory()) {
        ensureDir(destPath);
        copyRecursive(srcPath, destPath);
      } else {
        ensureDir(path.dirname(destPath));
        safeCopyFile(srcPath, destPath, profileDir);
        restoredCount++;
      }
    }
  }

  try {
    copyRecursive(snapshotDataDir, profileDir);
    console.log(`[成功] 已还原 ${restoredCount} 个核心认证文件！`);
    console.log(`- 平台: ${target.platform.toUpperCase()} (${target.engine})`);
    console.log(`- 目标目录: ${profileDir}`);
    console.log(`- 提示: 重新打开应用并点击"显示浏览器"，即可恢复登录态。\n`);
  } catch (err) {
    console.error(`[错误] 还原失败: ${err.message}`);
    process.exit(1);
  }
}

function remove(snapshotNameOrIndex) {
  const snapshots = list();
  let target = null;
  const num = parseInt(snapshotNameOrIndex, 10);
  if (!isNaN(num) && num >= 1 && num <= snapshots.length) {
    target = snapshots[num - 1];
  } else {
    target = snapshots.find((s) => s.name === snapshotNameOrIndex);
  }

  if (!target) {
    console.error(`[错误] 未找到指定的快照: ${snapshotNameOrIndex}`);
    process.exit(1);
  }

  const targetDir = path.join(snapshotRootDir, target.name);
  fs.rmSync(targetDir, { recursive: true, force: true });
  console.log(`[成功] 已删除快照: ${target.name}\n`);
}

const [cmd, arg1, arg2, arg3] = process.argv.slice(2);
if (cmd === 'backup') {
  backup(arg1 || 'chatgpt', arg2 || 'edge', arg3 || 'default');
} else if (cmd === 'list') {
  list();
} else if (cmd === 'restore') {
  restore(arg1);
} else if (cmd === 'delete') {
  remove(arg1);
} else {
  console.log(`
使用方式:
  node scripts/snapshot-manager.js backup <chatgpt|gemini> [edge|chrome] [备注标签]
  node scripts/snapshot-manager.js list
  node scripts/snapshot-manager.js restore <序号或快照名称>
  node scripts/snapshot-manager.js delete <序号或快照名称>
`);
}
