const { contextBridge, ipcRenderer } = require("electron");

/**
 * Secure Preload Bridge
 * ----------------------
 * Exposes strictly controlled IPC methods to the renderer process
 * under window.trafficApi, preserving contextIsolation: true.
 */
contextBridge.exposeInMainWorld("trafficApi", {
  // Connection Management
  connect: (brokerUrl) => ipcRenderer.invoke("mqtt:connect", brokerUrl),
  disconnect: () => ipcRenderer.invoke("mqtt:disconnect"),
  getConnectionState: () => ipcRenderer.invoke("mqtt:getConnectionState"),
  getConfig: () => ipcRenderer.invoke("mqtt:getConfig"),

  // Publishing Commands
  publish: (topic, payload) => ipcRenderer.invoke("mqtt:publish", { topic, payload }),

  // Subscribed Message Listeners
  onMessage: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("mqtt:message", subscription);
    return () => ipcRenderer.removeListener("mqtt:message", subscription);
  },

  // Connection State Changes
  onStatus: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("mqtt:status", subscription);
    return () => ipcRenderer.removeListener("mqtt:status", subscription);
  },

  // Stored Snapshots & Evidence Management (Filesystem Persistence)
  saveSnapshot: (data) => ipcRenderer.invoke("snapshots:save", data),
  listSnapshots: () => ipcRenderer.invoke("snapshots:list"),
  openSnapshotsFolder: () => ipcRenderer.invoke("snapshots:openFolder"),
  openSnapshotFile: (filePath) => ipcRenderer.invoke("snapshots:openFile", filePath),
  deleteSnapshot: (filename) => ipcRenderer.invoke("snapshots:delete", filename)
});

