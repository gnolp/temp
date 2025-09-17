const { contextBridge, ipcRenderer } = require("electron");

console.log("✅ Preload loaded");

contextBridge.exposeInMainWorld('api', {
    addCamera: (cam) => ipcRenderer.invoke("add-camera", cam),
    removeCamera: (camId) => ipcRenderer.invoke("remove-camera", camId),
    updateModel: (camId, models) => ipcRenderer.send("update-model", { camId, models }),
    getFirstFrame: (camId, url) =>ipcRenderer.invoke("get-firstFrame", { camId, url })
});
