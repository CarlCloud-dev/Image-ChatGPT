const { contextBridge, ipcRenderer, webUtils } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("imgcpt", {
  invoke,
  fileUrl: (filePath) => invoke("file-url", filePath),
  filePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file && file.path ? file.path : "";
    }
  },
  onQueueEvent: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("queue-event", listener);
    return () => ipcRenderer.removeListener("queue-event", listener);
  },
  onBrowserStateEvent: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("browser-state-event", listener);
    return () => ipcRenderer.removeListener("browser-state-event", listener);
  },
});
