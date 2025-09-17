const { contextBridge, ipcRenderer } = require("electron");

console.log("✅ Preload loaded");

contextBridge.exposeInMainWorld('api', {
    removeCamera: (camId) => ipcRenderer.invoke("remove-camera", camId),
    updateModel: (camId, models) => ipcRenderer.send("update-model", { camId, models }),
    getFirstFrame: (camId, url) =>ipcRenderer.invoke("get-firstFrame", { camId, url }),
    saveDetection: (data) => ipcRenderer.invoke('save-detection', data),
    getLatestDetections: ({ cameraId, limit }) => ipcRenderer.invoke('get-latest-detections', { cameraId, limit }),
    getCameraList: () => ipcRenderer.invoke('getCameraList'),
    addNewCamera: (cameraData) => ipcRenderer.invoke('add-new-camera', cameraData),
    violationAdd: (payload) => ipcRenderer.invoke('violation-add', payload),
    lineUpsert: (payload) => ipcRenderer.invoke('line-upsert', payload),
    lineList: (cameraId) => ipcRenderer.invoke('line-list', cameraId),
    getTrafficHistory: (cameraId, timeRange) => ipcRenderer.invoke('getTrafficHistory', cameraId, timeRange),
    updateCamera: async (cameraId, updateData = {}) => {
        return await ipcRenderer.invoke("updateCamera", cameraId, updateData);
    },
});
