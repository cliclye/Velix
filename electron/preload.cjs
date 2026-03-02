const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__VELIX_ELECTRON__", {
  invoke: (command, args) => ipcRenderer.invoke("velix:invoke", { command, args }),
  listen: (eventName, callback) => {
    const channel = `velix:event:${eventName}`;
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  readDir: (path) => ipcRenderer.invoke("velix:fs:readDir", { path }),
  readTextFile: (path) => ipcRenderer.invoke("velix:fs:readTextFile", { path }),
  writeTextFile: (path, contents) =>
    ipcRenderer.invoke("velix:fs:writeTextFile", { path, contents }),
  remove: (path) => ipcRenderer.invoke("velix:fs:remove", { path }),
  openDirectory: () => ipcRenderer.invoke("velix:dialog:openDirectory"),
  isNotificationPermissionGranted: () =>
    ipcRenderer.invoke("velix:notify:isPermissionGranted"),
  requestNotificationPermission: () =>
    ipcRenderer.invoke("velix:notify:requestPermission"),
  sendNotification: (payload) => ipcRenderer.invoke("velix:notify:send", payload),
});
