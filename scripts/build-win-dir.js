const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outRoot = path.join(root, "dist-electron");
const outDir = path.join(outRoot, "Image-ChatGPT-win32-x64");
const appDir = path.join(outDir, "resources", "app");
const preserveDir = path.join(outRoot, ".runtime-preserve");
const runtimeDirs = ["browser_profile", "output", "config"];
const cleanRuntime = process.argv.includes("--clean-runtime");
const electronMirror = "https://npmmirror.com/mirrors/electron/";
const electronBuilderMirror = "https://npmmirror.com/mirrors/electron-builder-binaries/";

function walkFiles(dir, visitor) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visitor);
    } else {
      visitor(fullPath);
    }
  }
}

function findElectronZip(version) {
  const zipName = `electron-v${version}-win32-x64.zip`;
  const roots = [
    process.env.electron_config_cache,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "electron", "Cache") : null,
  ].filter(Boolean);

  for (const cacheRoot of roots) {
    let found = null;
    walkFiles(cacheRoot, (filePath) => {
      if (!found && path.basename(filePath) === zipName) found = filePath;
    });
    if (found) return found;
  }
  return null;
}

function repairElectronRuntime(electronDist, electronExe) {
  if (fs.existsSync(electronExe)) return;

  const electronPackage = require(path.join(root, "node_modules", "electron", "package.json"));
  const zipPath = findElectronZip(electronPackage.version);
  if (!zipPath) return;

  console.log("[deps] electron runtime incomplete; extracting cached electron zip");
  fs.rmSync(electronDist, { recursive: true, force: true });
  fs.mkdirSync(electronDist, { recursive: true });
  const result = spawnSync("tar", ["-xf", zipPath, "-C", electronDist], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    const detail = result.error ? ` ${result.error.message || result.error}` : "";
    throw new Error(`Cannot extract cached Electron runtime.${detail}`);
  }
  fs.writeFileSync(path.join(root, "node_modules", "electron", "path.txt"), "electron.exe", "utf8");
}

function ensureDependencies() {
  const electronDist = path.join(root, "node_modules", "electron", "dist");
  const electronExe = path.join(electronDist, "electron.exe");
  const electronInstallScript = path.join(root, "node_modules", "electron", "install.js");
  const playwrightCore = path.join(root, "node_modules", "playwright-core", "package.json");
  if (fs.existsSync(electronExe) && fs.existsSync(playwrightCore)) return;

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const installEnv = {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || electronMirror,
    ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || electronBuilderMirror,
  };
  const runNpm = (args) => {
    if (fs.existsSync(npmCli)) {
      return spawnSync(process.execPath, [npmCli, ...args], {
        cwd: root,
        env: installEnv,
        stdio: "inherit",
        shell: false,
        timeout: 10 * 60 * 1000,
      });
    }
    return spawnSync(npmCmd, args, {
      cwd: root,
      env: installEnv,
      stdio: "inherit",
      shell: process.platform === "win32",
      timeout: 10 * 60 * 1000,
    });
  };

  console.log("[deps] node_modules missing; running npm install");
  const result = runNpm(["install", "--foreground-scripts"]);
  if (result.status !== 0) {
    const detail = result.error ? ` ${result.error.message || result.error}` : "";
    throw new Error(`npm install failed.${detail} Please run npm.cmd install manually, then build again. If Electron download is slow, set ELECTRON_MIRROR=${electronMirror}`);
  }
  if (!fs.existsSync(electronExe) && fs.existsSync(electronInstallScript)) {
    console.log("[deps] electron runtime missing; running npm rebuild electron");
    const rebuild = runNpm(["rebuild", "electron", "--foreground-scripts"]);
    if (rebuild.status !== 0) {
      const detail = rebuild.error ? ` ${rebuild.error.message || rebuild.error}` : "";
      throw new Error(`npm rebuild electron failed.${detail} Please run npm.cmd rebuild electron manually, then build again. If Electron download is slow, set ELECTRON_MIRROR=${electronMirror}`);
    }
  }
  repairElectronRuntime(electronDist, electronExe);
  if (!fs.existsSync(electronExe) || !fs.existsSync(playwrightCore)) {
    throw new Error("Dependencies are still missing after npm install.");
  }
}

function copy(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (p) => {
      const normalized = p.replace(/\\/g, "/");
      return !normalized.includes("/node_modules/.cache/") &&
        !normalized.includes("/.npm-cache/") &&
        !normalized.includes("/.electron-cache/") &&
        !normalized.includes("/BrowserMetrics/") &&
        !normalized.includes("/DeferredBrowserMetrics/") &&
        !normalized.endsWith(".pma") &&
        !normalized.endsWith(".tmp");
    },
  });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.rmSync(dest, { recursive: true, force: true });
  copy(src, dest);
  return true;
}

function findRcedit() {
  const candidates = [
    path.join(root, "node_modules", "rcedit", "bin", "rcedit-x64.exe"),
    path.join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function buildWindowControl() {
  const project = path.join(root, "tools", "window-control", "WindowControl.csproj");
  if (!fs.existsSync(project)) return;
  const output = path.join(root, "electron", "bin");
  console.log("[build] window control");
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const result = spawnSync("dotnet", [
    "publish",
    project,
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "false",
    "-o",
    output,
  ], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("WindowControl.exe build failed");
  }
}

ensureDependencies();
buildWindowControl();

console.log("[clean]", outDir);
fs.rmSync(preserveDir, { recursive: true, force: true });
if (cleanRuntime) {
  console.log("[clean-runtime] not preserving browser_profile/output/config");
} else {
  for (const dir of runtimeDirs) {
    try {
      copyIfExists(path.join(outDir, dir), path.join(preserveDir, dir));
    } catch (e) {
      throw new Error(`Cannot preserve runtime directory "${dir}". Close Image-ChatGPT and its background Chrome before building. ${e.message || e}`);
    }
  }
}
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

console.log("[copy] electron runtime");
copy(path.join(root, "node_modules", "electron", "dist"), outDir);

const electronExe = path.join(outDir, "electron.exe");
const productExe = path.join(outDir, "Image-ChatGPT.exe");
if (fs.existsSync(productExe)) fs.rmSync(productExe, { force: true });
fs.renameSync(electronExe, productExe);

console.log("[copy] app files");
for (const dir of ["electron", "renderer", "prompts"]) {
  copy(path.join(root, dir), path.join(appDir, dir));
}
copyFile(path.join(root, "config", "selectors.json"), path.join(appDir, "config", "selectors.json"));
copyFile(path.join(root, "config", "styles.json"), path.join(appDir, "config", "styles.json"));
copyFile(path.join(root, "web-image-100.ico"), path.join(appDir, "web-image-100.ico"));
copyFile(path.join(root, "web-image-100.png"), path.join(appDir, "web-image-100.png"));
copyFile(path.join(root, "README.md"), path.join(appDir, "README.md"));

fs.mkdirSync(path.join(appDir, "node_modules"), { recursive: true });
copy(path.join(root, "node_modules", "playwright-core"), path.join(appDir, "node_modules", "playwright-core"));

const pkg = require(path.join(root, "package.json"));
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  main: pkg.main,
  dependencies: {
    "playwright-core": pkg.dependencies["playwright-core"],
  },
}, null, 2), "utf8");

if (!cleanRuntime) {
  for (const dir of runtimeDirs) {
    copyIfExists(path.join(preserveDir, dir), path.join(outDir, dir));
  }
  if (!fs.existsSync(path.join(outDir, "browser_profile"))) {
    copyIfExists(path.join(root, "browser_profile"), path.join(outDir, "browser_profile"));
  }
}
fs.rmSync(preserveDir, { recursive: true, force: true });

const rcedit = findRcedit();
if (rcedit) {
  console.log("[icon] applying ico");
  const result = spawnSync(rcedit, [
    productExe,
    "--set-icon",
    path.join(root, "web-image-100.ico"),
  ], { stdio: "inherit" });
  if (result.status !== 0) {
    console.warn("[warn] rcedit failed; exe is still usable but may show default icon");
  }
} else {
  console.warn("[warn] rcedit not found; exe is still usable but may show default icon");
}

console.log("[done]", productExe);
