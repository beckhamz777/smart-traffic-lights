const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const mqtt = require("mqtt");
const PROTOCOL = require("./mqtt-bridge-protocol");

let mainWindow = null;
let mqttClient = null;
let currentConnectionState = "DISCONNECTED"; // DISCONNECTED | CONNECTING | CONNECTED | ERROR

// Dedicated persistent directory for red-light violation photographs
const capturesDir = path.join(__dirname, "captures");
if (!fs.existsSync(capturesDir)) {
  fs.mkdirSync(capturesDir, { recursive: true });
}

// Counters mirroring bridge telemetry stats
const bridgeCounters = {
  txTelemetry: 0,
  txLogs: 0,
  rxCmds: 0
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1200,
    minHeight: 800,
    title: "Smart Traffic Lights — T-Junction RHT Operator Desktop",
    backgroundColor: "#020617",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);

  // Grant USB Camera & Media access
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === "media" || permission === "camera" || permission === "videoCapture") {
      return true;
    }
    return true;
  });
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "camera" || permission === "videoCapture") {
      return callback(true);
    }
    callback(true);
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
    cleanupMqtt();
  });
}

function updateConnectionState(state, errorMsg = null) {
  currentConnectionState = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("mqtt:status", {
      state: currentConnectionState,
      error: errorMsg,
      counters: bridgeCounters,
      timestamp: new Date().toISOString()
    });
  }
}

function connectMqtt(brokerUrl) {
  cleanupMqtt();

  const url = brokerUrl || PROTOCOL.defaultBrokerUrl;
  updateConnectionState("CONNECTING");

  const opts = {
    clientId: `electron_rht_operator_${Math.random().toString(16).substring(2, 8)}`,
    clean: true,
    connectTimeout: 5000,
    reconnectPeriod: 3000,
    keepalive: 30
  };

  try {
    mqttClient = mqtt.connect(url, opts);

    mqttClient.on("connect", () => {
      updateConnectionState("CONNECTED");
      console.log(`[MQTT] Connected to Mosquitto broker at ${url}`);

      // Subscriptions
      const subList = [
        PROTOCOL.topics.telemetry,
        PROTOCOL.topics.logs,
        PROTOCOL.topics.violations,
        PROTOCOL.topics.health
      ];

      mqttClient.subscribe(subList, (err) => {
        if (err) {
          console.error("[MQTT] Subscription failure:", err);
          updateConnectionState("ERROR", `Failed subscribing to bridge: ${err.message}`);
        } else {
          console.log("[MQTT] Subscribed to bridge channels:", subList);
        }
      });
    });

    mqttClient.on("message", (topic, messageBuffer) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;

      const rawString = messageBuffer.toString();
      let parsedPayload = null;
      try {
        parsedPayload = JSON.parse(rawString);
      } catch (err) {
        parsedPayload = { text: rawString };
      }

      // Update counters
      if (topic === PROTOCOL.topics.telemetry) bridgeCounters.txTelemetry++;
      if (topic === PROTOCOL.topics.logs) bridgeCounters.txLogs++;

      // Dispatch to renderer
      mainWindow.webContents.send("mqtt:message", {
        topic,
        payload: parsedPayload,
        raw: rawString,
        counters: bridgeCounters,
        receivedAt: new Date().toISOString()
      });
    });

    mqttClient.on("error", (err) => {
      console.error("[MQTT] Client error:", err.message);
      updateConnectionState("ERROR", err.message || "Broker link error");
    });

    mqttClient.on("close", () => {
      if (currentConnectionState !== "CONNECTING") {
        updateConnectionState("DISCONNECTED");
      }
    });

    mqttClient.on("offline", () => {
      updateConnectionState("DISCONNECTED", "Broker offline or unreachable");
    });

  } catch (err) {
    console.error("[MQTT] Exception starting connection:", err);
    updateConnectionState("ERROR", err.message);
  }
}

function cleanupMqtt() {
  if (mqttClient) {
    try {
      mqttClient.removeAllListeners();
      mqttClient.end(true);
    } catch (_) {}
    mqttClient = null;
  }
}

// ---------------------------------------------------------------------------
// IPC HANDLERS
// ---------------------------------------------------------------------------
ipcMain.handle("mqtt:connect", async (event, brokerUrl) => {
  connectMqtt(brokerUrl);
  return { success: true };
});

ipcMain.handle("mqtt:disconnect", async () => {
  cleanupMqtt();
  updateConnectionState("DISCONNECTED");
  return { success: true };
});

ipcMain.handle("mqtt:publish", async (event, { topic, payload }) => {
  if (!mqttClient || !mqttClient.connected) {
    return { success: false, error: "Web Bridge MQTT broker is not connected" };
  }

  return new Promise((resolve) => {
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    const targetTopic = topic || PROTOCOL.topics.command;

    mqttClient.publish(targetTopic, payloadStr, { qos: 0 }, (err) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        bridgeCounters.rxCmds++;
        resolve({ success: true, counters: bridgeCounters });
      }
    });
  });
});

ipcMain.handle("mqtt:getConnectionState", async () => {
  return { state: currentConnectionState, counters: bridgeCounters };
});

ipcMain.handle("mqtt:getConfig", async () => {
  return PROTOCOL;
});

// ---------------------------------------------------------------------------
// LOCAL STORAGE & EVIDENCE FILE SYSTEM HANDLERS
// ---------------------------------------------------------------------------
ipcMain.handle("snapshots:save", async (event, { base64Data, metadata }) => {
  try {
    if (!fs.existsSync(capturesDir)) {
      fs.mkdirSync(capturesDir, { recursive: true });
    }

    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(cleanBase64, "base64");
    
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dateStamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeApproach = (metadata.approach || "APPROACH").replace(/[^a-zA-Z0-9]/g, "_");
    const safePlate = (metadata.plate_number || "VEH").replace(/[^a-zA-Z0-9]/g, "_");
    const filename = `violation_${dateStamp}_${safeApproach}_${safePlate}.jpg`;
    const filePath = path.join(capturesDir, filename);

    fs.writeFileSync(filePath, buffer);

    // Save companion JSON metadata
    const metaFilename = filename.replace(/\.jpg$/, ".json");
    const metaPath = path.join(capturesDir, metaFilename);
    const metaPayload = {
      ...metadata,
      filename,
      filePath,
      fileSize: buffer.length,
      savedAt: now.toISOString()
    };
    fs.writeFileSync(metaPath, JSON.stringify(metaPayload, null, 2));

    console.log(`[SNAPSHOTS] Stored violation image on computer: ${filePath} (${buffer.length} bytes)`);
    return {
      success: true,
      filePath,
      filename,
      fileSize: buffer.length,
      dataUrl: base64Data,
      record: metaPayload
    };
  } catch (err) {
    console.error("[SNAPSHOTS] Error saving snapshot:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("snapshots:list", async () => {
  try {
    if (!fs.existsSync(capturesDir)) return { success: true, snapshots: [], capturesDir };
    const files = fs.readdirSync(capturesDir);
    const jpgFiles = files.filter(f => f.endsWith(".jpg")).sort().reverse();

    const snapshots = jpgFiles.map(jpg => {
      const filePath = path.join(capturesDir, jpg);
      const metaPath = path.join(capturesDir, jpg.replace(/\.jpg$/, ".json"));
      let meta = {};
      if (fs.existsSync(metaPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        } catch (_) {}
      }
      const stat = fs.statSync(filePath);
      let dataUrl = null;
      try {
        const buf = fs.readFileSync(filePath);
        dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
      } catch (_) {}

      return {
        filename: jpg,
        filePath,
        dataUrl,
        fileSize: stat.size,
        createdAt: stat.birthtime.toISOString(),
        plate_number: meta.plate_number || "VIOLATION",
        approach: meta.approach || "T-Junction",
        speed_kmh: meta.speed_kmh || "--",
        sensor: meta.sensor || "RED LIGHT TRAP",
        timestamp: meta.timestamp || stat.birthtime.toLocaleTimeString()
      };
    });

    return { success: true, snapshots, capturesDir };
  } catch (err) {
    console.error("[SNAPSHOTS] Error listing snapshots:", err);
    return { success: false, error: err.message, snapshots: [], capturesDir };
  }
});

ipcMain.handle("snapshots:openFolder", async () => {
  try {
    if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir, { recursive: true });

    // Explicitly target the operating system's native desktop file manager
    if (process.platform === "linux") {
      exec(`nautilus "${capturesDir}" || xdg-open "${capturesDir}"`, (err) => {
        if (err) shell.openPath(capturesDir);
      });
    } else if (process.platform === "win32") {
      exec(`explorer.exe "${capturesDir}"`);
    } else if (process.platform === "darwin") {
      exec(`open "${capturesDir}"`);
    } else {
      await shell.openPath(capturesDir);
    }
    return { success: true, capturesDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("snapshots:openFile", async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      if (process.platform === "linux") {
        // Highlight the file in the native Linux file manager
        exec(`nautilus --select "${filePath}" || xdg-open "${filePath}"`, (err) => {
          if (err) shell.showItemInFolder(filePath);
        });
      } else {
        shell.showItemInFolder(filePath);
      }
      return { success: true };
    }
    return { success: false, error: "File not found" };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("snapshots:delete", async (event, filename) => {
  try {
    const jpgPath = path.join(capturesDir, filename);
    const jsonPath = path.join(capturesDir, filename.replace(/\.jpg$/, ".json"));
    if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath);
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Lifecycle
app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  cleanupMqtt();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
