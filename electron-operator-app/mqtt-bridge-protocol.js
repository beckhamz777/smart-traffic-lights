/**
 * Centralized MQTT Bridge Protocol & Hardware Channel Mapping
 * -----------------------------------------------------------
 * Mirrors the Right-Hand Traffic (RHT / KeepRight) T-Junction setup
 * implemented in tools/demo_dashboard.html and the ESP32-WROOM-32 controller.
 *
 * Firmware Target: ESP32-WROOM-32 (30-Pin DevKit)
 * Architecture: RHT / KeepRight 3-Way T-Junction
 * Source Authority: include/TrafficConfig.h & include/SignalOutputDriver.h
 */

const MQTT_BRIDGE_PROTOCOL = {
  // Default WebSocket broker URL via Mosquitto
  defaultBrokerUrl: "ws://localhost:9001",

  // -------------------------------------------------------------------------
  // MQTT TOPIC STRUCTURE (Mirrors demo_dashboard.html)
  // -------------------------------------------------------------------------
  topics: {
    telemetry: "traffic/junction1/telemetry", // Authoritative FSM status, 13-channel outputs, densities
    logs: "traffic/junction1/logs",           // Live firmware event lines & serial log ticker
    command: "traffic/junction1/command",     // Command channel relayed directly to ESP32 serial
    violations: "traffic/junction1/violations", // Red-light camera alert payloads (optional/aux)
    health: "traffic/junction1/health"        // Hardware diagnostic telemetry (optional/aux)
  },

  // -------------------------------------------------------------------------
  // PHYSICAL 13-LAMP & SENSOR GPIO MAPPINGS (docs/ESP32_FINAL_GPIO_ASSIGNMENT.md)
  // -------------------------------------------------------------------------
  hardwareMap: {
    lamps: {
      // 1. Main Road Head (EB/WB Arterial)
      MAIN_R: { pin: 27, name: "Main Red", head: "MAIN" },
      MAIN_Y: { pin: 26, name: "Main Yellow", head: "MAIN" },
      MAIN_G: { pin: 25, name: "Main Green", head: "MAIN" },

      // 2. Side Road Head (NB Stem)
      SIDE_R: { pin: 14, name: "Side Red", head: "SIDE" },
      SIDE_Y: { pin: 12, name: "Side Yellow", head: "SIDE" },
      SIDE_G: { pin: 13, name: "Side Green", head: "SIDE" },

      // 3. Protected Turn Head (RHT Left-Turn)
      TURN_R: { pin: 22, name: "Turn Red", head: "TURN" },
      TURN_Y: { pin: 23, name: "Turn Yellow", head: "TURN" },
      TURN_G: { pin: 21, name: "Turn Green", head: "TURN" },

      // 4. Pedestrian 1 Head (East Crosswalk)
      PED1_W:  { pin: 19, name: "Ped 1 Walk", head: "PED1" },
      PED1_DW: { pin: 18, name: "Ped 1 Don't Walk", head: "PED1" },

      // 5. Pedestrian 2 Head (Side Crosswalk)
      PED2_W:  { pin: 16, name: "Ped 2 Walk", head: "PED2" },
      PED2_DW: { pin: 17, name: "Ped 2 Don't Walk", head: "PED2" }
    },

    sensors: {
      IR1: { pin: 33, role: "Main Front S1 (Entry)", road: "MAIN", hasInternalPullup: true },
      IR2: { pin: 34, role: "Main Rear S2 (Stopbar)", road: "MAIN", hasInternalPullup: false },
      IR3: { pin: 35, role: "Side Front S1 (Entry)", road: "SIDE", hasInternalPullup: false },
      IR4: { pin: 36, role: "Side Rear S2 (Stopbar)", road: "SIDE", hasInternalPullup: false },
      IR5: { pin: 39, role: "Turn Front S1 (Entry)", road: "TURN", hasInternalPullup: false },
      IR6: { pin: 15, role: "Turn Rear S2 (Stopbar)", road: "TURN", hasInternalPullup: true }
    },

    buttons: {
      PED1_BTN: { pin: 32, label: "PED 1 Button (East)" },
      PED2_BTN: { pin: 4,  label: "PED 2 Button (Side)" }
    }
  },

  // -------------------------------------------------------------------------
  // TELEMETRY ADAPTER & PAYLOAD NORMALIZER
  // -------------------------------------------------------------------------
  adaptTelemetry: function (payload) {
    if (!payload || typeof payload !== "object") return null;

    const out = payload.outputs || {};
    const density = payload.density || {};

    // 1. Main Road Approach (West/East Arterial)
    const mainApproach = {
      name: "Main Road (Arterial)",
      code: "MAIN_ROAD",
      red: Boolean(out.mainR),
      orange: Boolean(out.mainY),
      green: Boolean(out.mainG),
      sensorsActive: density.main ? density.main.sensors : 0,
      congestionPct: density.main ? density.main.pct : 0,
      allocatedSec: density.main ? density.main.allocatedSec : 0,
      sensor1: "IR1 (GPIO 33)",
      sensor2: "IR2 (GPIO 34)"
    };

    // 2. Protected Turn Movement (RHT Left-Turn)
    const turnApproach = {
      name: "Protected Left Turn",
      code: "PROTECTED_TURN",
      red: Boolean(out.turnR),
      orange: Boolean(out.turnY),
      green: Boolean(out.turnG),
      sensorsActive: density.turn ? density.turn.sensors : 0,
      congestionPct: density.turn ? density.turn.pct : 0,
      allocatedSec: density.turn ? density.turn.allocatedSec : 0,
      sensor1: "IR5 (GPIO 39)",
      sensor2: "IR6 (GPIO 15)"
    };

    // 3. Side Road Approach (Northbound Stem)
    const sideApproach = {
      name: "Side Road (Stem NB)",
      code: "SIDE_ROAD",
      red: Boolean(out.sideR),
      orange: Boolean(out.sideY),
      green: Boolean(out.sideG),
      sensorsActive: density.side ? density.side.sensors : 0,
      congestionPct: density.side ? density.side.pct : 0,
      allocatedSec: density.side ? density.side.allocatedSec : 0,
      sensor1: "IR3 (GPIO 35)",
      sensor2: "IR4 (GPIO 36)"
    };

    // Pedestrian Head 1 (East)
    const ped1 = {
      walk: Boolean(out.pedWalk),
      dontWalk: Boolean(out.pedDontWalk),
      walkPin: 19,
      dontWalkPin: 18,
      buttonPin: 32
    };

    // Pedestrian Head 2 (Side)
    const ped2 = {
      walk: Boolean(out.ped2Walk),
      dontWalk: Boolean(out.ped2DontWalk),
      walkPin: 16,
      dontWalkPin: 17,
      buttonPin: 4
    };

    // High-Traffic Priority Evaluation
    let priorityCode = "NONE";
    let maxPct = 0;
    [
      { code: "MAIN_ROAD", app: mainApproach },
      { code: "SIDE_ROAD", app: sideApproach },
      { code: "PROTECTED_TURN", app: turnApproach }
    ].forEach(({ code, app }) => {
      if (app.congestionPct > maxPct) {
        maxPct = app.congestionPct;
        priorityCode = code;
      }
    });

    const elapsedMs = payload.stateElapsedMs || 0;
    const elapsedSec = Math.floor(elapsedMs / 1000);

    return {
      timestamp: payload.timestamp || new Date().toISOString(),
      currentFsmState: payload.currentFsmState || "UNKNOWN",
      controlMode: payload.controlMode || "AUTO",
      operatingMode: payload.operatingMode || "UNKNOWN",
      stateElapsedMs: elapsedMs,
      stateElapsedSec: elapsedSec,
      nextTargetPhase: payload.nextTargetPhase || "UNKNOWN",
      flashOrangeActive: Boolean(payload.flashOrangeActive),
      approaches: {
        main: mainApproach,
        turn: turnApproach,
        side: sideApproach
      },
      pedestrians: {
        ped1: ped1,
        ped2: ped2
      },
      prioritizedApproach: priorityCode,
      maxCongestionPct: maxPct,
      rawOutputs: out
    };
  },

  // -------------------------------------------------------------------------
  // COMMAND BUILDERS RELAYED TO ESP32 VIA BRIDGE
  // -------------------------------------------------------------------------
  commands: {
    setMode: (mode) => `MODE ${mode.toUpperCase().trim()}`,
    nextPhase: () => "NEXT",
    emergencyFault: () => "FAULT",
    clearFaults: () => "CLEAR",
    resetController: () => "RESET",

    // Timings
    setTimingPreset: (preset) => `TIMING ${preset.toUpperCase()}`, // PROTOTYPE or BENCH
    setTimingSet: (mMin, mMax, mYel, sMin, sMax, sYel, tMin, tMax, tYel, pWalk, pClear, allRed) =>
      `TIMING SET ${mMin} ${mMax} ${mYel} ${sMin} ${sMax} ${sYel} ${tMin} ${tMax} ${tYel} ${pWalk} ${pClear} ${allRed}`,

    // Flashing Caution
    flashOrangeOn: () => "FLASH_ORANGE",
    flashOrangeOff: () => "RESUME_AUTO",

    // Commissioning
    commissionVeh: (on) => `COMMISSION VEH ${on ? "ON" : "OFF"}`,
    commissionPed: (on) => `COMMISSION PED ${on ? "ON" : "OFF"}`,
    commissionIr: (channel, on) => `COMMISSION IR ${channel} ${on ? "ON" : "OFF"}`,
    commissionTurn: (on) => `COMMISSION TURN ${on ? "ON" : "OFF"}`,

    // Approach Vehicle Demands & IR Sensors
    carDemand: (movement, on) => `CAR ${movement.toUpperCase()} ${on ? "ON" : "OFF"}`,
    sensorTrigger: (sensorKey, on) => `${sensorKey.toUpperCase()} ${on ? "ON" : "OFF"}`,
    pedButton: (num) => `PED ${num}`,
    clearSensors: () => "CLEAR_SENSORS",

    // Single Lamp Test
    lampTest: (channelName) => `LAMP TEST ${channelName.toUpperCase()}`,
    lampOff: () => "LAMP OFF"
  }
};

// CommonJS export
if (typeof module !== "undefined" && module.exports) {
  module.exports = MQTT_BRIDGE_PROTOCOL;
}

