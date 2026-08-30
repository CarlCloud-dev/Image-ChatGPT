const fs = require("fs");
const path = require("path");

let logFile = null;
const maxBytes = 5 * 1024 * 1024;

function init(filePath) {
  logFile = filePath;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  rotateIfNeeded();
  info("logger.init", { file: logFile });
}

function rotateIfNeeded() {
  if (!logFile || !fs.existsSync(logFile)) return;
  const stat = fs.statSync(logFile);
  if (stat.size < maxBytes) return;
  const backup = `${logFile}.1`;
  fs.rmSync(backup, { force: true });
  fs.renameSync(logFile, backup);
}

function normalizeMeta(meta) {
  if (!meta) return undefined;
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
    };
  }
  return meta;
}

function write(level, message, meta) {
  if (!logFile) return;
  try {
    rotateIfNeeded();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      meta: normalizeMeta(meta),
    });
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  } catch {
    // Logging must never affect the app flow.
  }
}

function info(message, meta) {
  write("info", message, meta);
}

function warn(message, meta) {
  write("warn", message, meta);
}

function error(message, meta) {
  write("error", message, meta);
}

module.exports = { init, info, warn, error };
