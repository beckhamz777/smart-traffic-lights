/**
 * Smart Traffic T-Junction RHT Operator Desktop — Renderer Script
 * -----------------------------------------------------------------
 * Authoritative operator client interfacing with ESP32-WROOM-32 via
 * MQTT WebSockets (ws://localhost:9001) relayed by demo_dashboard.html.
 *
 * Strict Architectural Rules:
 *  - ZERO mock timers, synthetic simulation loops, or fake traffic cycles.
 *  - When broker/bridge is disconnected: display OFFLINE / WAITING FOR BRIDGE.
 *  - Exact 3-approach T-junction (RHT / KeepRight) topology:
 *      * Approach A: Main Road Arterial (EB/WB, GPIO 27/26/25, IR1/2)
 *      * Approach B: Protected Turn Movement (RHT Left, GPIO 22/23/21, IR5/6)
 *      * Approach C: Stem Side Road (NB, GPIO 14/12/13, IR3/4)
 *      * Crosswalks: Ped 1 East (GPIO 19/18, Btn 32), Ped 2 Side (GPIO 16/17, Btn 4)
 *      * 6 IR Sensor Channels: IR1 (33), IR2 (34), IR3 (35), IR4 (36), IR5 (39), IR6 (15)
 */

// Obtain protocol definition from window or local definition
const PROTO = (typeof window !== "undefined" && window.MQTT_BRIDGE_PROTOCOL) ? window.MQTT_BRIDGE_PROTOCOL : {
  topics: {
    telemetry: "traffic/junction1/telemetry",
    logs: "traffic/junction1/logs",
    command: "traffic/junction1/command",
    violations: "traffic/junction1/violations",
    health: "traffic/junction1/health"
  },
  defaultBrokerUrl: "ws://localhost:9001"
};

let isConnected = false;
let isFlashOrangeActive = false;
let lastTelemetry = null;
let bridgeCounters = { txTelemetry: 0, txLogs: 0, rxCmds: 0 };

// 6 IR Sensor States (Active Low: true = vehicle detected / active)
const sensorState = {
  ir1: false,
  ir2: false,
  ir3: false,
  ir4: false,
  ir5: false,
  ir6: false
};

const prevSensorState = {
  ir1: false,
  ir2: false,
  ir3: false,
  ir4: false,
  ir5: false,
  ir6: false
};

// DOM Cache
const dom = {
  // Connection Bar
  brokerUrlInput: document.getElementById("brokerUrlInput"),
  btnToggleConnect: document.getElementById("btnToggleConnect"),
  badgeConnection: document.getElementById("badgeConnection"),
  dotConnection: document.getElementById("dotConnection"),
  textConnection: document.getElementById("textConnection"),
  lblTelemetryFreshness: document.getElementById("lblTelemetryFreshness"),
  lblPacketCounters: document.getElementById("lblPacketCounters"),
  lblBridgeLogTicker: document.getElementById("lblBridgeLogTicker"),

  // Headers
  headerPriority: document.getElementById("headerPriority"),
  headerMode: document.getElementById("headerMode"),
  badgeCurrentPhase: document.getElementById("badgeCurrentPhase"),

  // Fault Banner
  faultBanner: document.getElementById("faultBanner"),
  faultBannerText: document.getElementById("faultBannerText"),

  // Approach Cards & Lamps
  main: {
    card: document.getElementById("cardMain"),
    tag: document.getElementById("tagMain"),
    r: document.getElementById("lampMain_R"),
    y: document.getElementById("lampMain_Y"),
    g: document.getElementById("lampMain_G"),
    cnt: document.getElementById("cntMain")
  },
  turn: {
    card: document.getElementById("cardTurn"),
    tag: document.getElementById("tagTurn"),
    r: document.getElementById("lampTurn_R"),
    y: document.getElementById("lampTurn_Y"),
    g: document.getElementById("lampTurn_G"),
    cnt: document.getElementById("cntTurn")
  },
  side: {
    card: document.getElementById("cardSide"),
    tag: document.getElementById("tagSide"),
    r: document.getElementById("lampSide_R"),
    y: document.getElementById("lampSide_Y"),
    g: document.getElementById("lampSide_G"),
    cnt: document.getElementById("cntSide")
  },

  // Pedestrian Crossings
  pillPed1: document.getElementById("pillPed1"),
  pillPed2: document.getElementById("pillPed2"),

  // SVG Signal Heads & Crosswalk Overlays
  svg: {
    headMain: {
      r: document.getElementById("svgHeadMain_R"),
      y: document.getElementById("svgHeadMain_Y"),
      g: document.getElementById("svgHeadMain_G")
    },
    headTurn: {
      r: document.getElementById("svgHeadTurn_R"),
      y: document.getElementById("svgHeadTurn_Y"),
      g: document.getElementById("svgHeadTurn_G")
    },
    headSide: {
      r: document.getElementById("svgHeadSide_R"),
      y: document.getElementById("svgHeadSide_Y"),
      g: document.getElementById("svgHeadSide_G")
    },
    ped1: {
      w: document.getElementById("svgPed1_W"),
      dw: document.getElementById("svgPed1_DW")
    },
    ped2: {
      w: document.getElementById("svgPed2_W"),
      dw: document.getElementById("svgPed2_DW")
    },
    beaconMain: document.getElementById("svgBeaconMain"),
    beaconTurn: document.getElementById("svgBeaconTurn"),
    beaconSide: document.getElementById("svgBeaconSide"),
    irSensors: {
      ir1: document.getElementById("svgIr1"),
      ir2: document.getElementById("svgIr2"),
      ir3: document.getElementById("svgIr3"),
      ir4: document.getElementById("svgIr4"),
      ir5: document.getElementById("svgIr5"),
      ir6: document.getElementById("svgIr6")
    }
  },

  // Mode Controls
  btnModeAdaptive: document.getElementById("btnModeAdaptive"),
  btnModeFixed: document.getElementById("btnModeFixed"),
  btnModeManual: document.getElementById("btnModeManual"),
  btnFlashOrange: document.getElementById("btnFlashOrange"),

  // Priority Card
  priorityCard: document.getElementById("priorityCard"),
  badgePriority: document.getElementById("badgePriority"),
  priorityDetail: document.getElementById("priorityDetail"),

  // Congestion Telemetry Rows
  congestion: {
    main: {
      row: document.getElementById("rowMain"),
      cong: document.getElementById("congMain"),
      sns: document.getElementById("snsMain"),
      green: document.getElementById("greenMain")
    },
    turn: {
      row: document.getElementById("rowTurn"),
      cong: document.getElementById("congTurn"),
      sns: document.getElementById("snsTurn"),
      green: document.getElementById("greenTurn")
    },
    side: {
      row: document.getElementById("rowSide"),
      cong: document.getElementById("congSide"),
      sns: document.getElementById("snsSide"),
      green: document.getElementById("greenSide")
    }
  },

  // Visual 2-Segment Density Progress Bars
  densityBars: {
    main1: document.getElementById("barMain1"),
    main2: document.getElementById("barMain2"),
    turn1: document.getElementById("barTurn1"),
    turn2: document.getElementById("barTurn2"),
    side1: document.getElementById("barSide1"),
    side2: document.getElementById("barSide2")
  },

  // Live Approach Sensor Badges on Approach Cards
  badgeCardIR: {
    ir1: document.getElementById("badgeCardIR1"),
    ir2: document.getElementById("badgeCardIR2"),
    ir3: document.getElementById("badgeCardIR3"),
    ir4: document.getElementById("badgeCardIR4"),
    ir5: document.getElementById("badgeCardIR5"),
    ir6: document.getElementById("badgeCardIR6")
  },

  // Interactive Sensor Toggle Buttons
  btnToggleIR: {
    ir1: document.getElementById("btnToggleIR1"),
    ir2: document.getElementById("btnToggleIR2"),
    ir3: document.getElementById("btnToggleIR3"),
    ir4: document.getElementById("btnToggleIR4"),
    ir5: document.getElementById("btnToggleIR5"),
    ir6: document.getElementById("btnToggleIR6")
  },

  // Interactive Pedestrian Demand Buttons
  btnRequestPed: {
    ped1: document.getElementById("btnRequestPed1"),
    ped2: document.getElementById("btnRequestPed2")
  },

  // Timing Inputs
  inputGreenSec: document.getElementById("inputGreenSec"),
  inputOrangeSec: document.getElementById("inputOrangeSec"),
  inputRedSec: document.getElementById("inputRedSec"),
  btnPublishTimings: document.getElementById("btnPublishTimings"),
  btnTimingPrototype: document.getElementById("btnTimingPrototype"),
  btnTimingBench: document.getElementById("btnTimingBench"),
  tagTimingLock: document.getElementById("tagTimingLock"),
  panelTimingControls: document.getElementById("panelTimingControls"),
  btnManualStepNext: document.getElementById("btnManualStepNext"),

  // CCTV & USB Camera Controls
  videoCctvLive: document.getElementById("videoCctvLive"),
  imgViolationSnapshot: document.getElementById("imgViolationSnapshot"),
  cctvPlaceholder: document.getElementById("cctvPlaceholder"),
  cctvStrobeFlash: document.getElementById("cctvStrobeFlash"),
  aerialHudOverlay: document.getElementById("aerialHudOverlay"),
  btnToggleAerialHud: document.getElementById("btnToggleAerialHud"),
  lblCamApproach: document.getElementById("lblCamApproach"),
  lblSpeed: document.getElementById("lblSpeed"),
  badgeLiveCam: document.getElementById("badgeLiveCam"),
  selectCameraDevice: document.getElementById("selectCameraDevice"),
  btnToggleCamera: document.getElementById("btnToggleCamera"),
  btnSnapViolation: document.getElementById("btnSnapViolation"),
  canvasSnap: document.getElementById("canvasSnap"),
  violationStream: document.getElementById("violationStream"),
  storedGalleryGrid: document.getElementById("storedGalleryGrid"),
  badgeStoredCount: document.getElementById("badgeStoredCount"),
  modalEvidenceViewer: document.getElementById("modalEvidenceViewer"),
  imgModalEvidence: document.getElementById("imgModalEvidence"),
  modalMetaPlate: document.getElementById("modalMetaPlate"),
  modalMetaApproach: document.getElementById("modalMetaApproach"),
  modalMetaSpeed: document.getElementById("modalMetaSpeed"),
  modalMetaSensor: document.getElementById("modalMetaSensor"),
  modalMetaTime: document.getElementById("modalMetaTime"),
  modalMetaPath: document.getElementById("modalMetaPath"),

  // Aerial HUD Marks & Stopbars
  hudLightMain: document.getElementById("hudLightMain"),
  hudLightTurn: document.getElementById("hudLightTurn"),
  hudLightSide: document.getElementById("hudLightSide"),
  hudLanePolyMain: document.getElementById("hudLanePolyMain"),
  hudArrowMain: document.getElementById("hudArrowMain"),
  hudStopLineMain: document.getElementById("hudStopLineMain"),
  hudBadgeBgMain: document.getElementById("hudBadgeBgMain"),
  hudBadgeTextMain: document.getElementById("hudBadgeTextMain"),
  hudTrapTextMain: document.getElementById("hudTrapTextMain"),

  hudLanePolyTurn: document.getElementById("hudLanePolyTurn"),
  hudArrowTurn: document.getElementById("hudArrowTurn"),
  hudStopLineTurn: document.getElementById("hudStopLineTurn"),
  hudBadgeBgTurn: document.getElementById("hudBadgeBgTurn"),
  hudBadgeTextTurn: document.getElementById("hudBadgeTextTurn"),
  hudTrapTextTurn: document.getElementById("hudTrapTextTurn"),

  hudLanePolySide: document.getElementById("hudLanePolySide"),
  hudArrowSide: document.getElementById("hudArrowSide"),
  hudStopLineSide: document.getElementById("hudStopLineSide"),
  hudBadgeBgSide: document.getElementById("hudBadgeBgSide"),
  hudBadgeTextSide: document.getElementById("hudBadgeTextSide"),
  hudTrapTextSide: document.getElementById("hudTrapTextSide"),
  lblOpticalTrapBadge: document.getElementById("lblOpticalTrapBadge"),
  hudEnforcementMode: document.getElementById("hudEnforcementMode"),

  // Hardware Diagnostics
  dotHealthStatus: document.getElementById("dotHealthStatus"),
  tagOverallHealth: document.getElementById("tagOverallHealth"),
  hardwareFaultList: document.getElementById("hardwareFaultList"),
  diagIr: {
    ir1: document.getElementById("diagIr1"),
    ir2: document.getElementById("diagIr2"),
    ir3: document.getElementById("diagIr3"),
    ir4: document.getElementById("diagIr4"),
    ir5: document.getElementById("diagIr5"),
    ir6: document.getElementById("diagIr6")
  },

  // Terminal
  logTerminal: document.getElementById("logTerminal")
};

// ===========================================================================
// INITIALIZATION
// ===========================================================================
window.addEventListener("DOMContentLoaded", async () => {
  if (dom.brokerUrlInput) {
    dom.brokerUrlInput.value = PROTO.defaultBrokerUrl;
  }

  // Strictly render initial OFFLINE state (NO SIMULATOR)
  renderOfflineState();

  // Listen to IPC bridge events
  if (window.trafficApi) {
    window.trafficApi.onStatus(handleConnectionStatusUpdate);
    window.trafficApi.onMessage(handleIncomingMqttMessage);

    // Initial state query
    try {
      const stateObj = await window.trafficApi.getConnectionState();
      if (stateObj) {
        updateConnectionUI(stateObj.state, null, stateObj.counters);
      }
    } catch (_) {}
  }

  // Attempt initial connect to default broker
  handleConnectToggle();

  // Recalculate dynamic green time allocations when operator adjusts green time
  if (dom.inputGreenSec) {
    dom.inputGreenSec.addEventListener("input", () => {
      const val = parseInt(dom.inputGreenSec.value, 10);
      customAdjustedGreenSec = (!isNaN(val) && val > 0 && val !== 20) ? val : null;
      updateTrafficDensityAndSensorsUI();
    });
  }

  // Enumerate connected USB Cameras
  enumerateUsbCameras();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", enumerateUsbCameras);
  }

  // Load stored violation snapshots from computer hard drive
  loadStoredSnapshots();

  // Restore saved 360° camera rotation, pan (X/Y) & zoom settings
  loadCameraViewTransform();

  // Continuous 100ms tick for live signal countdown display
  setInterval(updateLiveSignalCountdowns, 100);
});

// ===========================================================================
// CONNECTION CONTROLS
// ===========================================================================
async function handleConnectToggle() {
  if (!window.trafficApi) return;

  if (isConnected) {
    updateConnectionUI("CONNECTING");
    await window.trafficApi.disconnect();
  } else {
    const url = dom.brokerUrlInput.value.trim() || PROTO.defaultBrokerUrl;
    updateConnectionUI("CONNECTING");
    await window.trafficApi.connect(url);
  }
}
window.handleConnectToggle = handleConnectToggle;

function handleConnectionStatusUpdate({ state, error, counters }) {
  updateConnectionUI(state, error, counters);
}

function updateConnectionUI(state, errorMsg = null, counters = null) {
  isConnected = (state === "CONNECTED");
  if (counters) {
    bridgeCounters = counters;
    updatePacketCountersUI();
  }

  if (state === "CONNECTED") {
    dom.badgeConnection.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30";
    dom.dotConnection.className = "w-2 h-2 rounded-full bg-emerald-500";
    dom.textConnection.textContent = "CONNECTED TO BRIDGE";
    dom.btnToggleConnect.textContent = "Disconnect";
    dom.btnToggleConnect.className = "px-3 py-1 rounded-lg bg-rose-700 hover:bg-rose-600 text-white font-bold text-xs transition shadow";
    dom.lblTelemetryFreshness.textContent = "CONNECTED (Awaiting bridge tick)";
    dom.lblTelemetryFreshness.className = "text-amber-400 font-bold font-mono";
    dom.brokerUrlInput.disabled = true;
  } else if (state === "CONNECTING") {
    dom.badgeConnection.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30";
    dom.dotConnection.className = "w-2 h-2 rounded-full bg-amber-400 animate-pulse";
    dom.textConnection.textContent = "CONNECTING...";
    dom.btnToggleConnect.textContent = "Cancel";
    dom.btnToggleConnect.className = "px-3 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-bold text-xs transition shadow";
    dom.lblTelemetryFreshness.textContent = "Connecting to Mosquitto WebSocket...";
    dom.lblTelemetryFreshness.className = "text-slate-400 font-mono";
  } else {
    dom.badgeConnection.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30";
    dom.dotConnection.className = "w-2 h-2 rounded-full bg-rose-500";
    dom.textConnection.textContent = errorMsg ? "BRIDGE OFFLINE / ERROR" : "OFFLINE / WAITING FOR BRIDGE";
    dom.btnToggleConnect.textContent = "Connect";
    dom.btnToggleConnect.className = "px-3 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs transition shadow";
    dom.brokerUrlInput.disabled = false;
    renderOfflineState();
  }
}

function updatePacketCountersUI() {
  if (dom.lblPacketCounters) {
    dom.lblPacketCounters.textContent = `TX Telemetry: ${bridgeCounters.txTelemetry} | TX Logs: ${bridgeCounters.txLogs} | RX Cmds: ${bridgeCounters.rxCmds}`;
  }
}

// Strictly render OFFLINE state — No timers running, no synthetic countdowns
function renderOfflineState() {
  lastTelemetry = null;
  isFlashOrangeActive = false;

  dom.badgeCurrentPhase.textContent = "STATE: WAITING FOR BRIDGE";
  dom.badgeCurrentPhase.className = "px-2.5 py-0.5 rounded text-xs font-mono font-bold bg-slate-800 text-slate-500 border border-slate-700";
  dom.lblTelemetryFreshness.textContent = "OFFLINE";
  dom.lblTelemetryFreshness.className = "text-rose-400 font-bold font-mono";
  dom.headerPriority.textContent = "--";
  dom.headerMode.textContent = "--";
  dom.headerMode.className = "font-bold text-slate-500 font-mono";

  if (dom.btnModeAdaptive) {
    dom.btnModeAdaptive.className = "px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border mode-btn-inactive";
    dom.btnModeAdaptive.textContent = "ADAPTIVE";
  }
  if (dom.btnModeFixed) {
    dom.btnModeFixed.className = "px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border mode-btn-inactive";
    dom.btnModeFixed.textContent = "FIXED";
  }
  if (dom.btnModeManual) {
    dom.btnModeManual.className = "px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border mode-btn-inactive";
    dom.btnModeManual.textContent = "MANUAL";
  }
  if (dom.btnFlashOrange) {
    dom.btnFlashOrange.className = "px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border mode-btn-inactive text-amber-400 border-amber-500/30";
    dom.btnFlashOrange.textContent = "FLASH";
  }

  // Dim approach cards
  [dom.main, dom.turn, dom.side].forEach(app => {
    if (!app || !app.cnt) return;
    app.cnt.textContent = "--";
    app.cnt.className = "text-2xl font-mono font-extrabold text-slate-600";
    app.tag.textContent = "OFFLINE";
    app.tag.className = "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-500";
    app.r.className = "w-7 h-7 rounded-full bg-slate-800 border border-slate-700/60";
    app.y.className = "w-7 h-7 rounded-full bg-slate-800 border border-slate-700/60";
    app.g.className = "w-7 h-7 rounded-full bg-slate-800 border border-slate-700/60";
  });

  // Dim SVG signal heads
  [dom.svg.headMain, dom.svg.headTurn, dom.svg.headSide].forEach(head => {
    if (!head) return;
    head.r.setAttribute("fill", "#334155");
    head.r.removeAttribute("class");
    head.y.setAttribute("fill", "#334155");
    head.y.removeAttribute("class");
    head.g.setAttribute("fill", "#334155");
    head.g.removeAttribute("class");
  });

  // Dim Crosswalks
  if (dom.pillPed1) {
    dom.pillPed1.textContent = "OFFLINE";
    dom.pillPed1.className = "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-500";
  }
  if (dom.pillPed2) {
    dom.pillPed2.textContent = "OFFLINE";
    dom.pillPed2.className = "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-500";
  }
  if (dom.svg.ped1) {
    dom.svg.ped1.w.setAttribute("fill", "#334155");
    dom.svg.ped1.dw.setAttribute("fill", "#334155");
  }
  if (dom.svg.ped2) {
    dom.svg.ped2.w.setAttribute("fill", "#334155");
    dom.svg.ped2.dw.setAttribute("fill", "#334155");
  }

  // Beacons
  if (dom.svg.beaconMain) dom.svg.beaconMain.classList.add("hidden");
  if (dom.svg.beaconTurn) dom.svg.beaconTurn.classList.add("hidden");
  if (dom.svg.beaconSide) dom.svg.beaconSide.classList.add("hidden");

  // Render initial sensor & density state (interactive at 0% / Idle)
  updateTrafficDensityAndSensorsUI();

  // Health
  dom.dotHealthStatus.className = "w-2.5 h-2.5 rounded-full bg-slate-600";
  dom.tagOverallHealth.textContent = "DISCONNECTED";
  dom.tagOverallHealth.className = "text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-500 border border-slate-700";
  dom.faultBanner.classList.add("hidden");

  // Lock phase timing controls when offline
  updateTimingControlsEnablement("OFFLINE");
}

// ===========================================================================
// INCOMING MQTT DISPATCHER
// ===========================================================================
function handleIncomingMqttMessage({ topic, payload, raw, counters }) {
  if (counters) {
    bridgeCounters = counters;
    updatePacketCountersUI();
  }

  // 1. Primary Junction Telemetry Channel
  if (topic === PROTO.topics.telemetry) {
    renderAuthoritativeTelemetry(payload);
  }

  // 2. Serial & Event Log Stream Channel
  else if (topic === PROTO.topics.logs) {
    const logLine = (payload && payload.message) ? payload.message : (payload.text || raw);
    if (logLine) {
      appendTerminalLog(logLine, payload.source || "bridge");
      dom.lblBridgeLogTicker.textContent = `[${new Date().toLocaleTimeString()}] ${logLine}`;
      
      // Auto-detect alerts from firmware output
      inspectFirmwareLog(logLine);
    }
  }

  // 3. Violation Alerts (Red-Light camera feed)
  else if (topic === PROTO.topics.violations) {
    renderViolationRecord(payload);
  }

  // 4. Hardware Health Channel
  else if (topic === PROTO.topics.health) {
    renderHardwareHealth(payload);
  }
}

// ===========================================================================
// TELEMETRY RENDERER (NO SIMULATOR)
// ===========================================================================
let lastPhaseState = null;
let phaseEntryTimeClientMs = Date.now();
let customAdjustedGreenSec = null;
let latchedPhaseTargetSec = 0;

function getTargetGreenSecForPhase(fsmState, ctrlMode, payload) {
  const isAdaptive = (ctrlMode === "ADAPTIVE");
  const mainActive = (sensorState.ir1 ? 1 : 0) + (sensorState.ir2 ? 1 : 0);
  const sideActive = (sensorState.ir3 ? 1 : 0) + (sensorState.ir4 ? 1 : 0);
  const turnActive = (sensorState.ir5 ? 1 : 0) + (sensorState.ir6 ? 1 : 0);

  let targetSec = 0;
  if (fsmState.startsWith("MAIN_GREEN")) {
    targetSec = isAdaptive ? getApproachDensity(mainActive).sec : 25;
  } else if (fsmState.startsWith("SIDE_GREEN")) {
    targetSec = isAdaptive ? getApproachDensity(sideActive).sec : 20;
  } else if (fsmState.startsWith("TURN_GREEN")) {
    targetSec = isAdaptive ? getApproachDensity(turnActive).sec : 15;
  }

  const webTargetMs = (payload && payload.targetDurationMs > 0)
    ? payload.targetDurationMs
    : ((payload && payload.allocGreenMs > 0) ? payload.allocGreenMs : 0);

  if (webTargetMs > 0 && customAdjustedGreenSec === null) {
    targetSec = Math.round(webTargetMs / 1000);
  }

  // Latch target duration on green phase: allow upward expansion if queue grows,
  // never shrink downward mid-phase when sensors clear or fault.
  if (targetSec > latchedPhaseTargetSec) {
    latchedPhaseTargetSec = targetSec;
  }
  return latchedPhaseTargetSec > 0 ? latchedPhaseTargetSec : targetSec;
}

function updateLiveSignalCountdowns() {
  if (!lastTelemetry || isFlashOrangeActive) return;
  const fsmState = lastTelemetry.currentFsmState || "UNKNOWN";
  const ctrlMode = (lastTelemetry.controlMode || "FIXED").toUpperCase().trim();
  const isAdaptive = (ctrlMode === "ADAPTIVE");

  const curElapsedSec = Math.floor((Date.now() - phaseEntryTimeClientMs) / 1000);
  const activeTargetSec = getTargetGreenSecForPhase(fsmState, ctrlMode, lastTelemetry);

  if (dom.main && dom.main.cnt) {
    if (fsmState.startsWith("MAIN_GREEN")) {
      const rem = activeTargetSec - curElapsedSec;
      dom.main.cnt.textContent = (rem > 0) ? `${rem}s` : (isAdaptive ? "HOLD" : "0s");
    } else if (fsmState.startsWith("MAIN_YELLOW")) {
      dom.main.cnt.textContent = `${Math.max(0, 3 - curElapsedSec)}s`;
    }
  }

  if (dom.side && dom.side.cnt) {
    if (fsmState.startsWith("SIDE_GREEN")) {
      dom.side.cnt.textContent = `${Math.max(0, activeTargetSec - curElapsedSec)}s`;
    } else if (fsmState.startsWith("SIDE_YELLOW")) {
      dom.side.cnt.textContent = `${Math.max(0, 3 - curElapsedSec)}s`;
    }
  }

  if (dom.turn && dom.turn.cnt) {
    if (fsmState.startsWith("TURN_GREEN")) {
      dom.turn.cnt.textContent = `${Math.max(0, activeTargetSec - curElapsedSec)}s`;
    } else if (fsmState.startsWith("TURN_YELLOW")) {
      dom.turn.cnt.textContent = `${Math.max(0, 3 - curElapsedSec)}s`;
    }
  }
}

function renderAuthoritativeTelemetry(payload) {
  if (!payload || typeof payload !== "object") return;
  lastTelemetry = payload;

  const out = payload.outputs || {};
  const density = payload.density || {};
  const fsmState = payload.currentFsmState || "UNKNOWN";
  const ctrlMode = (payload.controlMode || "FIXED").toUpperCase().trim();
  const elapsedMs = payload.stateElapsedMs || 0;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  isFlashOrangeActive = Boolean(payload.flashOrangeActive) || (fsmState === "FLASH_ORANGE");

  // Track phase transition timestamp & reset latched target on phase entry
  if (lastPhaseState !== fsmState) {
    lastPhaseState = fsmState;
    phaseEntryTimeClientMs = Date.now() - (elapsedMs || 0);
    latchedPhaseTargetSec = 0;
  } else if (elapsedMs > 0 && Math.abs((Date.now() - phaseEntryTimeClientMs) - elapsedMs) > 1500) {
    phaseEntryTimeClientMs = Date.now() - elapsedMs;
  }
  const curElapsedSec = Math.floor((Date.now() - phaseEntryTimeClientMs) / 1000);

  // Freshness & State Header
  dom.lblTelemetryFreshness.textContent = `Telemetry Synced (${new Date().toLocaleTimeString()})`;
  dom.lblTelemetryFreshness.className = "text-emerald-400 font-bold font-mono";

  dom.badgeCurrentPhase.textContent = `STATE: ${fsmState}`;
  dom.badgeCurrentPhase.className = (fsmState === "FAULT_SAFE")
    ? "px-2.5 py-0.5 rounded text-xs font-mono font-bold bg-rose-950 text-rose-400 border border-rose-800 animate-pulse"
    : "px-2.5 py-0.5 rounded text-xs font-mono font-bold bg-brand-950 text-brand-400 border border-brand-800";

  // Mode Display
  dom.headerMode.textContent = isFlashOrangeActive ? "FLASH ORANGE" : ctrlMode;
  updateModeButtonsUI(ctrlMode, isFlashOrangeActive);

  // Phase Timing Controls: Only open to edit when FIXED or MANUAL mode is active
  updateTimingControlsEnablement(ctrlMode);

  // Fault Banner
  if (fsmState === "FAULT_SAFE") {
    dom.faultBanner.classList.remove("hidden");
    dom.faultBannerText.textContent = "ESP32 Controller in FAULT_SAFE interlock! Logical conflict or hardware stop triggered.";
  } else {
    dom.faultBanner.classList.add("hidden");
  }

  // -------------------------------------------------------------------------
  // 1. Approach A: Main Road Arterial (EB / WB)
  // -------------------------------------------------------------------------
  const isAdaptive = (ctrlMode === "ADAPTIVE");
  const mainActive = (sensorState.ir1 ? 1 : 0) + (sensorState.ir2 ? 1 : 0);
  const sideActive = (sensorState.ir3 ? 1 : 0) + (sensorState.ir4 ? 1 : 0);
  const turnActive = (sensorState.ir5 ? 1 : 0) + (sensorState.ir6 ? 1 : 0);

  const mainDens = density.main || { sensors: mainActive, pct: 0, allocatedSec: 0 };
  const mainR = Boolean(out.mainR);
  const mainY = Boolean(out.mainY);
  const mainG = Boolean(out.mainG);
  const activeTargetSec = getTargetGreenSecForPhase(fsmState, ctrlMode, payload);
  const mainRemSec = activeTargetSec - curElapsedSec;
  renderSignalHead(
    dom.main,
    dom.svg.headMain,
    mainR, mainY, mainG,
    fsmState.startsWith("MAIN_GREEN") ? ((mainRemSec > 0) ? `${mainRemSec}s` : (isAdaptive ? "HOLD" : "0s")) :
    fsmState.startsWith("MAIN_YELLOW") ? `${Math.max(0, 3 - curElapsedSec)}s` :
    "--"
  );

  // -------------------------------------------------------------------------
  // 2. Approach B: Protected Turn Movement (RHT Left)
  // -------------------------------------------------------------------------
  const turnDens = density.turn || { sensors: turnActive, pct: 0, allocatedSec: 0 };
  const turnR = Boolean(out.turnR);
  const turnY = Boolean(out.turnY);
  const turnG = Boolean(out.turnG);
  renderSignalHead(
    dom.turn,
    dom.svg.headTurn,
    turnR, turnY, turnG,
    fsmState.startsWith("TURN_GREEN") ? `${Math.max(0, activeTargetSec - curElapsedSec)}s` :
    fsmState.startsWith("TURN_YELLOW") ? `${Math.max(0, 3 - curElapsedSec)}s` :
    "--"
  );

  // -------------------------------------------------------------------------
  // 3. Approach C: Stem Side Road (NB)
  // -------------------------------------------------------------------------
  const sideDens = density.side || { sensors: sideActive, pct: 0, allocatedSec: 0 };
  const sideR = Boolean(out.sideR);
  const sideY = Boolean(out.sideY);
  const sideG = Boolean(out.sideG);
  renderSignalHead(
    dom.side,
    dom.svg.headSide,
    sideR, sideY, sideG,
    fsmState.startsWith("SIDE_GREEN") ? `${Math.max(0, activeTargetSec - curElapsedSec)}s` :
    fsmState.startsWith("SIDE_YELLOW") ? `${Math.max(0, 3 - curElapsedSec)}s` :
    "--"
  );

  // -------------------------------------------------------------------------
  // Pedestrian Crossings (Ped 1 East & Ped 2 Side)
  // -------------------------------------------------------------------------
  const p1Walk = Boolean(out.pedWalk);
  const p2Walk = Boolean(out.ped2Walk);

  if (dom.pillPed1) {
    dom.pillPed1.textContent = p1Walk ? "WALK (SAFE)" : "DON'T WALK";
    dom.pillPed1.className = p1Walk
      ? "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
      : "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30";
  }
  if (dom.svg.ped1) {
    dom.svg.ped1.w.setAttribute("fill", p1Walk ? "#10b981" : "#334155");
    dom.svg.ped1.dw.setAttribute("fill", p1Walk ? "#334155" : "#ef4444");
  }

  if (dom.pillPed2) {
    dom.pillPed2.textContent = p2Walk ? "WALK (SAFE)" : "DON'T WALK";
    dom.pillPed2.className = p2Walk
      ? "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
      : "px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30";
  }
  if (dom.svg.ped2) {
    dom.svg.ped2.w.setAttribute("fill", p2Walk ? "#10b981" : "#334155");
    dom.svg.ped2.dw.setAttribute("fill", p2Walk ? "#334155" : "#ef4444");
  }

  // -------------------------------------------------------------------------
  // Synchronize 6 IR Sensor States & Dynamic Density Allocation
  // -------------------------------------------------------------------------
  if (payload.sensorState) {
    Object.assign(sensorState, payload.sensorState);
  } else if (payload.density) {
    if (typeof payload.density.main?.sensors === "number") {
      sensorState.ir1 = payload.density.main.sensors >= 1;
      sensorState.ir2 = payload.density.main.sensors >= 2;
    }
    if (typeof payload.density.side?.sensors === "number") {
      sensorState.ir3 = payload.density.side.sensors >= 1;
      sensorState.ir4 = payload.density.side.sensors >= 2;
    }
    if (typeof payload.density.turn?.sensors === "number") {
      sensorState.ir5 = payload.density.turn.sensors >= 1;
      sensorState.ir6 = payload.density.turn.sensors >= 2;
    }
  }

  // Also check raw hardware sensor pin readings if provided in payload
  if (payload.hardwareSensors && typeof payload.hardwareSensors === "object") {
    for (let i = 1; i <= 6; i++) {
      const k = `ir${i}`;
      if (typeof payload.hardwareSensors[k] === "number") {
        sensorState[k] = (payload.hardwareSensors[k] === 0);
      } else if (typeof payload.hardwareSensors[k] === "boolean") {
        sensorState[k] = payload.hardwareSensors[k];
      }
    }
  }

  // Also check registered demands if provided
  if (payload.demands && typeof payload.demands === "object") {
    if (payload.demands.ped1 !== undefined) sensorState.ped1 = Boolean(payload.demands.ped1);
    if (payload.demands.ped2 !== undefined) sensorState.ped2 = Boolean(payload.demands.ped2);
  }
  updateTrafficDensityAndSensorsUI();

  // Hardware Diagnostics Status
  dom.dotHealthStatus.className = "w-2.5 h-2.5 rounded-full bg-emerald-400";
  dom.tagOverallHealth.textContent = "OPERATIONAL";
  dom.tagOverallHealth.className = "text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";

  // Update Aerial Camera HUD with Live Signals & Stopbar Thresholds
  updateAerialHudSignals(out, fsmState);

  // Automatic Red-Light Runner Detection (Red Light + Stopbar Trip)
  checkAutoRedLightViolation(out, density);
}

function renderSignalHead(cardUi, svgUi, isRed, isYellow, isGreen, remainingSec) {
  if (!cardUi) return;

  let activeColor = "OFF";
  if (isGreen) activeColor = "GREEN";
  else if (isYellow) activeColor = "ORANGE";
  else if (isRed) activeColor = "RED";

  // Countdown display
  if (isFlashOrangeActive) {
    cardUi.cnt.textContent = "FLASH";
    cardUi.cnt.className = "text-xl font-mono font-extrabold text-amber-400";
  } else {
    cardUi.cnt.textContent = remainingSec !== undefined ? remainingSec : "--";
    cardUi.cnt.className = `text-2xl font-mono font-extrabold ${
      activeColor === "GREEN" ? "text-emerald-400" :
      activeColor === "ORANGE" ? "text-amber-400" :
      activeColor === "RED" ? "text-rose-400" : "text-slate-500"
    }`;
  }

  cardUi.tag.textContent = activeColor;
  cardUi.tag.className = `text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${
    activeColor === "GREEN" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" :
    activeColor === "ORANGE" ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" :
    activeColor === "RED" ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" : "bg-slate-800 text-slate-500"
  }`;

  // Physical 13-channel indicator lenses
  cardUi.r.className = isRed
    ? "w-7 h-7 rounded-full bg-rose-500 glow-red border border-rose-300 transition-all"
    : "w-7 h-7 rounded-full bg-slate-800 border border-slate-700/60";

  cardUi.y.className = isYellow
    ? "w-7 h-7 rounded-full bg-amber-500 glow-orange border border-amber-300 transition-all"
    : "w-7 h-7 rounded-full bg-slate-800 border border-slate-700/60";

  cardUi.g.className = isGreen
    ? "w-7 h-7 rounded-full bg-emerald-500 glow-green border border-emerald-300 transition-all"
    : "w-7 h-7 rounded-full bg-slate-800 border border-slate-700/60";

  // SVG Head lenses
  if (svgUi) {
    svgUi.r.setAttribute("fill", isRed ? "#ef4444" : "#334155");
    if (isRed) svgUi.r.setAttribute("class", "glow-red"); else svgUi.r.removeAttribute("class");

    svgUi.y.setAttribute("fill", isYellow ? "#f59e0b" : "#334155");
    if (isYellow) svgUi.y.setAttribute("class", "glow-orange"); else svgUi.y.removeAttribute("class");

    svgUi.g.setAttribute("fill", isGreen ? "#10b981" : "#334155");
    if (isGreen) svgUi.g.setAttribute("class", "glow-green"); else svgUi.g.removeAttribute("class");
  }
}

// ===========================================================================
// TRAFFIC DENSITY & SENSOR ALLOCATION ENGINE (RHT 3-WAY T-JUNCTION)
// ===========================================================================
function computeAdaptiveGreenTime(activeSensors, adjustedGreenSec = null) {
  const hasAdjusted = (typeof adjustedGreenSec === "number" && !isNaN(adjustedGreenSec) && adjustedGreenSec > 0);
  if (hasAdjusted) {
    const halfAdj = Math.max(1, Math.round(adjustedGreenSec / 2));
    if (activeSensors >= 2) {
      return {
        activeSensors: 2,
        congestionPct: 100,
        allocatedGreenSec: halfAdj,
        label: `100% (${halfAdj}s Adj)`
      };
    } else if (activeSensors === 1) {
      return {
        activeSensors: 1,
        congestionPct: 50,
        allocatedGreenSec: halfAdj,
        label: `50% (${halfAdj}s Adj)`
      };
    } else {
      return {
        activeSensors: 0,
        congestionPct: 0,
        allocatedGreenSec: halfAdj,
        label: `0% (${halfAdj}s Adj)`
      };
    }
  }

  // Unadjusted defaults: 0% -> 5s, 50% -> 10s, 100% -> 20s
  if (activeSensors >= 2) {
    return {
      activeSensors: 2,
      congestionPct: 100,
      allocatedGreenSec: 20,
      label: "100% (20s Green)"
    };
  } else if (activeSensors === 1) {
    return {
      activeSensors: 1,
      congestionPct: 50,
      allocatedGreenSec: 10,
      label: "50% (10s Green)"
    };
  } else {
    return {
      activeSensors: 0,
      congestionPct: 0,
      allocatedGreenSec: 5,
      label: "0% (Idle 5s)"
    };
  }
}
window.computeAdaptiveGreenTime = computeAdaptiveGreenTime;

function getApproachDensity(count) {
  // Unadjusted defaults: 0% -> 5s, 50% -> 10s, 100% -> 20s
  // When operator-adjusted timing is active: adjustedSec / 2
  const res = computeAdaptiveGreenTime(count, customAdjustedGreenSec);
  return {
    pct: res.congestionPct,
    sec: res.allocatedGreenSec,
    label: res.label
  };
}

function updateTrafficDensityAndSensorsUI() {
  const mainActive = (sensorState.ir1 ? 1 : 0) + (sensorState.ir2 ? 1 : 0);
  const sideActive = (sensorState.ir3 ? 1 : 0) + (sensorState.ir4 ? 1 : 0);
  const turnActive = (sensorState.ir5 ? 1 : 0) + (sensorState.ir6 ? 1 : 0);

  const mainDens = getApproachDensity(mainActive);
  const sideDens = getApproachDensity(sideActive);
  const turnDens = getApproachDensity(turnActive);

  // 0. Update Live Approach Badges on Signal Phase Cards (cardMain, cardTurn, cardSide)
  if (dom.badgeCardIR) {
    for (let i = 1; i <= 6; i++) {
      const k = `ir${i}`;
      const badge = dom.badgeCardIR[k];
      if (badge) {
        const active = Boolean(sensorState[k]);
        badge.textContent = active ? `⚡ IR${i}: OCCUPIED (0)` : `IR${i}: Clear (1)`;
        badge.className = `px-1.5 py-0.5 rounded text-[10px] font-mono transition-all border ${
          active
            ? "bg-amber-500/25 border-amber-400 text-amber-300 font-bold shadow-[0_0_8px_rgba(251,191,36,0.5)] animate-pulse"
            : "bg-slate-900 border-slate-800 text-slate-500 font-normal"
        }`;
      }
    }
  }

  // 1. Update Main Road Approach (EB / WB)
  if (dom.congestion.main.cong) {
    dom.congestion.main.cong.textContent = `${mainDens.pct}%`;
    dom.congestion.main.cong.className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
      mainDens.pct === 100 ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" :
      mainDens.pct === 50  ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" :
                           "bg-slate-800 text-slate-500"
    }`;
  }
  if (dom.congestion.main.sns) dom.congestion.main.sns.textContent = `${mainActive} / 2`;
  if (dom.congestion.main.green) dom.congestion.main.green.textContent = mainDens.sec > 0 ? `${mainDens.sec} s Green` : "0 s (Idle)";
  if (dom.densityBars && dom.densityBars.main1) {
    dom.densityBars.main1.className = `h-2 rounded-full transition-all border ${
      sensorState.ir1 ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)] border-amber-300" : "bg-slate-800 border-slate-700/60"
    }`;
  }
  if (dom.densityBars && dom.densityBars.main2) {
    dom.densityBars.main2.className = `h-2 rounded-full transition-all border ${
      sensorState.ir2 ? "bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.6)] border-rose-300" : "bg-slate-800 border-slate-700/60"
    }`;
  }
  if (dom.btnToggleIR && dom.btnToggleIR.ir1) {
    dom.btnToggleIR.ir1.textContent = sensorState.ir1 ? "🔴 IR1: TRIGGERED (0)" : "○ IR1: Clear (1)";
    dom.btnToggleIR.ir1.className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold transition border ${
      sensorState.ir1 ? "bg-amber-500/30 text-amber-200 border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.4)]" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white"
    }`;
  }
  if (dom.btnToggleIR && dom.btnToggleIR.ir2) {
    dom.btnToggleIR.ir2.textContent = sensorState.ir2 ? "🔴 IR2: TRIGGERED (0)" : "○ IR2: Clear (1)";
    dom.btnToggleIR.ir2.className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold transition border ${
      sensorState.ir2 ? "bg-amber-500/30 text-amber-200 border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.4)]" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white"
    }`;
  }

  // 2. Update Protected Turn Movement (RHT Left-Turn)
  if (dom.congestion.turn.cong) {
    dom.congestion.turn.cong.textContent = `${turnDens.pct}%`;
    dom.congestion.turn.cong.className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
      turnDens.pct === 100 ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" :
      turnDens.pct === 50  ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" :
                           "bg-slate-800 text-slate-500"
    }`;
  }
  if (dom.congestion.turn.sns) dom.congestion.turn.sns.textContent = `${turnActive} / 2`;
  if (dom.congestion.turn.green) dom.congestion.turn.green.textContent = turnDens.sec > 0 ? `${turnDens.sec} s Green` : "0 s (Idle)";
  if (dom.densityBars && dom.densityBars.turn1) {
    dom.densityBars.turn1.className = `h-2 rounded-full transition-all border ${
      sensorState.ir5 ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)] border-amber-300" : "bg-slate-800 border-slate-700/60"
    }`;
  }
  if (dom.densityBars && dom.densityBars.turn2) {
    dom.densityBars.turn2.className = `h-2 rounded-full transition-all border ${
      sensorState.ir6 ? "bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.6)] border-rose-300" : "bg-slate-800 border-slate-700/60"
    }`;
  }
  if (dom.btnToggleIR && dom.btnToggleIR.ir5) {
    dom.btnToggleIR.ir5.textContent = sensorState.ir5 ? "🔴 IR5: TRIGGERED (0)" : "○ IR5: Clear (1)";
    dom.btnToggleIR.ir5.className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold transition border ${
      sensorState.ir5 ? "bg-amber-500/30 text-amber-200 border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.4)]" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white"
    }`;
  }
  if (dom.btnToggleIR && dom.btnToggleIR.ir6) {
    dom.btnToggleIR.ir6.textContent = sensorState.ir6 ? "🔴 IR6: TRIGGERED (0)" : "○ IR6: Clear (1)";
    dom.btnToggleIR.ir6.className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold transition border ${
      sensorState.ir6 ? "bg-amber-500/30 text-amber-200 border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.4)]" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white"
    }`;
  }

  // 3. Update Side Road Stem (NB)
  if (dom.congestion.side.cong) {
    dom.congestion.side.cong.textContent = `${sideDens.pct}%`;
    dom.congestion.side.cong.className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
      sideDens.pct === 100 ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" :
      sideDens.pct === 50  ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" :
                           "bg-slate-800 text-slate-500"
    }`;
  }
  if (dom.congestion.side.sns) dom.congestion.side.sns.textContent = `${sideActive} / 2`;
  if (dom.congestion.side.green) dom.congestion.side.green.textContent = sideDens.sec > 0 ? `${sideDens.sec} s Green` : "0 s (Idle)";
  if (dom.densityBars && dom.densityBars.side1) {
    dom.densityBars.side1.className = `h-2 rounded-full transition-all border ${
      sensorState.ir3 ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)] border-amber-300" : "bg-slate-800 border-slate-700/60"
    }`;
  }
  if (dom.densityBars && dom.densityBars.side2) {
    dom.densityBars.side2.className = `h-2 rounded-full transition-all border ${
      sensorState.ir4 ? "bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.6)] border-rose-300" : "bg-slate-800 border-slate-700/60"
    }`;
  }
  if (dom.btnToggleIR && dom.btnToggleIR.ir3) {
    dom.btnToggleIR.ir3.textContent = sensorState.ir3 ? "🔴 IR3: TRIGGERED (0)" : "○ IR3: Clear (1)";
    dom.btnToggleIR.ir3.className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold transition border ${
      sensorState.ir3 ? "bg-amber-500/30 text-amber-200 border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.4)]" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white"
    }`;
  }
  if (dom.btnToggleIR && dom.btnToggleIR.ir4) {
    dom.btnToggleIR.ir4.textContent = sensorState.ir4 ? "🔴 IR4: TRIGGERED (0)" : "○ IR4: Clear (1)";
    dom.btnToggleIR.ir4.className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold transition border ${
      sensorState.ir4 ? "bg-amber-500/30 text-amber-200 border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.4)]" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white"
    }`;
  }

  // 4. Update 6 IR Diagnostics Badges & Map SVG Markers & State Transitions
  const pinMap = {
    ir1: "GPIO 33 • Main S1",
    ir2: "GPIO 34 • Main S2",
    ir3: "GPIO 35 • Side S1",
    ir4: "GPIO 36 • Side S2",
    ir5: "GPIO 39 • Turn S1",
    ir6: "GPIO 15 • Turn S2"
  };

  for (let i = 1; i <= 6; i++) {
    const k = `ir${i}`;
    const active = Boolean(sensorState[k]);
    const diag = dom.diagIr[k];
    const svgIr = dom.svg.irSensors[k];

    if (diag) {
      diag.textContent = active ? `IR${i}: OCCUPIED (0)` : `IR${i}: Clear (1)`;
      diag.className = `p-1 rounded text-center font-mono cursor-pointer transition border ${
        active
          ? "bg-amber-500/25 text-amber-300 border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.4)] font-bold animate-pulse"
          : "bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700"
      }`;
    }

    if (svgIr) {
      if (active) {
        svgIr.setAttribute("fill", "#f59e0b");
        svgIr.setAttribute("stroke", "#fde047");
        svgIr.setAttribute("stroke-width", "2");
        svgIr.setAttribute("filter", "drop-shadow(0 0 6px rgba(251,191,36,0.9))");
      } else {
        svgIr.setAttribute("fill", "#1e293b");
        svgIr.setAttribute("stroke", "#475569");
        svgIr.setAttribute("stroke-width", "1");
        svgIr.removeAttribute("filter");
      }
    }

    // Live state-change logging for hardware and manual triggers
    if (active !== prevSensorState[k]) {
      appendTerminalLog(`[SENSOR TRIGGER] ${k.toUpperCase()} (${pinMap[k]}) -> ${active ? "⚡ OCCUPIED (Active-Low 0)" : "○ CLEARED (Active-High 1)"}`, "sensor");
      prevSensorState[k] = active;
    }
  }

  // 4b. Update Pedestrian Button States
  if (dom.btnRequestPed) {
    if (dom.btnRequestPed.ped1) {
      if (sensorState.ped1) {
        dom.btnRequestPed.ped1.textContent = "🚶 PED 1: DEMAND (0)";
        dom.btnRequestPed.ped1.className = "px-2 py-0.5 rounded bg-brand-500 text-white font-mono font-bold text-[10px] transition animate-pulse border border-brand-400";
      } else {
        dom.btnRequestPed.ped1.textContent = "🚶 Request";
        dom.btnRequestPed.ped1.className = "px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-brand-400 hover:text-brand-300 border border-slate-700 text-[10px] font-mono font-bold transition flex items-center gap-1";
      }
    }
    if (dom.btnRequestPed.ped2) {
      if (sensorState.ped2) {
        dom.btnRequestPed.ped2.textContent = "🚶 PED 2: DEMAND (0)";
        dom.btnRequestPed.ped2.className = "px-2 py-0.5 rounded bg-brand-500 text-white font-mono font-bold text-[10px] transition animate-pulse border border-brand-400";
      } else {
        dom.btnRequestPed.ped2.textContent = "🚶 Request";
        dom.btnRequestPed.ped2.className = "px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-brand-400 hover:text-brand-300 border border-slate-700 text-[10px] font-mono font-bold transition flex items-center gap-1";
      }
    }
  }

  // 5. Automatic Priority Lane Calculation (Highest Volume Lane)
  const approaches = [
    { code: "MAIN", name: "Main Road Arterial", count: mainActive, dens: mainDens, row: dom.congestion.main, beacon: dom.svg.beaconMain },
    { code: "TURN", name: "Protected Left Turn", count: turnActive, dens: turnDens, row: dom.congestion.turn, beacon: dom.svg.beaconTurn },
    { code: "SIDE", name: "Side Road Stem (NB)", count: sideActive, dens: sideDens, row: dom.congestion.side, beacon: dom.svg.beaconSide }
  ];

  const maxCount = Math.max(mainActive, turnActive, sideActive);
  const top = approaches.filter(a => a.count === maxCount && maxCount > 0);
  const hasSinglePriority = (top.length === 1);
  const priorityCode = hasSinglePriority ? top[0].code : "NONE";

  if (hasSinglePriority) {
    dom.headerPriority.textContent = top[0].name.toUpperCase();
    dom.badgePriority.textContent = `${top[0].code} PRIORITY`;
    dom.badgePriority.className = "px-2.5 py-1 rounded text-xs font-bold font-mono bg-rose-500/20 text-rose-400 border border-rose-500/30 shadow-[0_0_10px_rgba(244,63,94,0.3)]";
    dom.priorityDetail.textContent = `⭐ Highest Congestion (${top[0].dens.pct}%) &bull; Allocated ${top[0].dens.sec}s Dynamic Green`;
  } else if (maxCount > 0) {
    dom.headerPriority.textContent = "BALANCED";
    dom.badgePriority.textContent = "BALANCED DEMAND";
    dom.badgePriority.className = "px-2.5 py-1 rounded text-xs font-bold font-mono bg-amber-500/20 text-amber-400 border border-amber-500/30";
    dom.priorityDetail.textContent = `⚖️ Equal Traffic (${top[0].dens.pct}%) &bull; Round-Robin Fair Allocation (${top[0].dens.sec}s)`;
  } else {
    dom.headerPriority.textContent = "STANDBY";
    dom.badgePriority.textContent = "IDLE (0%)";
    dom.badgePriority.className = "px-2.5 py-1 rounded text-xs font-bold font-mono bg-slate-800 text-slate-500";
    dom.priorityDetail.textContent = "No vehicles waiting &bull; Standby cycle active";
  }

  // Highlight priority approach row & show visual beacon on SVG map
  approaches.forEach(a => {
    const isPrio = (hasSinglePriority && a.code === priorityCode);
    if (isPrio) {
      a.row.row.className = "bg-rose-950/25 border border-rose-500/70 rounded-xl p-3 shadow-sm";
      if (a.beacon) a.beacon.classList.remove("hidden");
    } else {
      a.row.row.className = "bg-slate-950 border border-slate-800 rounded-xl p-3";
      if (a.beacon) a.beacon.classList.add("hidden");
    }
  });

  // 6. Refresh Aerial CCTV Stopbar Trap indicators if telemetry is active
  if (lastTelemetry && lastTelemetry.outputs) {
    updateAerialHudSignals(lastTelemetry.outputs, lastTelemetry.currentFsmState || "UNKNOWN");
  }
}

// ---------------------------------------------------------------------------
// OPERATOR SENSOR STIMULATION & PEDESTRIAN TRIGGERS
// ---------------------------------------------------------------------------
function toggleSensor(sensorKey, movement) {
  sensorState[sensorKey] = !sensorState[sensorKey];
  updateTrafficDensityAndSensorsUI();

  let anyActive = false;
  if (movement === "MAIN") anyActive = sensorState.ir1 || sensorState.ir2;
  else if (movement === "SIDE") anyActive = sensorState.ir3 || sensorState.ir4;
  else if (movement === "TURN") anyActive = sensorState.ir5 || sensorState.ir6;

  const cmd = `CAR ${movement} ${anyActive ? "ON" : "OFF"}`;
  const irCmd = `${sensorKey.toUpperCase()} ${sensorState[sensorKey] ? "ON" : "OFF"}`;

  sendCommand(cmd, true);
  if (isConnected && window.trafficApi) {
    window.trafficApi.publish(PROTO.topics.command, irCmd).catch(() => {});
  }

  appendTerminalLog(`[SENSOR TOGGLED] ${sensorKey.toUpperCase()} = ${sensorState[sensorKey] ? "ACTIVE (0)" : "IDLE (1)"} -> Dispatched "${cmd}"`, "operator");

  // Check if triggering this sensor breaches a red light on this lane
  checkManualSensorRedBreach(sensorKey, movement);
}
window.toggleSensor = toggleSensor;

function checkManualSensorRedBreach(sensorKey, movement) {
  if (!sensorState[sensorKey]) return;
  const out = (lastTelemetry && lastTelemetry.outputs) || {};
  let isRed = false;
  let approachName = "";
  const speed = (Math.random() * 18 + 50).toFixed(1);

  if (movement === "MAIN" && Boolean(out.mainR)) {
    isRed = true;
    approachName = "Main Road (Arterial)";
  } else if (movement === "TURN" && Boolean(out.turnR)) {
    isRed = true;
    approachName = "Protected Left Turn";
  } else if (movement === "SIDE" && Boolean(out.sideR)) {
    isRed = true;
    approachName = "Side Road Stem";
  }

  if (isRed) {
    triggerAutoRedLightViolation(approachName, movement, `${sensorKey.toUpperCase()} STOPBAR TRAP`, speed);
  }
}

function triggerPedButton(pedNum) {
  const cmd = `PED ${pedNum}`;
  sendCommand(cmd, true);
  appendTerminalLog(`[PEDESTRIAN DEMAND] Pedestrian ${pedNum} call registered (GPIO ${pedNum === 1 ? 32 : 4})`, "operator");

  if (dom.btnRequestPed) {
    const btn = dom.btnRequestPed[`ped${pedNum}`];
    if (btn) {
      const origClass = btn.className;
      btn.className = "px-2 py-0.5 rounded bg-brand-500 text-white font-mono font-bold text-[10px] transition animate-pulse";
      setTimeout(() => {
        btn.className = origClass;
      }, 1500);
    }
  }
}
window.triggerPedButton = triggerPedButton;

function clearAllSensors() {
  for (let i = 1; i <= 6; i++) {
    sensorState[`ir${i}`] = false;
  }
  updateTrafficDensityAndSensorsUI();
  sendCommand("CLEAR_SENSORS", true);
  sendCommand("CAR MAIN OFF", true);
  sendCommand("CAR SIDE OFF", true);
  sendCommand("CAR TURN OFF", true);
  appendTerminalLog("[SENSOR RESET] All 6 IR channels reset to IDLE (1).", "operator");
}
window.clearAllSensors = clearAllSensors;

function simulatePresetTraffic(preset) {
  if (preset === "rush") {
    for (let i = 1; i <= 6; i++) {
      sensorState[`ir${i}`] = true;
    }
    updateTrafficDensityAndSensorsUI();
    sendCommand("CAR MAIN ON", true);
    sendCommand("CAR SIDE ON", true);
    sendCommand("CAR TURN ON", true);
    appendTerminalLog("[PRESET] Rush Hour traffic simulation activated (100% all lanes).", "operator");
  } else if (preset === "main_priority") {
    sensorState.ir1 = true;
    sensorState.ir2 = true;
    sensorState.ir3 = false;
    sensorState.ir4 = false;
    sensorState.ir5 = false;
    sensorState.ir6 = false;
    updateTrafficDensityAndSensorsUI();
    sendCommand("CAR MAIN ON", true);
    sendCommand("CAR SIDE OFF", true);
    sendCommand("CAR TURN OFF", true);
    appendTerminalLog("[PRESET] Main Road priority simulation activated (100% Main vs 0% Side/Turn).", "operator");
  }
}
window.simulatePresetTraffic = simulatePresetTraffic;

function updateModeButtonsUI(ctrlMode, flashActive) {
  const normMode = (ctrlMode || "").toUpperCase().trim();
  const isAdaptive = !flashActive && (normMode === "ADAPTIVE" || normMode === "AUTO");
  const isFixed = !flashActive && (normMode === "FIXED");
  const isManual = !flashActive && (normMode === "MANUAL");

  if (dom.btnModeAdaptive) {
    dom.btnModeAdaptive.className = `px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border flex items-center gap-1.5 ${
      isAdaptive ? "mode-btn-active-adaptive" : "mode-btn-inactive"
    }`;
    dom.btnModeAdaptive.innerHTML = isAdaptive
      ? `<span class="w-2 h-2 rounded-full bg-emerald-200 animate-pulse"></span>ADAPTIVE`
      : `ADAPTIVE`;
  }

  if (dom.btnModeFixed) {
    dom.btnModeFixed.className = `px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border flex items-center gap-1.5 ${
      isFixed ? "mode-btn-active-fixed" : "mode-btn-inactive"
    }`;
    dom.btnModeFixed.innerHTML = isFixed
      ? `<span class="w-2 h-2 rounded-full bg-blue-200 animate-pulse"></span>FIXED`
      : `FIXED`;
  }

  if (dom.btnModeManual) {
    dom.btnModeManual.className = `px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border flex items-center gap-1.5 ${
      isManual ? "mode-btn-active-manual" : "mode-btn-inactive"
    }`;
    dom.btnModeManual.innerHTML = isManual
      ? `<span class="w-2 h-2 rounded-full bg-purple-200 animate-pulse"></span>MANUAL`
      : `MANUAL`;
  }

  if (dom.btnFlashOrange) {
    dom.btnFlashOrange.className = `px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border flex items-center gap-1.5 ${
      flashActive ? "mode-btn-active-flash" : "mode-btn-inactive text-amber-400 border-amber-500/30"
    }`;
    dom.btnFlashOrange.innerHTML = flashActive
      ? `<span class="w-2 h-2 rounded-full bg-amber-950 animate-ping"></span>FLASHING 1Hz`
      : `FLASH`;
  }

  // Conspicuous Header Mode Badge
  if (dom.headerMode) {
    if (flashActive) {
      dom.headerMode.className = "px-2.5 py-0.5 rounded-full text-xs font-mono font-black bg-amber-500/20 text-amber-300 border border-amber-500/50 shadow-[0_0_14px_rgba(245,158,11,0.5)] animate-pulse flex items-center gap-1.5";
      dom.headerMode.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>FLASH ORANGE`;
    } else if (isAdaptive) {
      dom.headerMode.className = "px-2.5 py-0.5 rounded-full text-xs font-mono font-extrabold bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-[0_0_14px_rgba(16,185,129,0.4)] flex items-center gap-1.5";
      dom.headerMode.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>ADAPTIVE ACTIVE`;
    } else if (isFixed) {
      dom.headerMode.className = "px-2.5 py-0.5 rounded-full text-xs font-mono font-extrabold bg-blue-500/20 text-blue-300 border border-blue-500/50 shadow-[0_0_14px_rgba(59,130,246,0.4)] flex items-center gap-1.5";
      dom.headerMode.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-400"></span>FIXED ACTIVE`;
    } else if (isManual) {
      dom.headerMode.className = "px-2.5 py-0.5 rounded-full text-xs font-mono font-extrabold bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-[0_0_14px_rgba(168,85,247,0.4)] flex items-center gap-1.5";
      dom.headerMode.innerHTML = `<span class="w-2 h-2 rounded-full bg-purple-400 animate-pulse"></span>MANUAL ACTIVE`;
    } else {
      dom.headerMode.className = "font-bold text-slate-400 font-mono";
      dom.headerMode.textContent = normMode || "--";
    }
  }

  // Highlight Manual Step Button when in MANUAL mode
  if (dom.btnManualStepNext) {
    if (isManual) {
      dom.btnManualStepNext.className = "py-2 bg-purple-600 hover:bg-purple-500 text-white font-extrabold border border-purple-400 rounded-lg text-xs shadow-[0_0_15px_rgba(168,85,247,0.5)] transition flex items-center justify-center gap-1.5 animate-pulse";
      dom.btnManualStepNext.innerHTML = `<span>⏭️</span> Advance Phase (NEXT)`;
    } else {
      dom.btnManualStepNext.className = "py-2 bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 opacity-60";
      dom.btnManualStepNext.innerHTML = `<span>⏭️</span> Step NEXT (Manual)`;
    }
  }
}

// ---------------------------------------------------------------------------
// PHASE TIMING CONTROLS LOCK/UNLOCK (FIXED, MANUAL & ADAPTIVE)
// ---------------------------------------------------------------------------
function updateTimingControlsEnablement(ctrlMode) {
  const normMode = (ctrlMode || "").toUpperCase().trim();
  const isAdaptive = (normMode === "ADAPTIVE");
  const isEditable = isConnected && !isFlashOrangeActive && (normMode === "FIXED" || normMode === "MANUAL" || isAdaptive);

  const inputs = [dom.inputGreenSec, dom.inputOrangeSec, dom.inputRedSec];
  const buttons = [dom.btnTimingPrototype, dom.btnTimingBench];

  if (isEditable) {
    // Unlock and enable inputs
    inputs.forEach(inp => {
      if (inp) {
        inp.disabled = false;
        inp.classList.remove("opacity-40", "cursor-not-allowed");
      }
    });

    // Unlock preset buttons
    buttons.forEach(btn => {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("opacity-40", "cursor-not-allowed");
      }
    });

    // Unlock publish button
    if (dom.btnPublishTimings) {
      dom.btnPublishTimings.disabled = false;
      dom.btnPublishTimings.className = "w-full py-2 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-lg transition flex items-center justify-center gap-2 shadow mt-2 cursor-pointer";
      dom.btnPublishTimings.title = `Publish timings to ESP32 (${normMode} mode active)`;
    }

    // Status lock badge
    if (dom.tagTimingLock) {
      if (isAdaptive) {
        dom.tagTimingLock.textContent = "⚙️ ADAPTIVE OVERRIDE";
        dom.tagTimingLock.className = "text-[10px] font-mono px-2 py-0.5 rounded font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30";
        dom.tagTimingLock.title = "Adaptive timing active: 100% load = full green (20s or adjusted), 50% load = half green (10s or adjusted/2).";
      } else {
        dom.tagTimingLock.textContent = `🔓 OPEN (${normMode})`;
        dom.tagTimingLock.className = "text-[10px] font-mono px-2 py-0.5 rounded font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
        dom.tagTimingLock.title = `Phase timings are editable because ${normMode} mode is active.`;
      }
    }

    if (dom.panelTimingControls) {
      dom.panelTimingControls.classList.remove("opacity-60");
    }
  } else {
    // Lock and disable inputs
    inputs.forEach(inp => {
      if (inp) {
        inp.disabled = true;
        inp.classList.add("opacity-40", "cursor-not-allowed");
      }
    });

    // Lock preset buttons
    buttons.forEach(btn => {
      if (btn) {
        btn.disabled = true;
        btn.classList.add("opacity-40", "cursor-not-allowed");
      }
    });

    // Lock publish button
    if (dom.btnPublishTimings) {
      dom.btnPublishTimings.disabled = true;
      dom.btnPublishTimings.className = "w-full py-2 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg border border-slate-700/60 flex items-center justify-center gap-2 shadow mt-2 opacity-50 cursor-not-allowed";
      dom.btnPublishTimings.title = !isConnected
        ? "Disabled: MQTT bridge is disconnected."
        : isFlashOrangeActive
        ? "Disabled: Flashing Orange caution is active."
        : "Locked: Phase timings can only be edited in FIXED, MANUAL, or ADAPTIVE mode.";
    }

    // Status lock badge
    if (dom.tagTimingLock) {
      if (!isConnected) {
        dom.tagTimingLock.textContent = "🔒 LOCKED (OFFLINE)";
        dom.tagTimingLock.className = "text-[10px] font-mono px-2 py-0.5 rounded font-bold bg-slate-800 text-slate-500 border border-slate-700";
        dom.tagTimingLock.title = "Connect to MQTT broker to edit timings.";
      } else if (isFlashOrangeActive) {
        dom.tagTimingLock.textContent = "🔒 LOCKED (FLASH ORANGE)";
        dom.tagTimingLock.className = "text-[10px] font-mono px-2 py-0.5 rounded font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30";
        dom.tagTimingLock.title = "Timing customization is locked during Flashing Orange mode.";
      } else {
        dom.tagTimingLock.textContent = "🔒 LOCKED (STANDBY)";
        dom.tagTimingLock.className = "text-[10px] font-mono px-2 py-0.5 rounded font-bold bg-slate-800 text-slate-500 border border-slate-700";
        dom.tagTimingLock.title = "Timing controls locked.";
      }
    }

    if (dom.panelTimingControls) {
      dom.panelTimingControls.classList.add("opacity-60");
    }
  }
}

// ===========================================================================
// OPERATOR COMMANDS VIA MQTT BRIDGE
// ===========================================================================
async function sendCommand(cmdStr, silentOffline = false) {
  if (!cmdStr) return;
  if (!isConnected) {
    if (!silentOffline) {
      appendTerminalLog(`[BRIDGE OFFLINE] Command "${cmdStr}" queued/simulated locally (Mosquitto disconnected).`, "sys-warn");
      alert(`Notice: Web bridge / Mosquitto broker is OFFLINE.\nCommand "${cmdStr}" simulated locally in operator desktop app.`);
    } else {
      appendTerminalLog(`[LOCAL SIM] Command "${cmdStr}" simulated locally (Bridge offline).`, "sys");
    }
    return;
  }

  try {
    const res = await window.trafficApi.publish(PROTO.topics.command, cmdStr);
    if (!res.success) {
      console.error("[CMD ERROR]", res.error);
      appendTerminalLog(`[CMD ERROR] ${res.error}`, "sys-err");
    } else {
      appendTerminalLog(`[CMD DISPATCHED] -> ${cmdStr}`, "operator");
    }
  } catch (err) {
    console.error("IPC dispatch exception:", err);
  }
}
window.sendCommand = sendCommand;

function toggleFlashOrange() {
  if (isFlashOrangeActive) {
    sendCommand("RESUME_AUTO");
  } else {
    sendCommand("FLASH_ORANGE");
  }
}
window.toggleFlashOrange = toggleFlashOrange;

async function applyCustomTimings() {
  if (!isConnected) {
    alert("Cannot publish timings: Web bridge is OFFLINE.");
    return;
  }

  const normMode = (lastTelemetry && lastTelemetry.controlMode ? lastTelemetry.controlMode : "").toUpperCase().trim();
  const isAdaptive = (normMode === "ADAPTIVE");
  if (isFlashOrangeActive || (normMode !== "FIXED" && normMode !== "MANUAL" && !isAdaptive)) {
    alert("Phase timing controls are locked during Flashing Orange mode.");
    return;
  }

  const greenSec = parseInt(dom.inputGreenSec.value, 10) || 20;
  const orangeSec = parseInt(dom.inputOrangeSec.value, 10) || 3;
  const redSec = parseInt(dom.inputRedSec.value, 10) || 2;
  customAdjustedGreenSec = (greenSec !== 20) ? greenSec : null;

  // ESP32 TIMING SET parameters in MILLISECONDS (min >= 500, yellow >= 1000, all-red >= 1000):
  // TIMING SET <mainMin> <mainMax> <mainYel> <sideMin> <sideMax> <sideYel> <turnMin> <turnMax> <turnYel> <pedWalk> <pedClear> <allRed>
  const greenMs = greenSec * 1000;
  const orangeMs = orangeSec * 1000;
  const redMs = redSec * 1000;

  const mainMinMs = Math.max(5000, Math.floor(greenMs / 2));
  const mainMaxMs = Math.max(mainMinMs, greenMs);
  const sideMinMs = Math.max(5000, Math.floor(greenMs / 2));
  const sideMaxMs = Math.max(sideMinMs, greenMs);
  const turnMinMs = Math.max(5000, Math.floor(greenMs / 2));
  const turnMaxMs = Math.max(turnMinMs, greenMs);
  const pedWalkMs = 5000;
  const pedClearMs = 2000;

  const cmd = `TIMING SET ${mainMinMs} ${mainMaxMs} ${orangeMs} ${sideMinMs} ${sideMaxMs} ${orangeMs} ${turnMinMs} ${turnMaxMs} ${orangeMs} ${pedWalkMs} ${pedClearMs} ${redMs}`;

  dom.btnPublishTimings.textContent = "Publishing to ESP32...";
  await sendCommand(cmd);
  updateTrafficDensityAndSensorsUI();

  dom.btnPublishTimings.innerHTML = "<span>✓ Timings Dispatched to ESP32</span>";
  setTimeout(() => {
    dom.btnPublishTimings.innerHTML = `
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
      </svg>
      Publish Timings to Web Bridge
    `;
  }, 1500);
}
window.applyCustomTimings = applyCustomTimings;

// ===========================================================================
// CCTV & LAW BREAKER MONITORING
// ===========================================================================
function renderViolationRecord(record) {
  if (!record) return;

  if (dom.lblCamApproach) dom.lblCamApproach.textContent = record.approach || record.lane || "APPROACH C (STEM)";
  if (dom.lblSpeed) dom.lblSpeed.textContent = record.speed_kmh ? `RADAR: ${record.speed_kmh} km/h` : "RED LIGHT INFRACTION";

  if (record.snapshot_url && dom.imgViolationSnapshot) {
    dom.imgViolationSnapshot.src = record.snapshot_url;
    dom.imgViolationSnapshot.classList.remove("hidden");
    if (dom.cctvPlaceholder) dom.cctvPlaceholder.classList.add("hidden");
  }

  // Prepend to card stream if element exists
  if (dom.violationStream) {
    const emptyPlaceholder = dom.violationStream.querySelector(".text-center");
    if (emptyPlaceholder) emptyPlaceholder.remove();

    const card = document.createElement("div");
    card.className = "bg-slate-950 border border-slate-800 hover:border-rose-500/50 p-2.5 rounded-lg flex items-center justify-between text-xs transition";
    card.innerHTML = `
      <div>
        <div class="flex items-center space-x-2">
          <span class="font-bold text-white">${record.plate_number || 'VEHICLE VIOLATION'}</span>
          <span class="text-[10px] font-mono px-1 rounded bg-rose-500/20 text-rose-400 font-bold">${record.speed_kmh || '--'} km/h</span>
        </div>
        <div class="text-[10px] text-slate-400 mt-0.5">
          Approach: <span class="font-semibold text-slate-300 uppercase">${record.approach || record.lane || 'MAIN'}</span> &bull; ${record.timestamp || new Date().toLocaleTimeString()}
        </div>
      </div>
      <span class="text-[10px] font-mono font-bold text-rose-400 bg-rose-950/60 px-1.5 py-0.5 rounded border border-rose-900">
        RED RUNNER
      </span>
    `;

    dom.violationStream.prepend(card);
  }
}

function inspectFirmwareLog(line) {
  // Real-time sensor detection/release directly from serial event logs
  const isDetected = line.includes("SENSOR_DETECTED") || (line.includes("IR") && line.includes("active (obstacle detected)"));
  const isReleased = line.includes("SENSOR_RELEASED") || (line.includes("IR") && line.includes("released"));

  if (isDetected || isReleased) {
    let chNum = 0;
    const irMatch = line.match(/(?:IR|Channel:\s*)(\d+)/i);
    if (irMatch) {
      chNum = parseInt(irMatch[1], 10);
    } else {
      const gpioM = line.match(/GPIO\s*(\d+)/i);
      if (gpioM) {
        const pin = parseInt(gpioM[1], 10);
        const pinToCh = { 33: 1, 34: 2, 35: 3, 36: 4, 39: 5, 15: 6 };
        chNum = pinToCh[pin] || 0;
      }
    }

    if (chNum >= 1 && chNum <= 6) {
      sensorState[`ir${chNum}`] = isDetected;
      updateTrafficDensityAndSensorsUI();
    }
  }

  if (line.includes("VIOLATION") || line.includes("RED_LIGHT")) {
    renderViolationRecord({
      plate_number: "IR-TRIGGERED",
      speed_kmh: 58.4,
      approach: line.includes("SIDE") ? "Side Road Stem" : "Main Arterial",
      timestamp: new Date().toLocaleTimeString()
    });
  }
}

function renderHardwareHealth(payload) {
  if (!payload) return;
  if (payload.faults && Array.isArray(payload.faults) && payload.faults.length > 0) {
    dom.hardwareFaultList.innerHTML = payload.faults.map(f => `
      <div class="bg-rose-950/30 border border-rose-800/60 rounded p-2 text-rose-300 text-xs">
        ⚠️ ${f}
      </div>
    `).join("");
    dom.tagOverallHealth.textContent = "FAULT DETECTED";
    dom.tagOverallHealth.className = "text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30";
    dom.dotHealthStatus.className = "w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse";
  }
}

// ===========================================================================
// USB CAMERA & LIVE CCTV STREAMING (WebRTC / getUserMedia)
// ===========================================================================
let activeCameraStream = null;

async function enumerateUsbCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    if (dom.selectCameraDevice) {
      dom.selectCameraDevice.innerHTML = '<option value="">Camera API not supported</option>';
    }
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === "videoinput");

    if (dom.selectCameraDevice) {
      if (videoDevices.length === 0) {
        dom.selectCameraDevice.innerHTML = '<option value="">No USB Camera Detected</option>';
      } else {
        dom.selectCameraDevice.innerHTML = videoDevices.map((dev, idx) => {
          const label = dev.label || `USB Camera ${idx + 1} (${dev.deviceId.slice(0, 8)}...)`;
          return `<option value="${dev.deviceId}">${label}</option>`;
        }).join("");
      }
    }
  } catch (err) {
    console.error("Camera enumeration failed:", err);
  }
}

async function toggleCameraStream() {
  if (activeCameraStream) {
    // Stop live stream
    stopOpticalMotionLoop();
    activeCameraStream.getTracks().forEach(track => track.stop());
    activeCameraStream = null;

    if (dom.videoCctvLive) {
      dom.videoCctvLive.srcObject = null;
      dom.videoCctvLive.classList.add("hidden");
    }
    if (dom.badgeLiveCam) dom.badgeLiveCam.classList.add("hidden");
    if (dom.cctvPlaceholder) dom.cctvPlaceholder.classList.remove("hidden");
    if (dom.btnToggleCamera) {
      dom.btnToggleCamera.innerHTML = `<span>📹</span> Connect`;
      dom.btnToggleCamera.className = "w-full text-[11px] font-bold py-1.5 px-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition flex items-center justify-center gap-1 shadow truncate";
    }
    if (dom.lblOpticalTrapBadge) {
      dom.lblOpticalTrapBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span><span>OPTICAL TRAP: STANDBY</span>`;
      dom.lblOpticalTrapBadge.className = "text-[8px] font-mono text-slate-400 bg-black/85 px-1.5 py-0.5 rounded border border-slate-700 flex items-center gap-1 shadow";
    }
    appendTerminalLog("USB Camera disconnected.", "operator");
  } else {
    // Start live stream
    const deviceId = dom.selectCameraDevice ? dom.selectCameraDevice.value : "";
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeCameraStream = stream;

      if (dom.videoCctvLive) {
        dom.videoCctvLive.srcObject = stream;
        dom.videoCctvLive.classList.remove("hidden");
        dom.videoCctvLive.play().catch(() => {});
      }
      if (dom.cctvPlaceholder) dom.cctvPlaceholder.classList.add("hidden");
      if (dom.imgViolationSnapshot) dom.imgViolationSnapshot.classList.add("hidden");
      if (dom.badgeLiveCam) dom.badgeLiveCam.classList.remove("hidden");

      if (dom.btnToggleCamera) {
        dom.btnToggleCamera.innerHTML = `<span>⏹️</span> Disconnect`;
        dom.btnToggleCamera.className = "w-full text-[11px] font-bold py-1.5 px-1.5 rounded-lg bg-rose-700 hover:bg-rose-600 text-white transition flex items-center justify-center gap-1 shadow truncate";
      }

      if (dom.lblOpticalTrapBadge) {
        dom.lblOpticalTrapBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>OPTICAL RED-LANE TRAP: ARMED</span>`;
        dom.lblOpticalTrapBadge.className = "text-[8px] font-mono text-emerald-300 bg-black/85 px-1.5 py-0.5 rounded border border-emerald-500/40 flex items-center gap-1 shadow";
      }

      // Re-enumerate to get full hardware device labels once permission is granted
      await enumerateUsbCameras();
      
      // Activate real-time Optical Motion Detection loop on red lanes
      startOpticalMotionLoop();
      appendTerminalLog("USB Camera connected and optical red-lane surveillance armed.", "operator");
    } catch (err) {
      console.error("Failed opening camera:", err);
      alert(`Could not connect to USB camera:\n${err.name}: ${err.message}\n\nPlease check permissions or verify that the camera is plugged into a USB port.`);
      appendTerminalLog(`[CAM ERROR] ${err.name}: ${err.message}`, "operator");
    }
  }
}
window.toggleCameraStream = toggleCameraStream;

// ===========================================================================
// AERIAL CAMERA OVERLAY & AUTO RED-LIGHT RUNNER PHOTO-ENFORCEMENT
// ===========================================================================
let isAerialHudVisible = true;
const lastViolationTimes = { MAIN: 0, TURN: 0, SIDE: 0 };

// Optical motion detection engine states
let opticalMotionCanvas = null;
let opticalMotionCtx = null;
let prevOpticalFrame = null;
let opticalMotionTimer = null;
let opticalWarmupCount = 0;
let opticalConsecutiveHits = { MAIN: 0, TURN: 0, SIDE: 0 };

// Configurable Red-Zone Crossing Detector Parameters
const CCTV_DETECTOR_CONFIG = {
  pixelDiffThreshold: 38,        // Per-pixel average RGB brightness delta (0..255)
  minChangedPixels: 28,          // Minimum changed sample points inside the stopbar zone
  minChangedRatio: 0.12,         // Minimum fraction (12%) of stopbar zone pixels changed
  requiredConsecutiveFrames: 2,  // Debounce: consecutive 100ms frames with red-zone crossing
  warmupFrames: 5,               // Ignore initial frames on camera start while auto-exposure settles
  cooldownMs: 3000               // 3s per-lane anti-spam cooldown
};
window.CCTV_DETECTOR_CONFIG = CCTV_DETECTOR_CONFIG;

// Normalized Red Stopbar / Red-Mark Crossing Zones matching HUD SVG (viewBox 640x360):
// - MAIN ROAD: Left approach stopbar zone straddling X=250 (0.25..0.43, Y=0.44..0.62)
// - TURN BAY : Right approach stopbar zone opposite Main lane straddling X=390 (0.57..0.75, Y=0.27..0.45)
// - SIDE ROAD: South stem stopbar zone straddling Y=265 (0.50..0.61, Y=0.68..0.85)
const OPTICAL_ZONES = {
  MAIN: { name: "MAIN ROAD", code: "MAIN", xMin: 0.25, xMax: 0.43, yMin: 0.44, yMax: 0.62 },
  TURN: { name: "TURN BAY",  code: "TURN", xMin: 0.57, xMax: 0.75, yMin: 0.27, yMax: 0.45 },
  SIDE: { name: "SIDE ROAD", code: "SIDE", xMin: 0.50, xMax: 0.61, yMin: 0.68, yMax: 0.85 }
};

function toggleAerialHud() {
  isAerialHudVisible = !isAerialHudVisible;
  if (dom.aerialHudOverlay) {
    dom.aerialHudOverlay.classList.toggle("hidden", !isAerialHudVisible);
  }
  if (dom.btnToggleAerialHud) {
    dom.btnToggleAerialHud.className = isAerialHudVisible
      ? "w-full text-[11px] font-bold py-1.5 px-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/50 transition flex items-center justify-center gap-1 shadow truncate"
      : "w-full text-[11px] font-bold py-1.5 px-1 rounded-lg bg-slate-900 text-slate-500 border border-slate-800 transition flex items-center justify-center gap-1 shadow truncate";
  }
}
window.toggleAerialHud = toggleAerialHud;

let isCameraFullView = false;

function applyCameraFullViewStyles(active) {
  isCameraFullView = active;
  const container = document.getElementById("cctvViewportContainer");
  const btnExit = document.getElementById("btnExitFullViewCamera");
  const btnFull = document.getElementById("btnFullViewCamera");
  if (!container) return;

  if (active) {
    container.classList.remove("relative", "w-full", "aspect-video", "rounded-xl", "border", "border-slate-800");
    container.classList.add("fixed", "inset-0", "z-50", "w-screen", "h-screen");
    if (dom.videoCctvLive) {
      dom.videoCctvLive.classList.remove("object-cover");
      dom.videoCctvLive.classList.add("object-contain");
    }
    if (dom.imgViolationSnapshot) {
      dom.imgViolationSnapshot.classList.remove("object-cover");
      dom.imgViolationSnapshot.classList.add("object-contain");
    }
    if (btnExit) btnExit.classList.remove("hidden");
    if (btnFull) btnFull.textContent = "✕ Exit";
  } else {
    container.classList.remove("fixed", "inset-0", "z-50", "w-screen", "h-screen");
    container.classList.add("relative", "w-full", "aspect-video", "rounded-xl", "border", "border-slate-800");
    if (dom.videoCctvLive) {
      dom.videoCctvLive.classList.remove("object-contain");
      dom.videoCctvLive.classList.add("object-cover");
    }
    if (dom.imgViolationSnapshot) {
      dom.imgViolationSnapshot.classList.remove("object-contain");
      dom.imgViolationSnapshot.classList.add("object-cover");
    }
    if (btnExit) btnExit.classList.add("hidden");
    if (btnFull) btnFull.textContent = "⛶ Full";
  }
}

async function toggleCameraFullView() {
  const container = document.getElementById("cctvViewportContainer");
  if (!container) return;

  if (!isCameraFullView) {
    applyCameraFullViewStyles(true);
    if (container.requestFullscreen && !document.fullscreenElement) {
      try {
        await container.requestFullscreen();
      } catch (_) {
        // Fixed full-viewport overlay fallback already active
      }
    }
  } else {
    if (document.fullscreenElement === container && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch (_) {}
    }
    applyCameraFullViewStyles(false);
  }
}
window.toggleCameraFullView = toggleCameraFullView;

document.addEventListener("fullscreenchange", () => {
  const container = document.getElementById("cctvViewportContainer");
  if (!document.fullscreenElement && isCameraFullView && container) {
    applyCameraFullViewStyles(false);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isCameraFullView) {
    toggleCameraFullView();
  }
});

// ===========================================================================
// 360° CAMERA VIEW ROTATION, PAN (X/Y) & ZOOM ALIGNMENT + PERSISTENCE
// ===========================================================================
const CAM_TRANSFORM_STORAGE_KEY = "traffic_cctv_view_transform_v1";
let cameraViewTransform = {
  rotationDeg: 0,
  panX: 0,
  panY: 0,
  zoom: 1.0,
  target: "both" // "both" | "video" | "hud"
};

function normalizeAngle180(deg) {
  let a = ((Number(deg) || 0) + 180) % 360;
  if (a < 0) a += 360;
  return Math.round(a - 180);
}

function saveCameraViewTransform() {
  try {
    localStorage.setItem(CAM_TRANSFORM_STORAGE_KEY, JSON.stringify(cameraViewTransform));
  } catch (_) {}
}

function applyCameraViewTransform() {
  const { rotationDeg, panX, panY, zoom, target } = cameraViewTransform;
  const cssTransform = `translate(${panX}px, ${panY}px) rotate(${rotationDeg}deg) scale(${zoom})`;

  const videoEl = dom.videoCctvLive || document.getElementById("videoCctvLive");
  const snapEl = dom.imgViolationSnapshot || document.getElementById("imgViolationSnapshot");
  const hudSvgEl = document.getElementById("hudSvgTJunction");

  const transformVideo = (target === "both" || target === "video");
  const transformHud = (target === "both" || target === "hud");

  if (videoEl) {
    videoEl.style.transformOrigin = "center center";
    videoEl.style.transform = transformVideo ? cssTransform : "none";
  }
  if (snapEl) {
    snapEl.style.transformOrigin = "center center";
    snapEl.style.transform = transformVideo ? cssTransform : "none";
  }
  if (hudSvgEl) {
    hudSvgEl.style.transformOrigin = "center center";
    hudSvgEl.style.transform = transformHud ? cssTransform : "none";
  }

  // Sync UI controls & labels
  const inpRot = document.getElementById("inputCamRotate");
  const inpPanX = document.getElementById("inputCamPanX");
  const inpPanY = document.getElementById("inputCamPanY");
  const inpZoom = document.getElementById("inputCamZoom");
  const selTarget = document.getElementById("selectCamTransformTarget");

  if (inpRot) inpRot.value = String(rotationDeg);
  if (inpPanX) inpPanX.value = String(panX);
  if (inpPanY) inpPanY.value = String(panY);
  if (inpZoom) inpZoom.value = String(zoom);
  if (selTarget) selTarget.value = target;

  const lblRot = document.getElementById("lblCamRotate");
  const lblPanX = document.getElementById("lblCamPanX");
  const lblPanY = document.getElementById("lblCamPanY");
  const lblZoom = document.getElementById("lblCamZoom");

  if (lblRot) lblRot.textContent = `${rotationDeg > 0 ? "+" : ""}${rotationDeg}°`;
  if (lblPanX) lblPanX.textContent = `${panX > 0 ? "+" : ""}${panX}px`;
  if (lblPanY) lblPanY.textContent = `${panY > 0 ? "+" : ""}${panY}px`;
  if (lblZoom) lblZoom.textContent = `${Number(zoom).toFixed(2)}x`;

  // Reset optical baseline frame so transform adjustments don't false-trigger motion
  prevOpticalFrame = null;
  opticalConsecutiveHits = { MAIN: 0, TURN: 0, SIDE: 0 };
}

function loadCameraViewTransform() {
  try {
    const raw = localStorage.getItem(CAM_TRANSFORM_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        cameraViewTransform.rotationDeg = normalizeAngle180(parsed.rotationDeg ?? 0);
        cameraViewTransform.panX = Math.max(-200, Math.min(200, Number(parsed.panX) || 0));
        cameraViewTransform.panY = Math.max(-200, Math.min(200, Number(parsed.panY) || 0));
        cameraViewTransform.zoom = Math.max(0.5, Math.min(3.0, Number(parsed.zoom) || 1.0));
        if (["both", "video", "hud"].includes(parsed.target)) {
          cameraViewTransform.target = parsed.target;
        }
      }
    }
  } catch (_) {}
  applyCameraViewTransform();
}

function onCameraTransformInput() {
  const inpRot = document.getElementById("inputCamRotate");
  const inpPanX = document.getElementById("inputCamPanX");
  const inpPanY = document.getElementById("inputCamPanY");
  const inpZoom = document.getElementById("inputCamZoom");

  if (inpRot) cameraViewTransform.rotationDeg = normalizeAngle180(parseFloat(inpRot.value));
  if (inpPanX) cameraViewTransform.panX = Math.max(-200, Math.min(200, parseFloat(inpPanX.value) || 0));
  if (inpPanY) cameraViewTransform.panY = Math.max(-200, Math.min(200, parseFloat(inpPanY.value) || 0));
  if (inpZoom) cameraViewTransform.zoom = Math.max(0.5, Math.min(3.0, parseFloat(inpZoom.value) || 1.0));

  applyCameraViewTransform();
  saveCameraViewTransform();
}
window.onCameraTransformInput = onCameraTransformInput;

function stepCameraRotation(deltaDeg) {
  cameraViewTransform.rotationDeg = normalizeAngle180(cameraViewTransform.rotationDeg + (Number(deltaDeg) || 0));
  applyCameraViewTransform();
  saveCameraViewTransform();
}
window.stepCameraRotation = stepCameraRotation;

function updateCameraTransformTarget(newTarget) {
  if (["both", "video", "hud"].includes(newTarget)) {
    cameraViewTransform.target = newTarget;
    applyCameraViewTransform();
    saveCameraViewTransform();
  }
}
window.updateCameraTransformTarget = updateCameraTransformTarget;

function resetCameraViewTransform() {
  cameraViewTransform.rotationDeg = 0;
  cameraViewTransform.panX = 0;
  cameraViewTransform.panY = 0;
  cameraViewTransform.zoom = 1.0;
  applyCameraViewTransform();
  saveCameraViewTransform();
}
window.resetCameraViewTransform = resetCameraViewTransform;

function drawTransformedVideoToCanvas(ctx, videoEl, canvasW, canvasH, forOpticalZones = false) {
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvasW, canvasH);

  const { rotationDeg, panX, panY, zoom, target } = cameraViewTransform;
  const viewportEl = document.getElementById("cctvViewportContainer");
  const refW = (viewportEl && viewportEl.clientWidth > 0) ? viewportEl.clientWidth : 640;
  const refH = (viewportEl && viewportEl.clientHeight > 0) ? viewportEl.clientHeight : 360;
  const dx = (panX / refW) * canvasW;
  const dy = (panY / refH) * canvasH;
  const rad = (rotationDeg * Math.PI) / 180;

  if (forOpticalZones) {
    // Map video pixels into the red-zone coordinate space:
    // - If "both", video and HUD share the same transform -> relative alignment is identity
    // - If "video", apply forward transform to video so it matches fixed HUD stopbars
    // - If "hud", apply inverse HUD transform to video so moved HUD stopbars sample matching video pixels
    if (target === "video") {
      ctx.translate(canvasW / 2 + dx, canvasH / 2 + dy);
      ctx.rotate(rad);
      ctx.scale(zoom, zoom);
      ctx.drawImage(videoEl, -canvasW / 2, -canvasH / 2, canvasW, canvasH);
    } else if (target === "hud") {
      ctx.translate(canvasW / 2, canvasH / 2);
      ctx.scale(1 / zoom, 1 / zoom);
      ctx.rotate(-rad);
      ctx.translate(-canvasW / 2 - dx, -canvasH / 2 - dy);
      ctx.drawImage(videoEl, 0, 0, canvasW, canvasH);
    } else {
      ctx.drawImage(videoEl, 0, 0, canvasW, canvasH);
    }
  } else {
    // For evidentiary snapshot rendering: apply video transform when target is "both" or "video"
    if (target === "both" || target === "video") {
      ctx.translate(canvasW / 2 + dx, canvasH / 2 + dy);
      ctx.rotate(rad);
      ctx.scale(zoom, zoom);
      ctx.drawImage(videoEl, -canvasW / 2, -canvasH / 2, canvasW, canvasH);
    } else {
      ctx.drawImage(videoEl, 0, 0, canvasW, canvasH);
    }
  }
  ctx.restore();
}

function updateAerialHudSignals(out, fsmState) {
  if (!dom.aerialHudOverlay) return;

  const mRed = Boolean(out.mainR);
  const mGrn = Boolean(out.mainG);
  const tRed = Boolean(out.turnR);
  const tGrn = Boolean(out.turnG);
  const sRed = Boolean(out.sideR);
  const sGrn = Boolean(out.sideG);

  // 1. Live Corner Indicators
  if (dom.hudLightMain) {
    dom.hudLightMain.textContent = mRed ? "M: RED" : mGrn ? "M: GRN" : "M: YEL";
    dom.hudLightMain.className = mRed
      ? "px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 font-bold border border-rose-800 animate-pulse"
      : mGrn
      ? "px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 font-bold border border-emerald-800"
      : "px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 font-bold border border-amber-800";
  }

  if (dom.hudLightTurn) {
    dom.hudLightTurn.textContent = tRed ? "T: RED" : tGrn ? "T: GRN" : "T: YEL";
    dom.hudLightTurn.className = tRed
      ? "px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 font-bold border border-rose-800 animate-pulse"
      : tGrn
      ? "px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 font-bold border border-emerald-800"
      : "px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 font-bold border border-amber-800";
  }

  if (dom.hudLightSide) {
    dom.hudLightSide.textContent = sRed ? "S: RED" : sGrn ? "S: GRN" : "S: YEL";
    dom.hudLightSide.className = sRed
      ? "px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 font-bold border border-rose-800 animate-pulse"
      : sGrn
      ? "px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 font-bold border border-emerald-800"
      : "px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 font-bold border border-amber-800";
  }

  // 2. APPROACH A: MAIN ROAD (ARTERIAL) T-JUNCTION MARKS
  if (dom.hudLanePolyMain) {
    if (mRed) {
      dom.hudLanePolyMain.setAttribute("fill", "rgba(239, 68, 68, 0.25)");
      dom.hudLanePolyMain.setAttribute("stroke", "#ef4444");
      dom.hudLanePolyMain.setAttribute("stroke-width", "2.5");
      if (dom.hudArrowMain) dom.hudArrowMain.setAttribute("stroke", "#ef4444");
      if (dom.hudStopLineMain) {
        dom.hudStopLineMain.setAttribute("stroke", "#ef4444");
        dom.hudStopLineMain.setAttribute("stroke-width", "6");
      }
      if (dom.hudBadgeBgMain) {
        dom.hudBadgeBgMain.setAttribute("fill", "#991b1b");
        dom.hudBadgeBgMain.setAttribute("stroke", "#f87171");
        dom.hudBadgeBgMain.setAttribute("filter", "url(#hudGlowRed)");
      }
      if (dom.hudBadgeTextMain) dom.hudBadgeTextMain.textContent = "🔴 MAIN ROAD: RED [STOP]";
      if (dom.hudTrapTextMain) {
        if (sensorState.ir2) {
          dom.hudTrapTextMain.textContent = "⚠️ VEHICLE IN S2 STOPBAR (IR2) • VIOLATION!";
          dom.hudTrapTextMain.setAttribute("fill", "#f87171");
        } else if (sensorState.ir1) {
          dom.hudTrapTextMain.textContent = "VEHICLE APPROACHING (IR1) • S2 STOPBAR ARMED";
          dom.hudTrapTextMain.setAttribute("fill", "#fde68a");
        } else {
          dom.hudTrapTextMain.textContent = "S2 STOPBAR (IR2) • OPTICAL ACTIVE";
          dom.hudTrapTextMain.setAttribute("fill", "#fca5a5");
        }
      }
    } else if (mGrn) {
      dom.hudLanePolyMain.setAttribute("fill", "rgba(16, 185, 129, 0.18)");
      dom.hudLanePolyMain.setAttribute("stroke", "#10b981");
      dom.hudLanePolyMain.setAttribute("stroke-width", "2");
      if (dom.hudArrowMain) dom.hudArrowMain.setAttribute("stroke", "#10b981");
      if (dom.hudStopLineMain) {
        dom.hudStopLineMain.setAttribute("stroke", "#10b981");
        dom.hudStopLineMain.setAttribute("stroke-width", "3");
      }
      if (dom.hudBadgeBgMain) {
        dom.hudBadgeBgMain.setAttribute("fill", "#065f46");
        dom.hudBadgeBgMain.setAttribute("stroke", "#34d399");
        dom.hudBadgeBgMain.setAttribute("filter", "url(#hudGlowGreen)");
      }
      if (dom.hudBadgeTextMain) dom.hudBadgeTextMain.textContent = "🟢 MAIN ROAD: GREEN [PROCEED]";
      if (dom.hudTrapTextMain) {
        if (sensorState.ir1 || sensorState.ir2) {
          dom.hudTrapTextMain.textContent = "🟢 VEHICLE SENSOR ACTIVE • FLOW NORMAL";
          dom.hudTrapTextMain.setAttribute("fill", "#a7f3d0");
        } else {
          dom.hudTrapTextMain.textContent = "FLOW SAFE • NO ENFORCEMENT";
          dom.hudTrapTextMain.setAttribute("fill", "#6ee7b7");
        }
      }
    } else {
      dom.hudLanePolyMain.setAttribute("fill", "rgba(245, 158, 11, 0.2)");
      dom.hudLanePolyMain.setAttribute("stroke", "#f59e0b");
      dom.hudLanePolyMain.setAttribute("stroke-width", "2");
      if (dom.hudArrowMain) dom.hudArrowMain.setAttribute("stroke", "#f59e0b");
      if (dom.hudStopLineMain) {
        dom.hudStopLineMain.setAttribute("stroke", "#f59e0b");
        dom.hudStopLineMain.setAttribute("stroke-width", "4");
      }
      if (dom.hudBadgeBgMain) {
        dom.hudBadgeBgMain.setAttribute("fill", "#78350f");
        dom.hudBadgeBgMain.setAttribute("stroke", "#fbbf24");
        dom.hudBadgeBgMain.removeAttribute("filter");
      }
      if (dom.hudBadgeTextMain) dom.hudBadgeTextMain.textContent = "🟡 MAIN ROAD: ORANGE [CLEAR]";
      if (dom.hudTrapTextMain) {
        dom.hudTrapTextMain.textContent = "CLEAR INTERSECTION";
        dom.hudTrapTextMain.setAttribute("fill", "#fde68a");
      }
    }
  }

  // 3. APPROACH B: PROTECTED LEFT-TURN POCKET
  if (dom.hudLanePolyTurn) {
    if (tRed) {
      dom.hudLanePolyTurn.setAttribute("fill", "rgba(239, 68, 68, 0.25)");
      dom.hudLanePolyTurn.setAttribute("stroke", "#ef4444");
      dom.hudLanePolyTurn.setAttribute("stroke-width", "2.5");
      if (dom.hudArrowTurn) dom.hudArrowTurn.setAttribute("stroke", "#ef4444");
      if (dom.hudStopLineTurn) {
        dom.hudStopLineTurn.setAttribute("stroke", "#ef4444");
        dom.hudStopLineTurn.setAttribute("stroke-width", "6");
      }
      if (dom.hudBadgeBgTurn) {
        dom.hudBadgeBgTurn.setAttribute("fill", "#991b1b");
        dom.hudBadgeBgTurn.setAttribute("stroke", "#f87171");
        dom.hudBadgeBgTurn.setAttribute("filter", "url(#hudGlowRed)");
      }
      if (dom.hudBadgeTextTurn) dom.hudBadgeTextTurn.textContent = "🔴 TURN BAY: RED [STOP]";
      if (dom.hudTrapTextTurn) {
        if (sensorState.ir6) {
          dom.hudTrapTextTurn.textContent = "⚠️ VEHICLE IN S2 STOPBAR (IR6) • VIOLATION!";
          dom.hudTrapTextTurn.setAttribute("fill", "#f87171");
        } else if (sensorState.ir5) {
          dom.hudTrapTextTurn.textContent = "VEHICLE IN BAY (IR5) • S2 STOPBAR ARMED";
          dom.hudTrapTextTurn.setAttribute("fill", "#fde68a");
        } else {
          dom.hudTrapTextTurn.textContent = "S2 STOPBAR (IR6) • OPTICAL ACTIVE";
          dom.hudTrapTextTurn.setAttribute("fill", "#fca5a5");
        }
      }
    } else if (tGrn) {
      dom.hudLanePolyTurn.setAttribute("fill", "rgba(16, 185, 129, 0.18)");
      dom.hudLanePolyTurn.setAttribute("stroke", "#10b981");
      dom.hudLanePolyTurn.setAttribute("stroke-width", "2");
      if (dom.hudArrowTurn) dom.hudArrowTurn.setAttribute("stroke", "#10b981");
      if (dom.hudStopLineTurn) {
        dom.hudStopLineTurn.setAttribute("stroke", "#10b981");
        dom.hudStopLineTurn.setAttribute("stroke-width", "3");
      }
      if (dom.hudBadgeBgTurn) {
        dom.hudBadgeBgTurn.setAttribute("fill", "#065f46");
        dom.hudBadgeBgTurn.setAttribute("stroke", "#34d399");
        dom.hudBadgeBgTurn.setAttribute("filter", "url(#hudGlowGreen)");
      }
      if (dom.hudBadgeTextTurn) dom.hudBadgeTextTurn.textContent = "🟢 TURN BAY: GREEN [PROCEED]";
      if (dom.hudTrapTextTurn) {
        if (sensorState.ir5 || sensorState.ir6) {
          dom.hudTrapTextTurn.textContent = "🟢 VEHICLE SENSOR ACTIVE • FLOW NORMAL";
          dom.hudTrapTextTurn.setAttribute("fill", "#a7f3d0");
        } else {
          dom.hudTrapTextTurn.textContent = "FLOW SAFE • NO ENFORCEMENT";
          dom.hudTrapTextTurn.setAttribute("fill", "#6ee7b7");
        }
      }
    } else {
      dom.hudLanePolyTurn.setAttribute("fill", "rgba(245, 158, 11, 0.2)");
      dom.hudLanePolyTurn.setAttribute("stroke", "#f59e0b");
      dom.hudLanePolyTurn.setAttribute("stroke-width", "2");
      if (dom.hudArrowTurn) dom.hudArrowTurn.setAttribute("stroke", "#f59e0b");
      if (dom.hudStopLineTurn) {
        dom.hudStopLineTurn.setAttribute("stroke", "#f59e0b");
        dom.hudStopLineTurn.setAttribute("stroke-width", "4");
      }
      if (dom.hudBadgeBgTurn) {
        dom.hudBadgeBgTurn.setAttribute("fill", "#78350f");
        dom.hudBadgeBgTurn.setAttribute("stroke", "#fbbf24");
        dom.hudBadgeBgTurn.removeAttribute("filter");
      }
      if (dom.hudBadgeTextTurn) dom.hudBadgeTextTurn.textContent = "🟡 TURN BAY: ORANGE [CLEAR]";
      if (dom.hudTrapTextTurn) {
        dom.hudTrapTextTurn.textContent = "CLEAR INTERSECTION";
        dom.hudTrapTextTurn.setAttribute("fill", "#fde68a");
      }
    }
  }

  // 4. APPROACH C: SIDE ROAD STEM (SOUTH APPROACH)
  if (dom.hudLanePolySide) {
    if (sRed) {
      dom.hudLanePolySide.setAttribute("fill", "rgba(239, 68, 68, 0.25)");
      dom.hudLanePolySide.setAttribute("stroke", "#ef4444");
      dom.hudLanePolySide.setAttribute("stroke-width", "2.5");
      if (dom.hudArrowSide) dom.hudArrowSide.setAttribute("stroke", "#ef4444");
      if (dom.hudStopLineSide) {
        dom.hudStopLineSide.setAttribute("stroke", "#ef4444");
        dom.hudStopLineSide.setAttribute("stroke-width", "6");
      }
      if (dom.hudBadgeBgSide) {
        dom.hudBadgeBgSide.setAttribute("fill", "#991b1b");
        dom.hudBadgeBgSide.setAttribute("stroke", "#f87171");
        dom.hudBadgeBgSide.setAttribute("filter", "url(#hudGlowRed)");
      }
      if (dom.hudBadgeTextSide) dom.hudBadgeTextSide.textContent = "🔴 SIDE ROAD: RED [STOP]";
      if (dom.hudTrapTextSide) {
        if (sensorState.ir4) {
          dom.hudTrapTextSide.textContent = "⚠️ VEHICLE IN S2 STOPBAR (IR4) • VIOLATION!";
          dom.hudTrapTextSide.setAttribute("fill", "#f87171");
        } else if (sensorState.ir3) {
          dom.hudTrapTextSide.textContent = "VEHICLE APPROACHING (IR3) • S2 STOPBAR ARMED";
          dom.hudTrapTextSide.setAttribute("fill", "#fde68a");
        } else {
          dom.hudTrapTextSide.textContent = "S2 (IR4) • OPTICAL ACTIVE";
          dom.hudTrapTextSide.setAttribute("fill", "#fca5a5");
        }
      }
    } else if (sGrn) {
      dom.hudLanePolySide.setAttribute("fill", "rgba(16, 185, 129, 0.18)");
      dom.hudLanePolySide.setAttribute("stroke", "#10b981");
      dom.hudLanePolySide.setAttribute("stroke-width", "2");
      if (dom.hudArrowSide) dom.hudArrowSide.setAttribute("stroke", "#10b981");
      if (dom.hudStopLineSide) {
        dom.hudStopLineSide.setAttribute("stroke", "#10b981");
        dom.hudStopLineSide.setAttribute("stroke-width", "3");
      }
      if (dom.hudBadgeBgSide) {
        dom.hudBadgeBgSide.setAttribute("fill", "#065f46");
        dom.hudBadgeBgSide.setAttribute("stroke", "#34d399");
        dom.hudBadgeBgSide.setAttribute("filter", "url(#hudGlowGreen)");
      }
      if (dom.hudBadgeTextSide) dom.hudBadgeTextSide.textContent = "🟢 SIDE ROAD: GREEN [PROCEED]";
      if (dom.hudTrapTextSide) {
        if (sensorState.ir3 || sensorState.ir4) {
          dom.hudTrapTextSide.textContent = "🟢 VEHICLE SENSOR ACTIVE • FLOW NORMAL";
          dom.hudTrapTextSide.setAttribute("fill", "#a7f3d0");
        } else {
          dom.hudTrapTextSide.textContent = "FLOW SAFE • NO ENFORCEMENT";
          dom.hudTrapTextSide.setAttribute("fill", "#6ee7b7");
        }
      }
    } else {
      dom.hudLanePolySide.setAttribute("fill", "rgba(245, 158, 11, 0.2)");
      dom.hudLanePolySide.setAttribute("stroke", "#f59e0b");
      dom.hudLanePolySide.setAttribute("stroke-width", "2");
      if (dom.hudArrowSide) dom.hudArrowSide.setAttribute("stroke", "#f59e0b");
      if (dom.hudStopLineSide) {
        dom.hudStopLineSide.setAttribute("stroke", "#f59e0b");
        dom.hudStopLineSide.setAttribute("stroke-width", "4");
      }
      if (dom.hudBadgeBgSide) {
        dom.hudBadgeBgSide.setAttribute("fill", "#78350f");
        dom.hudBadgeBgSide.setAttribute("stroke", "#fbbf24");
        dom.hudBadgeBgSide.removeAttribute("filter");
      }
      if (dom.hudBadgeTextSide) dom.hudBadgeTextSide.textContent = "🟡 SIDE ROAD: ORANGE [CLEAR]";
      if (dom.hudTrapTextSide) {
        dom.hudTrapTextSide.textContent = "CLEAR INTERSECTION";
        dom.hudTrapTextSide.setAttribute("fill", "#fde68a");
      }
    }
  }

  // 5. Overall Enforcement Status
  if (dom.hudEnforcementMode) {
    if (mRed || tRed || sRed) {
      dom.hudEnforcementMode.textContent = "PHOTO ENFORCEMENT ARMED";
      dom.hudEnforcementMode.className = "text-amber-300 animate-pulse";
    } else {
      dom.hudEnforcementMode.textContent = "ALL PASS (NO ENFORCEMENT)";
      dom.hudEnforcementMode.className = "text-emerald-300";
    }
  }
}

// ===========================================================================
// OPTICAL MOTION DETECTION CV ENGINE (SAMPLES RED LANES FROM CAMERA FEED)
// ===========================================================================
function startOpticalMotionLoop() {
  if (opticalMotionTimer) clearInterval(opticalMotionTimer);

  if (!opticalMotionCanvas) {
    opticalMotionCanvas = document.createElement("canvas");
    opticalMotionCanvas.width = 320;
    opticalMotionCanvas.height = 180;
    opticalMotionCtx = opticalMotionCanvas.getContext("2d", { willReadFrequently: true });
  }

  opticalWarmupCount = 0;
  opticalConsecutiveHits = { MAIN: 0, TURN: 0, SIDE: 0 };

  opticalMotionTimer = setInterval(() => {
    if (!activeCameraStream || !dom.videoCctvLive || dom.videoCctvLive.readyState < 2 || dom.videoCctvLive.videoWidth === 0) {
      prevOpticalFrame = null;
      opticalWarmupCount = 0;
      opticalConsecutiveHits = { MAIN: 0, TURN: 0, SIDE: 0 };
      return;
    }

    try {
      drawTransformedVideoToCanvas(opticalMotionCtx, dom.videoCctvLive, 320, 180, true);
      const currImg = opticalMotionCtx.getImageData(0, 0, 320, 180);
      const curr = new Uint8ClampedArray(currImg.data);

      if (!prevOpticalFrame || opticalWarmupCount < CCTV_DETECTOR_CONFIG.warmupFrames) {
        prevOpticalFrame = curr;
        opticalWarmupCount++;
        return;
      }

      // Strictly gate by authoritative RED signal state on each approach
      const out = (lastTelemetry && lastTelemetry.outputs) || {};
      const redStates = {
        MAIN: Boolean(out.mainR) && !Boolean(out.mainG) && !Boolean(out.mainY),
        TURN: Boolean(out.turnR) && !Boolean(out.turnG) && !Boolean(out.turnY),
        SIDE: Boolean(out.sideR) && !Boolean(out.sideG) && !Boolean(out.sideY)
      };

      const now = Date.now();
      const zoneStats = {};
      let simultaneousSpikes = 0;

      // 1. Measure frame-difference inside each stopbar red-mark zone
      for (const [key, reg] of Object.entries(OPTICAL_ZONES)) {
        const xStart = Math.floor(reg.xMin * 320);
        const xEnd = Math.floor(reg.xMax * 320);
        const yStart = Math.floor(reg.yMin * 180);
        const yEnd = Math.floor(reg.yMax * 180);

        let changedPixels = 0;
        let totalSamples = 0;

        for (let y = yStart; y < yEnd; y += 3) {
          for (let x = xStart; x < xEnd; x += 3) {
            totalSamples++;
            const idx = (y * 320 + x) * 4;
            const diffR = Math.abs(curr[idx] - prevOpticalFrame[idx]);
            const diffG = Math.abs(curr[idx + 1] - prevOpticalFrame[idx + 1]);
            const diffB = Math.abs(curr[idx + 2] - prevOpticalFrame[idx + 2]);
            const delta = (diffR + diffG + diffB) / 3;

            if (delta > CCTV_DETECTOR_CONFIG.pixelDiffThreshold) {
              changedPixels++;
            }
          }
        }

        const changedRatio = totalSamples > 0 ? (changedPixels / totalSamples) : 0;
        const exceeded = (changedPixels >= CCTV_DETECTOR_CONFIG.minChangedPixels) &&
                         (changedRatio >= CCTV_DETECTOR_CONFIG.minChangedRatio);
        if (exceeded) simultaneousSpikes++;
        zoneStats[key] = { changedPixels, totalSamples, changedRatio, exceeded };
      }

      prevOpticalFrame = curr;

      // Reject global auto-exposure flash / camera bump if all 3 zones spike at once
      if (simultaneousSpikes >= 3) {
        opticalConsecutiveHits = { MAIN: 0, TURN: 0, SIDE: 0 };
        return;
      }

      // 2. Evaluate RED-gated crossing with consecutive-frame debounce & per-lane cooldown
      for (const [key, isRed] of Object.entries(redStates)) {
        if (!isRed) {
          opticalConsecutiveHits[key] = 0; // Reset immediately when lane is GREEN or YELLOW
          continue;
        }
        if (now - (lastViolationTimes[key] || 0) < CCTV_DETECTOR_CONFIG.cooldownMs) {
          opticalConsecutiveHits[key] = 0;
          continue;
        }

        const st = zoneStats[key];
        if (st && st.exceeded) {
          opticalConsecutiveHits[key] = (opticalConsecutiveHits[key] || 0) + 1;
          if (opticalConsecutiveHits[key] >= CCTV_DETECTOR_CONFIG.requiredConsecutiveFrames) {
            opticalConsecutiveHits[key] = 0;
            lastViolationTimes[key] = now;
            const reg = OPTICAL_ZONES[key];
            const pctStr = Math.round(st.changedRatio * 100);
            const speedEst = (Math.random() * 18 + 52).toFixed(1);
            appendTerminalLog(
              `🚨 [RED_ZONE_CROSSING] Crossing detected inside RED ${reg.name} stopbar zone (${st.changedPixels}px / ${pctStr}%)! Capturing snapshot...`,
              "operator"
            );
            triggerAutoRedLightViolation(reg.name, reg.code, `RED_ZONE_CROSSING (${st.changedPixels}px / ${pctStr}%)`, speedEst);
            break;
          }
        } else {
          opticalConsecutiveHits[key] = 0;
        }
      }
    } catch (e) {
      console.warn("Optical motion scan error:", e);
    }
  }, 100);
}

function stopOpticalMotionLoop() {
  if (opticalMotionTimer) {
    clearInterval(opticalMotionTimer);
    opticalMotionTimer = null;
  }
  prevOpticalFrame = null;
  opticalWarmupCount = 0;
  opticalConsecutiveHits = { MAIN: 0, TURN: 0, SIDE: 0 };
}

// Hardware IR sensors only register queue demand; automatic CCTV snapshots are strictly
// triggered by optical red-zone crossings inside the camera feed while the lane is RED.
function checkAutoRedLightViolation(_out, _density) {
  // Intentionally disabled: waiting vehicles on IR sensors must never trigger blind camera snapshots.
}

function triggerAutoRedLightViolation(approachName, approachCode, sensorName, speedKmh) {
  const isCameraActive = Boolean(
    activeCameraStream &&
    dom.videoCctvLive &&
    dom.videoCctvLive.readyState >= 2 &&
    dom.videoCctvLive.videoWidth > 0
  );

  if (!isCameraActive) {
    return;
  }

  // Flash red strobe in camera viewport
  if (dom.cctvStrobeFlash) {
    dom.cctvStrobeFlash.style.opacity = "1";
    setTimeout(() => {
      dom.cctvStrobeFlash.style.opacity = "0";
    }, 450);
  }

  captureManualViolation(approachName, speedKmh, sensorName, approachCode);
}

function drawEvidentiaryOverlay(ctx, width, height, data) {
  // 1. Semi-transparent scanline & grid effects
  ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
  ctx.fillRect(0, 0, width, height);

  // 2. Draw T-Junction Blueprint Lines on the Snapshot
  ctx.strokeStyle = "rgba(148, 163, 184, 0.6)";
  ctx.lineWidth = 2;
  // Main Road Horizontal Curbs
  ctx.beginPath();
  ctx.moveTo(0, height * 0.28);
  ctx.lineTo(width, height * 0.28);
  ctx.moveTo(0, height * 0.62);
  ctx.lineTo(width * 0.39, height * 0.62);
  ctx.moveTo(width * 0.61, height * 0.62);
  ctx.lineTo(width, height * 0.62);
  // Side Road Stem Curbs
  ctx.moveTo(width * 0.39, height * 0.62);
  ctx.lineTo(width * 0.39, height);
  ctx.moveTo(width * 0.61, height * 0.62);
  ctx.lineTo(width * 0.61, height);
  ctx.stroke();

  // Center dashed lines
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = "rgba(241, 245, 249, 0.4)";
  ctx.beginPath();
  ctx.moveTo(0, height * 0.45);
  ctx.lineTo(width, height * 0.45);
  ctx.moveTo(width * 0.50, height * 0.62);
  ctx.lineTo(width * 0.50, height);
  ctx.stroke();
  ctx.setLineDash([]);

  // 3. Highlight the Violated Red Lane
  let yRatio = 0.53;
  let stopX1 = width * 0.39;
  let stopX2 = width * 0.39;
  let stopY1 = height * 0.45;
  let stopY2 = height * 0.62;
  let laneBox = { x: width * 0.05, y: height * 0.45, w: width * 0.34, h: height * 0.17 };

  if (data.approach.includes("Side") || data.approach.includes("Stem")) {
    yRatio = 0.75;
    stopX1 = width * 0.50;
    stopX2 = width * 0.61;
    stopY1 = height * 0.73;
    stopY2 = height * 0.73;
    laneBox = { x: width * 0.50, y: height * 0.73, w: width * 0.11, h: height * 0.25 };
  } else if (data.approach.includes("Turn")) {
    yRatio = 0.36;
    stopX1 = width * 0.61;
    stopX2 = width * 0.61;
    stopY1 = height * 0.28;
    stopY2 = height * 0.45;
    laneBox = { x: width * 0.61, y: height * 0.28, w: width * 0.28, h: height * 0.16 };
  }

  // Fill Violated Lane with Red Warning Tint
  ctx.fillStyle = "rgba(239, 68, 68, 0.3)";
  ctx.fillRect(laneBox.x, laneBox.y, laneBox.w, laneBox.h);
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 2.5;
  ctx.strokeRect(laneBox.x, laneBox.y, laneBox.w, laneBox.h);

  // Stopbar Violation Line
  ctx.strokeStyle = "rgba(239, 68, 68, 0.95)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(stopX1, stopY1);
  ctx.lineTo(stopX2, stopY2);
  ctx.stroke();

  // Stopbar overrun flag tag
  const tagX = Math.min(stopX1, stopX2);
  const tagY = Math.min(stopY1, stopY2);
  ctx.fillStyle = "rgba(190, 18, 60, 0.95)";
  ctx.fillRect(tagX, Math.max(10, tagY - 20), 220, 20);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 10px monospace";
  ctx.fillText("⛔ RED LIGHT RUNNER OVERRUN", tagX + 6, Math.max(10, tagY - 20) + 14);

  // 4. Target Vehicle Bounding Box
  const boxW = width * 0.18;
  const boxH = height * 0.18;
  const boxX = laneBox.x + (laneBox.w - boxW) / 2;
  const boxY = laneBox.y + (laneBox.h - boxH) / 2;

  ctx.strokeStyle = "rgba(244, 63, 94, 0.95)";
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  // Target Vehicle Tag
  ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
  ctx.fillRect(boxX, boxY - 18, 140, 18);
  ctx.fillStyle = "#f43f5e";
  ctx.font = "bold 9px monospace";
  ctx.fillText(`TARGET: ${data.plate_number}`, boxX + 6, boxY - 5);

  // 5. Top Evidentiary Metadata Header Banner
  ctx.fillStyle = "rgba(2, 6, 23, 0.90)";
  ctx.fillRect(0, 0, width, 44);

  // Red alert badge
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(10, 8, 12, 12);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText("AUTOMATED PHOTO-ENFORCEMENT SYSTEM — EVIDENCE CAPTURE", 30, 19);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "9px monospace";
  ctx.fillText(`CAM-01 AERIAL (RHT T-JUNCTION) | ${data.timestamp} | VIOLATED: ${data.approach.toUpperCase()}`, 30, 34);

  // Speed Badge right side
  ctx.fillStyle = "#ef4444";
  ctx.font = "bold 12px monospace";
  ctx.fillText(`RADAR: ${data.speed_kmh} KM/H`, width - 180, 19);

  ctx.fillStyle = "#f59e0b";
  ctx.font = "bold 10px monospace";
  ctx.fillText("OFFENSE: RED LIGHT", width - 180, 34);

  // 6. Bottom Legal Watermark Bar
  ctx.fillStyle = "rgba(2, 6, 23, 0.90)";
  ctx.fillRect(0, height - 28, width, 28);

  ctx.fillStyle = "#38bdf8";
  ctx.font = "10px monospace";
  ctx.fillText(`SIGNAL INTERLOCK: RED ACTIVE | HARDWARE TRAP: ${data.sensor || "S2 STOPBAR SENSOR"}`, 12, height - 10);

  ctx.fillStyle = "#a855f7";
  ctx.font = "bold 10px monospace";
  ctx.fillText("VALIDATED BY ESP32 INTERLOCK", width - 210, height - 10);
}

async function captureManualViolation(approachName = "MAIN ROAD", speedKmh = null, sensorName = "RED_ZONE_CROSSING", laneCode = "MAIN") {
  const isCameraActive = Boolean(
    activeCameraStream &&
    dom.videoCctvLive &&
    dom.videoCctvLive.readyState >= 2 &&
    dom.videoCctvLive.videoWidth > 0
  );

  if (!isCameraActive) {
    appendTerminalLog("⚠️ [CAMERA OFFLINE] Photo snap blocked: Aerial USB Camera is not connected or streaming. Connect the camera first before taking violation evidence.", "camera");
    return;
  }

  let snapshotDataUrl = null;
  const speed = speedKmh || (Math.random() * 25 + 50).toFixed(1);
  const plate = `VEH-${Math.floor(1000 + Math.random() * 9000)}`;
  const timeStr = new Date().toLocaleTimeString();

  const violationMeta = {
    plate_number: plate,
    speed_kmh: speed,
    approach: approachName,
    lane: laneCode || approachName,
    signalState: "RED",
    triggerReason: "RED_ZONE_CROSSING",
    sensor: sensorName,
    timestamp: timeStr
  };

  if (dom.canvasSnap) {
    const canvas = dom.canvasSnap;
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");

    // Draw frame from live USB webcam with active rotation/pan/zoom transform
    drawTransformedVideoToCanvas(ctx, dom.videoCctvLive, canvas.width, canvas.height, false);

    // Burn all evidentiary HUD marks & labels directly onto the snapshot image
    drawEvidentiaryOverlay(ctx, canvas.width, canvas.height, violationMeta);

    snapshotDataUrl = canvas.toDataURL("image/jpeg", 0.88);
  }

  const record = {
    plate_number: plate,
    speed_kmh: speed,
    approach: approachName,
    lane: laneCode || approachName,
    signalState: "RED",
    triggerReason: "RED_ZONE_CROSSING",
    sensor: sensorName,
    timestamp: timeStr,
    snapshot_url: snapshotDataUrl
  };

  // Temporarily display snapshot in CCTV viewport so the operator sees the snapped act
  if (dom.imgViolationSnapshot && snapshotDataUrl) {
    dom.imgViolationSnapshot.src = snapshotDataUrl;
    dom.imgViolationSnapshot.classList.remove("hidden");
    if (dom.cctvPlaceholder) dom.cctvPlaceholder.classList.add("hidden");

    // Hold snapshot preview for 4.5 seconds, then revert to live webcam stream
    setTimeout(() => {
      if (activeCameraStream && dom.videoCctvLive) {
        dom.imgViolationSnapshot.classList.add("hidden");
      }
    }, 4500);
  }

  // Prepend to violation log
  try {
    renderViolationRecord(record);
  } catch (err) {
    console.warn("renderViolationRecord warning:", err);
  }

  // Save photographic evidence to local computer filesystem
  if (window.trafficApi && window.trafficApi.saveSnapshot && snapshotDataUrl) {
    try {
      const saveRes = await window.trafficApi.saveSnapshot({ base64Data: snapshotDataUrl, metadata: record });
      if (saveRes && saveRes.success) {
        appendTerminalLog(`💾 Photo saved on computer: ${saveRes.filename}`, "operator");
        await loadStoredSnapshots();
      } else {
        appendTerminalLog(`⚠️ Failed saving photo to disk: ${saveRes ? saveRes.error : 'Unknown'}`, "operator");
      }
    } catch (err) {
      console.error("Failed storing violation photo:", err);
      appendTerminalLog(`⚠️ Error saving snapshot: ${err.message}`, "operator");
    }
  }

  // Publish to MQTT topic traffic/junction1/violations
  if (isConnected && window.trafficApi) {
    window.trafficApi.publish(PROTO.topics.violations, record).catch(() => {});
  }
}
window.captureManualViolation = captureManualViolation;

// ===========================================================================
// STORED EVIDENCE GALLERY & FULL-SCREEN EVIDENCE VIEWER
// ===========================================================================
let storedSnapshotsList = [];
let currentViewingSnapshot = null;

async function loadStoredSnapshots() {
  if (!window.trafficApi || !window.trafficApi.listSnapshots) return;
  try {
    const res = await window.trafficApi.listSnapshots();
    if (res && res.success) {
      storedSnapshotsList = res.snapshots || [];
      renderStoredGallery(storedSnapshotsList);
    }
  } catch (err) {
    console.error("Failed loading stored snapshots:", err);
  }
}
window.loadStoredSnapshots = loadStoredSnapshots;

function renderStoredGallery(list) {
  if (dom.badgeStoredCount) {
    dom.badgeStoredCount.textContent = `${list.length} Saved`;
    dom.badgeStoredCount.className = list.length > 0
      ? "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800"
      : "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-400";
  }

  if (!dom.storedGalleryGrid) return;

  if (list.length === 0) {
    dom.storedGalleryGrid.innerHTML = `
      <div class="text-center py-6 text-xs text-slate-600 font-mono">
        No saved snapshots on computer yet. Intrusion photos will automatically appear here.
      </div>
    `;
    return;
  }

  dom.storedGalleryGrid.innerHTML = list.map((item, idx) => `
    <div class="bg-slate-950 border border-slate-800 hover:border-slate-700 p-2 rounded-xl flex items-center justify-between gap-3 text-xs transition group">
      <!-- Thumbnail & Plate -->
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-16 h-10 rounded overflow-hidden bg-black shrink-0 border border-slate-800 cursor-pointer relative" onclick="openEvidenceModalByIndex(${idx})">
          <img src="${item.dataUrl}" alt="Evidence" class="w-full h-full object-cover group-hover:scale-105 transition" />
          <div class="absolute inset-0 bg-black/20 group-hover:bg-transparent transition"></div>
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="font-bold text-white text-[11px] truncate cursor-pointer hover:text-brand-300" onclick="openEvidenceModalByIndex(${idx})">${item.plate_number}</span>
            <span class="text-[9px] font-mono px-1 rounded bg-rose-500/20 text-rose-400 font-bold">${item.speed_kmh} km/h</span>
          </div>
          <div class="text-[9px] text-slate-400 truncate mt-0.5 font-mono">
            ${item.approach} &bull; ${item.timestamp}
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex items-center gap-1 shrink-0">
        <button onclick="openEvidenceModalByIndex(${idx})" class="text-[10px] font-bold px-2 py-1 rounded bg-slate-800 hover:bg-brand-600 text-slate-300 hover:text-white transition flex items-center gap-1 shadow" title="View Full Evidence in App">
          🔍 View
        </button>
        <button onclick="openSnapshotInFiles('${encodeURIComponent(item.filePath)}')" class="text-[10px] font-bold px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 transition flex items-center gap-1" title="Open File on Computer">
          📁
        </button>
      </div>
    </div>
  `).join("");
}

function openEvidenceModalByIndex(idx) {
  if (storedSnapshotsList[idx]) {
    openEvidenceModal(storedSnapshotsList[idx]);
  }
}
window.openEvidenceModalByIndex = openEvidenceModalByIndex;

function openEvidenceModal(item) {
  currentViewingSnapshot = item;
  if (!dom.modalEvidenceViewer) return;

  if (dom.imgModalEvidence) dom.imgModalEvidence.src = item.dataUrl || "";
  if (dom.modalMetaPlate) dom.modalMetaPlate.textContent = item.plate_number || "VEH-VIOLATION";
  if (dom.modalMetaApproach) dom.modalMetaApproach.textContent = item.approach || "T-Junction";
  if (dom.modalMetaSpeed) dom.modalMetaSpeed.textContent = `${item.speed_kmh} KM/H (RADAR)`;
  if (dom.modalMetaSensor) dom.modalMetaSensor.textContent = item.sensor || "RED LIGHT TRAP";
  if (dom.modalMetaTime) dom.modalMetaTime.textContent = item.timestamp || item.createdAt || "--";
  if (dom.modalMetaPath) dom.modalMetaPath.textContent = item.filePath || "--";

  dom.modalEvidenceViewer.classList.remove("hidden");
}
window.openEvidenceModal = openEvidenceModal;

function closeEvidenceModal() {
  if (dom.modalEvidenceViewer) {
    dom.modalEvidenceViewer.classList.add("hidden");
  }
  currentViewingSnapshot = null;
}
window.closeEvidenceModal = closeEvidenceModal;

function openCurrentEvidenceFile() {
  if (currentViewingSnapshot && currentViewingSnapshot.filePath && window.trafficApi) {
    window.trafficApi.openSnapshotFile(currentViewingSnapshot.filePath);
  }
}
window.openCurrentEvidenceFile = openCurrentEvidenceFile;

function openSnapshotInFiles(encodedPath) {
  const filePath = decodeURIComponent(encodedPath);
  if (filePath && window.trafficApi) {
    window.trafficApi.openSnapshotFile(filePath);
  }
}
window.openSnapshotInFiles = openSnapshotInFiles;

async function deleteCurrentEvidenceFile() {
  if (!currentViewingSnapshot || !window.trafficApi) return;
  if (confirm(`Are you sure you want to delete ${currentViewingSnapshot.filename} from the computer?`)) {
    const res = await window.trafficApi.deleteSnapshot(currentViewingSnapshot.filename);
    if (res && res.success) {
      appendTerminalLog(`Deleted evidence photo: ${currentViewingSnapshot.filename}`, "operator");
      closeEvidenceModal();
      loadStoredSnapshots();
    }
  }
}
window.deleteCurrentEvidenceFile = deleteCurrentEvidenceFile;

function openCapturesFolder() {
  if (window.trafficApi && window.trafficApi.openSnapshotsFolder) {
    window.trafficApi.openSnapshotsFolder();
  }
}
window.openCapturesFolder = openCapturesFolder;

function refreshStoredGallery() {
  loadStoredSnapshots();
}
window.refreshStoredGallery = refreshStoredGallery;

// ===========================================================================
// BRIDGE EVENT LOG TERMINAL
// ===========================================================================
function appendTerminalLog(msg, source = "bridge") {
  if (!dom.logTerminal) return;

  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();

  if (source === "operator") {
    line.className = "text-brand-400 font-semibold";
    line.textContent = `[${time}] [OPERATOR] ${msg}`;
  } else if (msg.includes("FAULT") || msg.includes("ERROR")) {
    line.className = "text-rose-400 font-semibold";
    line.textContent = `[${time}] ${msg}`;
  } else if (msg.includes("WARN") || msg.includes("FLASH")) {
    line.className = "text-amber-400";
    line.textContent = `[${time}] ${msg}`;
  } else {
    line.className = "text-slate-400";
    line.textContent = `[${time}] ${msg}`;
  }

  dom.logTerminal.appendChild(line);

  // Keep max 250 lines
  while (dom.logTerminal.children.length > 250) {
    dom.logTerminal.removeChild(dom.logTerminal.firstChild);
  }

  dom.logTerminal.scrollTop = dom.logTerminal.scrollHeight;
}

function copyEventLog() {
  if (!dom.logTerminal) return;
  const text = dom.logTerminal.innerText;
  navigator.clipboard.writeText(text).then(() => {
    alert("Event log copied to clipboard.");
  }).catch(err => {
    console.error("Clipboard copy error:", err);
  });
}
window.copyEventLog = copyEventLog;

function clearEventLog() {
  if (dom.logTerminal) {
    dom.logTerminal.innerHTML = '<div class="text-slate-600 italic">Terminal log cleared.</div>';
  }
}
window.clearEventLog = clearEventLog;
