/**
 * Centralized MQTT Topics & Payload Adapter for 3-Approach T-Junction
 * -------------------------------------------------------------------
 * Perfectly aligns with the existing web bridge (tools/demo_dashboard.html)
 * and ESP32 firmware running on the 13-channel hardware setup.
 *
 * Topology:
 *  - Approach A: Main Road West  (Eastbound approach: mainR, mainY, mainG | IR1, IR2)
 *  - Approach B: Main Road East  (Westbound / Protected Turn: turnR, turnY, turnG | IR5, IR6)
 *  - Approach C: Stem Side Road  (Northbound approach: sideR, sideY, sideG | IR3, IR4)
 *  - Pedestrian Crossings:
 *      * Ped 1 (Main Road Crosswalk): pedWalk, pedDontWalk
 *      * Ped 2 (Side Road Crosswalk): ped2Walk, ped2DontWalk
 */

const MQTT_TOPICS = {
  // Default WebSocket broker endpoint
  defaultBrokerUrl: "ws://localhost:9001",

  // -------------------------------------------------------------------------
  // TOPIC DEFINITIONS (Aligned with demo_dashboard.html Web Bridge)
  // -------------------------------------------------------------------------
  topics: {
    // Primary telemetry stream published by demo_dashboard.html bridge
    telemetry: "traffic/junction1/telemetry",

    // Serial console logs & system events stream published by bridge
    logs: "traffic/junction1/logs",

    // Command channel subscribed to by demo_dashboard.html bridge to relay to ESP32
    command: "traffic/junction1/command",

    // Dedicated / standard violation and health channels (also ingested if available)
    violations: "traffic/junction1/violations",
    health: "traffic/junction1/health",

    // Optional legacy/alternative granular aliases
    legacyStatus: "traffic/status",
    legacySensors: "traffic/sensors"
  },

  // List of all topics to subscribe to upon broker connection
  subscribeList: [
    "traffic/junction1/telemetry",
    "traffic/junction1/logs",
    "traffic/junction1/violations",
    "traffic/junction1/health",
    "traffic/status",
    "traffic/sensors"
  ],

  // -------------------------------------------------------------------------
  // PAYLOAD ADAPTER & NORMALIZER
  // -------------------------------------------------------------------------
  /**
   * Normalizes any incoming payload into a standardized T-junction state object.
   * Handles demo_dashboard.html's publishMqttTelemetry schema seamlessly:
   * {
   *   timestamp: string,
   *   currentFsmState: string,
   *   controlMode: "AUTO" | "FIXED" | "MANUAL" | "ADAPTIVE" | "FLASH_ORANGE",
   *   operatingMode: string,
   *   stateElapsedMs: number,
   *   nextTargetPhase: string,
   *   flashOrangeActive: boolean,
   *   outputs: {
   *     mainR, mainY, mainG,
   *     turnR, turnY, turnG,
   *     sideR, sideY, sideG,
   *     pedWalk, pedDontWalk,
   *     ped2Walk, ped2DontWalk
   *   },
   *   density: {
   *     main: { sensors: 0|1|2, pct: 0|50|100, allocatedSec: 0|10|20 },
   *     turn: { sensors: 0|1|2, pct: 0|50|100, allocatedSec: 0|10|20 },
   *     side: { sensors: 0|1|2, pct: 0|50|100, allocatedSec: 0|10|20 }
   *   }
   * }
   */
  adaptTelemetry: function (payload) {
    if (!payload || typeof payload !== "object") return null;

    // Check if it's the web bridge telemetry format
    const out = payload.outputs || {};
    const density = payload.density || {};

    // Approach A (Main Road West)
    const approachA = {
      name: "Main Road (West Approach)",
      code: "MAIN_WEST",
      red: Boolean(out.mainR),
      orange: Boolean(out.mainY),
      green: Boolean(out.mainG),
      sensorsActive: density.main ? density.main.sensors : 0,
      congestionPct: density.main ? density.main.pct : 0,
      allocatedSec: density.main ? density.main.allocatedSec : 0
    };

    // Approach B (Main Road East / Protected Turn)
    const approachB = {
      name: "Main Road (East & Turn)",
      code: "MAIN_EAST",
      red: Boolean(out.turnR),
      orange: Boolean(out.turnY),
      green: Boolean(out.turnG),
      sensorsActive: density.turn ? density.turn.sensors : 0,
      congestionPct: density.turn ? density.turn.pct : 0,
      allocatedSec: density.turn ? density.turn.allocatedSec : 0
    };

    // Approach C (Stem / Side Road South)
    const approachC = {
      name: "Stem / Side Road (South Approach)",
      code: "SIDE_SOUTH",
      red: Boolean(out.sideR),
      orange: Boolean(out.sideY),
      green: Boolean(out.sideG),
      sensorsActive: density.side ? density.side.sensors : 0,
      congestionPct: density.side ? density.side.pct : 0,
      allocatedSec: density.side ? density.side.allocatedSec : 0
    };

    // Pedestrian Crossing 1 (Main Road crosswalk)
    const ped1 = {
      walk: Boolean(out.pedWalk),
      dontWalk: Boolean(out.pedDontWalk)
    };

    // Pedestrian Crossing 2 (Side Road crosswalk)
    const ped2 = {
      walk: Boolean(out.ped2Walk),
      dontWalk: Boolean(out.ped2DontWalk)
    };

    // Determine highest traffic priority lane among the 3 approaches
    let prioritizedApproach = "NONE";
    let maxCongestion = -1;
    [
      { id: "APPROACH_A", approach: approachA },
      { id: "APPROACH_B", approach: approachB },
      { id: "APPROACH_C", approach: approachC }
    ].forEach(({ id, approach }) => {
      if (approach.congestionPct > maxCongestion && approach.congestionPct > 0) {
        maxCongestion = approach.congestionPct;
        prioritizedApproach = id;
      }
    });

    // Countdown estimation directly from hardware state elapsed and allocated timings
    const elapsedSec = payload.stateElapsedMs ? Math.floor(payload.stateElapsedMs / 1000) : 0;

    return {
      timestamp: payload.timestamp || new Date().toISOString(),
      fsmState: payload.currentFsmState || "UNKNOWN",
      controlMode: payload.controlMode || "AUTO",
      operatingMode: payload.operatingMode || "UNKNOWN",
      flashOrangeActive: Boolean(payload.flashOrangeActive),
      nextTargetPhase: payload.nextTargetPhase || "UNKNOWN",
      elapsedSec: elapsedSec,
      approaches: {
        a: approachA,
        b: approachB,
        c: approachC
      },
      pedestrians: {
        ped1: ped1,
        ped2: ped2
      },
      prioritizedApproach: prioritizedApproach,
      maxCongestion: maxCongestion > 0 ? maxCongestion : 0,
      rawOutputs: out
    };
  },

  // -------------------------------------------------------------------------
  // COMMAND BUILDERS FOR WEB BRIDGE & ESP32 RELAY
  // -------------------------------------------------------------------------
  /**
   * The web bridge (demo_dashboard.html) accepts plain text serial strings
   * or JSON on the topic "traffic/junction1/command".
   */
  commands: {
    // Mode switch: "MODE ADAPTIVE", "MODE FIXED", "MODE MANUAL"
    setMode: function (mode) {
      return `MODE ${mode.toUpperCase()}`;
    },

    // Step to next phase in manual mode
    nextPhase: function () {
      return "NEXT";
    },

    // Emergency All-Red clearance hold
    emergencyAllRed: function () {
      return "FAULT";
    },

    // Clear fault / restore safe cycle
    clearFaults: function () {
      return "CLEAR";
    },

    // Apply timings: "TIMING SET <mMin> <mMax> <mYel> <sMin> <sMax> <sYel> <tMin> <tMax> <tYel> <pWalk> <pClear> <allRed>"
    setTimings: function (greenSec, orangeSec, redSec) {
      const g = Math.max(5, parseInt(greenSec, 10) || 15);
      const o = Math.max(2, parseInt(orangeSec, 10) || 3);
      const r = Math.max(1, parseInt(redSec, 10) || 2);
      // Construct atomic ESP32 command accepted by SerialCommandHandler
      return `TIMING SET ${g} ${g + 10} ${o} ${g} ${g + 10} ${o} ${g} ${g + 10} ${o} 7 4 ${r}`;
    },

    // Flashing orange caution toggle
    flashOrangeOn: function () {
      return "FLASH_ORANGE";
    },
    flashOrangeOff: function () {
      return "RESUME_AUTO";
    }
  }
};

// Export for Node.js / Electron main & preload
if (typeof module !== "undefined" && module.exports) {
  module.exports = MQTT_TOPICS;
}

