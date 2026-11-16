const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt');

// Suppress harmless Linux hybrid-GPU VSync log messages
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('log-level', '3');

let mainWindow = null;
let mqttClient = null;
let lastStateSnapshot = null;

const TOPICS = {
  TELEMETRY: 'traffic/junction1/telemetry',
  LOGS: 'traffic/junction1/logs',
  COMMAND: 'traffic/junction1/command'
};

// Use writable userData/logs when packaged (.exe / .AppImage), or ./logs in dev
const logDir = app.isPackaged
  ? path.join(app.getPath('userData'), 'logs')
  : path.join(__dirname, 'logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const sessionStamp = new Date().toISOString().replace(/[:.]/g, '-');
const currentLogPath = path.join(logDir, `traffic_control_${sessionStamp}.log`);
const logStream = fs.createWriteStream(currentLogPath, { flags: 'a' });

function writeDiskLog(tag, message) {
  if (logStream && !logStream.destroyed) {
    const ts = new Date().toISOString();
    logStream.write(`[${ts}] [${tag}] ${message}\n`);
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send(channel, payload);
  }
}

writeDiskLog('SYSTEM', '=== Traffic Control Center Desktop App Started ===');
writeDiskLog('SYSTEM', `Platform: ${process.platform} (${process.arch})`);
writeDiskLog('SYSTEM', `Log File: ${currentLogPath}`);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    title: 'Traffic Control Center — MQTT Desktop App',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // Keep running reliably when minimized
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function disconnectMqtt() {
  if (mqttClient) {
    try {
      mqttClient.end(true);
    } catch (_) {}
    mqttClient = null;
  }
  sendToRenderer('mqtt-status', { connected: false, status: 'DISCONNECTED', detail: 'Disconnected' });
}

ipcMain.handle('mqtt-connect', async (_event, brokerUrl) => {
  disconnectMqtt();

  const targetUrl = (brokerUrl || 'mqtt://localhost:1883').trim();
  writeDiskLog('MQTT', `Connecting to broker: ${targetUrl}`);
  sendToRenderer('mqtt-status', { connected: false, status: 'CONNECTING', detail: `Connecting to ${targetUrl}...` });

  try {
    mqttClient = mqtt.connect(targetUrl, {
      clientId: `traffic-cc-desktop-${Math.random().toString(16).slice(2, 8)}`,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 5000
    });

    mqttClient.on('connect', () => {
      writeDiskLog('MQTT', `Connected to ${targetUrl}`);
      sendToRenderer('mqtt-status', { connected: true, status: 'CONNECTED', detail: targetUrl });

      mqttClient.subscribe([TOPICS.TELEMETRY, TOPICS.LOGS], (err) => {
        if (err) {
          writeDiskLog('MQTT_ERR', `Subscribe failed: ${err.message}`);
          sendToRenderer('mqtt-log', { topic: 'ERROR', text: `Subscribe failed: ${err.message}` });
        } else {
          writeDiskLog('MQTT', `Subscribed to ${TOPICS.TELEMETRY} & ${TOPICS.LOGS}`);
          sendToRenderer('mqtt-log', { topic: 'SYSTEM', text: `Subscribed to ${TOPICS.TELEMETRY} & ${TOPICS.LOGS}` });
        }
      });
    });

    mqttClient.on('reconnect', () => {
      writeDiskLog('MQTT', `Reconnecting to ${targetUrl}...`);
      sendToRenderer('mqtt-status', { connected: false, status: 'RECONNECTING', detail: `Reconnecting to ${targetUrl}...` });
    });

    mqttClient.on('message', (topic, payloadBuffer) => {
      const rawText = payloadBuffer.toString();

      if (topic === TOPICS.TELEMETRY) {
        try {
          const obj = JSON.parse(rawText);
          const stateKey = `${obj.currentFsmState}|${obj.operatingMode}|${obj.flashOrangeActive}`;
          if (stateKey !== lastStateSnapshot) {
            lastStateSnapshot = stateKey;
            writeDiskLog(
              'STATE_CHANGE',
              `FSM=${obj.currentFsmState} | Mode=${obj.operatingMode} | FlashOrange=${Boolean(obj.flashOrangeActive)} | Main=${obj.density?.main?.pct ?? 0}% Side=${obj.density?.side?.pct ?? 0}% Turn=${obj.density?.turn?.pct ?? 0}%`
            );
          } else {
            writeDiskLog(
              'TELEMETRY',
              `FSM=${obj.currentFsmState} (${obj.stateElapsedMs ?? 0}ms) | Main=${obj.density?.main?.pct ?? 0}% Side=${obj.density?.side?.pct ?? 0}% Turn=${obj.density?.turn?.pct ?? 0}%`
            );
          }
          sendToRenderer('mqtt-telemetry', obj);
        } catch (_) {
          writeDiskLog('TELEMETRY_RAW', rawText);
          sendToRenderer('mqtt-log', { topic: 'TELEMETRY', text: rawText });
        }
      } else if (topic === TOPICS.LOGS) {
        try {
          const obj = JSON.parse(rawText);
          const msg = obj.message || rawText;
          writeDiskLog('ESP32_LOG', msg);
          sendToRenderer('mqtt-log', { topic: 'ESP32 LOG', text: msg });
        } catch (_) {
          writeDiskLog('ESP32_LOG', rawText);
          sendToRenderer('mqtt-log', { topic: 'ESP32 LOG', text: rawText });
        }
      }
    });

    mqttClient.on('error', (err) => {
      writeDiskLog('MQTT_ERR', err.message);
      sendToRenderer('mqtt-status', { connected: false, status: 'ERROR', detail: err.message });
      sendToRenderer('mqtt-log', { topic: 'ERROR', text: err.message });
    });

    mqttClient.on('close', () => {
      sendToRenderer('mqtt-status', { connected: false, status: 'DISCONNECTED', detail: 'Connection closed' });
    });

    return { ok: true };
  } catch (err) {
    writeDiskLog('MQTT_ERR', err.message);
    sendToRenderer('mqtt-status', { connected: false, status: 'ERROR', detail: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mqtt-disconnect', async () => {
  writeDiskLog('MQTT', 'Disconnected by operator.');
  disconnectMqtt();
  return { ok: true };
});

ipcMain.handle('mqtt-publish-command', async (_event, cmd) => {
  const cleanCmd = (cmd || '').trim();
  if (!cleanCmd) return { ok: false, error: 'Empty command' };
  if (!mqttClient || !mqttClient.connected) {
    return { ok: false, error: 'MQTT client is not connected' };
  }

  mqttClient.publish(TOPICS.COMMAND, cleanCmd);
  writeDiskLog('TX_COMMAND', cleanCmd);
  return { ok: true };
});

ipcMain.handle('get-log-info', async () => {
  return { logDir, currentLogPath };
});

ipcMain.handle('open-logs-folder', async () => {
  const errMsg = await shell.openPath(logDir);
  return !errMsg;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  disconnectMqtt();
  writeDiskLog('SYSTEM', '=== Traffic Control Center Desktop App Closed ===');
  if (logStream && !logStream.destroyed) {
    logStream.end();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

