const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const mqtt = require("mqtt");
const PROTOCOL = require("./mqtt-bridge-protocol");

let mainWindow = null;
let mqttClient = null;
let serialBridgeProc = null;
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

// ---------------------------------------------------------------------------
// EMBEDDED ZERO-CONFIG MQTT-OVER-WEBSOCKET BROKER FALLBACK (PORT 9001)
// Automatically activates if no external Mosquitto broker is running on 9001
// so anyone who clones the repo works out-of-the-box without installing Mosquitto.
// ---------------------------------------------------------------------------
const http = require("http");
const crypto = require("crypto");

let embeddedWsBroker = null;

function encodeWsBinaryFrame(payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x82, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function startEmbeddedWsMqttBrokerFallback(port = 9001) {
  const wsClients = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("Smart Traffic Lights Embedded MQTT-over-WebSocket Broker");
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    const proto = req.headers["sec-websocket-protocol"];
    const selectedProto = proto ? proto.split(",")[0].trim() : "mqtt";

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (proto ? `Sec-WebSocket-Protocol: ${selectedProto}\r\n` : "") +
      "\r\n"
    );

    wsClients.add(socket);
    let rxBuf = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 2) {
        const opcode = rxBuf[0] & 0x0f;
        const masked = (rxBuf[1] & 0x80) !== 0;
        let payloadLen = rxBuf[1] & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (rxBuf.length < 4) return;
          payloadLen = rxBuf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (rxBuf.length < 10) return;
          payloadLen = Number(rxBuf.readBigUInt64BE(2));
          offset = 10;
        }

        const maskLen = masked ? 4 : 0;
        if (rxBuf.length < offset + maskLen + payloadLen) return;

        const maskKey = masked ? rxBuf.subarray(offset, offset + 4) : null;
        offset += maskLen;
        const payload = Buffer.from(rxBuf.subarray(offset, offset + payloadLen));
        rxBuf = rxBuf.subarray(offset + payloadLen);

        if (masked && maskKey) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i & 3];
          }
        }

        if (opcode === 0x08) {
          wsClients.delete(socket);
          socket.end();
          return;
        } else if (opcode === 0x09) {
          // Ping -> Pong
          socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        } else if ((opcode === 0x01 || opcode === 0x02) && payload.length > 0) {
          handleMqttPackets(socket, payload, wsClients);
        }
      }
    });

    socket.on("close", () => wsClients.delete(socket));
    socket.on("error", () => wsClients.delete(socket));
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[MQTT-BROKER] External broker already active on port ${port}; using existing broker.`);
    } else {
      console.warn(`[MQTT-BROKER] Embedded broker warning:`, err.message);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    embeddedWsBroker = server;
    console.log(`[MQTT-BROKER] Embedded MQTT-over-WebSocket broker listening on ws://127.0.0.1:${port}`);
  });
}

function handleMqttPackets(socket, buf, wsClients) {
  let pos = 0;
  while (pos < buf.length) {
    const fixedHeader = buf[pos];
    const packetType = fixedHeader >> 4;
    let multiplier = 1;
    let remLen = 0;
    let idx = pos + 1;

    while (idx < buf.length) {
      const encodedByte = buf[idx++];
      remLen += (encodedByte & 127) * multiplier;
      multiplier *= 128;
      if ((encodedByte & 128) === 0) break;
    }

    const packetEnd = idx + remLen;
    if (packetEnd > buf.length) break;
    const rawPacket = buf.subarray(pos, packetEnd);
    const body = buf.subarray(idx, packetEnd);
    pos = packetEnd;

    if (packetType === 1) {
      // CONNECT -> CONNACK (0x20, len=2, flags=0, rc=0)
      socket.write(encodeWsBinaryFrame(Buffer.from([0x20, 0x02, 0x00, 0x00])));
    } else if (packetType === 8 && body.length >= 2) {
      // SUBSCRIBE -> SUBACK
      const pktIdMsb = body[0];
      const pktIdLsb = body[1];
      // Count topic filters to return matching QoS 0 grants
      let p = 2;
      const grants = [];
      while (p + 2 <= body.length) {
        const tLen = body.readUInt16BE(p);
        p += 2 + tLen + 1;
        grants.push(0x00);
      }
      if (grants.length === 0) grants.push(0x00);
      const suback = Buffer.from([0x90, 2 + grants.length, pktIdMsb, pktIdLsb, ...grants]);
      socket.write(encodeWsBinaryFrame(suback));
    } else if (packetType === 10 && body.length >= 2) {
      // UNSUBSCRIBE -> UNSUBACK
      socket.write(encodeWsBinaryFrame(Buffer.from([0xb0, 0x02, body[0], body[1]])));
    } else if (packetType === 3) {
      // PUBLISH -> Broadcast to all connected WS clients (and send PUBACK if QoS 1)
      const qos = (fixedHeader >> 1) & 0x03;
      if (qos === 1 && body.length >= 4) {
        const tLen = body.readUInt16BE(0);
        if (body.length >= 2 + tLen + 2) {
          const pktIdMsb = body[2 + tLen];
          const pktIdLsb = body[2 + tLen + 1];
          socket.write(encodeWsBinaryFrame(Buffer.from([0x40, 0x02, pktIdMsb, pktIdLsb])));
        }
      }
      // Forward as QoS 0 PUBLISH to all subscribers
      let outPacket = rawPacket;
      if (qos > 0 && body.length >= 4) {
        const tLen = body.readUInt16BE(0);
        if (body.length >= 2 + tLen + 2) {
          const topicPart = body.subarray(0, 2 + tLen);
          const payloadPart = body.subarray(2 + tLen + 2);
          const newBody = Buffer.concat([topicPart, payloadPart]);
          const remBytes = [];
          let x = newBody.length;
          do {
            let b = x % 128;
            x = Math.floor(x / 128);
            if (x > 0) b |= 128;
            remBytes.push(b);
          } while (x > 0);
          outPacket = Buffer.concat([Buffer.from([0x30, ...remBytes]), newBody]);
        }
      }
      const frame = encodeWsBinaryFrame(outPacket);
      for (const client of wsClients) {
        if (!client.destroyed) {
          try {
            client.write(frame);
          } catch (_) {}
        }
      }
    } else if (packetType === 12) {
      // PINGREQ -> PINGRESP
      socket.write(encodeWsBinaryFrame(Buffer.from([0xd0, 0x00])));
    } else if (packetType === 14) {
      // DISCONNECT
      wsClients.delete(socket);
      socket.end();
    }
  }
}

function startLocalSerialWsBridgeIfAvailable() {
  const bridgeScript = path.resolve(__dirname, "..", "tools", "serial_ws_bridge.py");
  if (!fs.existsSync(bridgeScript)) return;
  try {
    serialBridgeProc = spawn("python3", [bridgeScript], {
      stdio: "ignore",
      detached: false
    });
    serialBridgeProc.on("error", () => {
      serialBridgeProc = null;
    });
    serialBridgeProc.on("exit", () => {
      serialBridgeProc = null;
    });
  } catch (_) {}
}

// Lifecycle
app.whenReady().then(() => {
  startEmbeddedWsMqttBrokerFallback(9001);
  startLocalSerialWsBridgeIfAvailable();
  setTimeout(createWindow, 120);
});

app.on("window-all-closed", () => {
  cleanupMqtt();
  if (serialBridgeProc) {
    try { serialBridgeProc.kill(); } catch (_) {}
    serialBridgeProc = null;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
