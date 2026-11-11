const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopControlCenter', {
  isDesktopApp: true,
  saveLogEntry: (category, tag, message) => {
    ipcRenderer.send('save-log-line', { category, tag, message });
  },
  getLogInfo: () => ipcRenderer.invoke('get-log-info'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder')
});

