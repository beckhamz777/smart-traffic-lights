const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficControlApi', {
  connectMqtt: (brokerUrl) => ipcRenderer.invoke('mqtt-connect', brokerUrl),
  disconnectMqtt: () => ipcRenderer.invoke('mqtt-disconnect'),
  publishCommand: (cmd) => ipcRenderer.invoke('mqtt-publish-command', cmd),
  getLogInfo: () => ipcRenderer.invoke('get-log-info'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  onMqttStatus: (cb) => ipcRenderer.on('mqtt-status', (_event, data) => cb(data)),
  onMqttTelemetry: (cb) => ipcRenderer.on('mqtt-telemetry', (_event, data) => cb(data)),
  onMqttLog: (cb) => ipcRenderer.on('mqtt-log', (_event, data) => cb(data))
});

