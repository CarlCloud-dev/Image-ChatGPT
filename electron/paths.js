const path = require("path");
const { app } = require("electron");

function sourceRoot() {
  return path.resolve(__dirname, "..");
}

function dataRoot() {
  return app.isPackaged ? path.dirname(process.execPath) : sourceRoot();
}

function configPath(name) {
  const editable = path.join(dataRoot(), "config", name);
  const bundled = path.join(sourceRoot(), "config", name);
  return require("fs").existsSync(editable) ? editable : bundled;
}

function fileUrl(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return `file:///${encodeURI(normalized)}`;
}

function paths() {
  const src = sourceRoot();
  const data = dataRoot();
  return {
    sourceRoot: src,
    dataRoot: data,
    rendererIndex: path.join(src, "renderer", "index.html"),
    rendererDir: path.join(src, "renderer"),
    stylesJson: configPath("styles.json"),
    selectorsJson: configPath("selectors.json"),
    stateJson: path.join(data, "config", "chat_state.json"),
    queueStateJson: path.join(data, "config", "queue_state.json"),
    configDir: path.join(data, "config"),
    logDir: path.join(data, "logs"),
    logFile: path.join(data, "logs", "app.log"),
    profileDir: path.join(data, "browser_profile"),
    outputDir: path.join(data, "output"),
    iconIco: path.join(src, "web-image-100.ico"),
    iconPng: path.join(src, "web-image-100.png"),
  };
}

module.exports = { paths, fileUrl };
