const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    saveDetection: (data) => ipcRenderer.invoke('save-detection', data),
    getLatestDetections: ({ cameraId, limit }) => ipcRenderer.invoke('get-latest-detections', { cameraId, limit }),
    getCameraList: () => ipcRenderer.invoke('getCameraList'),
    addNewCamera: (cameraData) => ipcRenderer.invoke('add-new-camera', cameraData),
    violationAdd: (payload) => ipcRenderer.invoke('violation-add', payload),
    lineUpsert: (payload) => ipcRenderer.invoke('line-upsert', payload),
    lineList: (cameraId) => ipcRenderer.invoke('line-list', cameraId),
    getTrafficHistory: (cameraId, timeRange) => ipcRenderer.invoke('getTrafficHistory', cameraId, timeRange),
});