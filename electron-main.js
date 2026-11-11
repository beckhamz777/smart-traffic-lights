const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Suppress harmless Linux hybrid-GPU VSync log messages on laptops
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('enable-features', 'WebSerial');

let mainWindow = null;

// Ensure logs directory exists
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create a timestamped session log file
const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
const currentLogPath = path.join(logDir, `traffic_session_${timestampStr}.log`);
const logStream = fs.createWriteStream(currentLogPath, { flags: 'a' });

function writeToLogFile(text) {
  if (logStream && !logStream.destroyed) {
    const time = new Date().toISOString();
    logStream.write(`[${time}] ${text}\n`);
  }
}

writeToLogFile('=== ESP32 Smart Traffic Control Center Session Started ===');
writeToLogFile(`Operating System: ${process.platform} (${process.arch})`);
writeToLogFile(`Log File: ${currentLogPath}`);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    title: 'Smart Traffic Control Center — ESP32',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // Critical: keeps serial polling & timers running when minimized!
      contextIsolation: true,
      nodeIntegration: false,
      enableBlinkFeatures: 'Serial'
    }
  });

  // Automatically approve and select USB Serial ports for ESP32 without browser popups
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    writeToLogFile(`Serial Port Scan: ${portList ? portList.length : 0} device(s) found.`);

    if (portList && portList.length > 0) {
      // Prioritize common ESP32 USB-UART ICs:
      // - Silicon Labs CP210x (0x10C4)
      // - WCH CH340 / CH341 (0x1A86)
      // - FTDI (0x0403)
      // - Espressif native USB-JTAG/Serial (0x303A)
      const espDevice = portList.find(d => {
        const vid = d.vendorId ? parseInt(d.vendorId, 16) : 0;
        return vid === 0x10C4 || vid === 0x1A86 || vid === 0x0403 || vid === 0x303A;
      });

      const chosenPort = espDevice || portList[0];
      writeToLogFile(`Auto-selecting USB Serial Port: ${chosenPort.portName || chosenPort.portId} (VID: ${chosenPort.vendorId || 'N/A'}, PID: ${chosenPort.productId || 'N/A'})`);
      callback(chosenPort.portId);
    } else {
      writeToLogFile('No USB Serial ports detected during scan.');
      callback('');
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'serial') return true;
    return false;
  });

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'serial') return true;
    return false;
  });

  // Load the dashboard
  const dashboardPath = path.join(__dirname, 'tools', 'demo_dashboard.html');
  mainWindow.loadFile(dashboardPath);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers
ipcMain.on('save-log-line', (event, data) => {
  if (typeof data === 'string') {
    writeToLogFile(data);
  } else if (data && typeof data === 'object') {
    const tag = data.tag || 'INFO';
    const cat = data.category || 'APP';
    const msg = data.message || JSON.stringify(data);
    writeToLogFile(`[${cat}:${tag}] ${msg}`);
  }
});

ipcMain.handle('get-log-info', () => {
  return {
    logDir,
    currentLogPath,
    isDesktopApp: true,
    platform: process.platform
  };
});

ipcMain.handle('open-log-folder', async () => {
  try {
    await shell.openPath(logDir);
    return true;
  } catch (err) {
    return false;
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  writeToLogFile('=== ESP32 Smart Traffic Control Center Session Ended ===');
  if (logStream && !logStream.destroyed) {
    logStream.end();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

