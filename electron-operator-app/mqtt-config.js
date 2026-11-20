/**
 * Centralized MQTT Configuration & Topic Schema Definition
 * ---------------------------------------------------------
 * This file defines all subscribed and published MQTT topics and expected
 * JSON payload structures for the Smart Traffic Intersection Operator App.
 *
 * It is consumed by both the Electron main process and preload bridge.
 */

const MQTT_CONFIG = {
  // Default WebSocket broker connection endpoint
  defaultBrokerUrl: "ws://localhost:9001",

  // Client connection options
  clientOptions: {
    clientIdPrefix: "electron_traffic_ops_",
    clean: true,
    connectTimeout: 5000,
    reconnectPeriod: 3000,
    keepalive: 30
  },

  // Topic Definitions
  topics: {
    // ------------------------------------------------------------------------
    // INCOMING / SUBSCRIBED TOPICS (From Web Bridge / ESP32 Controller)
    // ------------------------------------------------------------------------

    /**
     * Topic: traffic/intersection1/lights/status
     * Frequency: ~1 Hz (authoritative tick from hardware)
     * Expected Payload:
     * {
     *   "intersection_id": "INT-01",
     *   "timestamp": "2026-11-20T01:10:04Z",
     *   "current_phase": "NS_GREEN", // e.g. NS_GREEN, NS_YELLOW, ALL_RED, EW_GREEN, EW_YELLOW
     *   "mode": "ADAPTIVE",          // "ADAPTIVE" or "FIXED"
     *   "countdown_sec": 14,         // Remaining seconds for current active phase
     *   "lights": {
     *     "north": { "color": "GREEN", "countdown": 14 },
     *     "south": { "color": "GREEN", "countdown": 14 },
     *     "east":  { "color": "RED",   "countdown": 18 },
     *     "west":  { "color": "RED",   "countdown": 18 }
     *   }
     * }
     */
    lights_status: "traffic/intersection1/lights/status",

    /**
     * Topic: traffic/intersection1/sensors
     * Frequency: Event-driven or periodic (every 1-2s)
     * Expected Payload:
     * {
     *   "intersection_id": "INT-01",
     *   "timestamp": "2026-11-20T01:10:04Z",
     *   "lanes": {
     *     "north": { "sensors_active": 1, "congestion_pct": 50, "sensor_1": true, "sensor_2": false, "calculated_green_sec": 10 },
     *     "south": { "sensors_active": 0, "congestion_pct": 0,  "sensor_1": false, "sensor_2": false, "calculated_green_sec": 6 },
     *     "east":  { "sensors_active": 2, "congestion_pct": 100, "sensor_1": true, "sensor_2": true, "calculated_green_sec": 20 },
     *     "west":  { "sensors_active": 1, "congestion_pct": 50, "sensor_1": true, "sensor_2": false, "calculated_green_sec": 10 }
     *   },
     *   "prioritized_lane": "east", // "north", "south", "east", or "west"
     *   "priority_reason": "Highest congestion (100% - 2 active sensors)"
     * }
     */
    sensors: "traffic/intersection1/sensors",

    /**
     * Topic: traffic/intersection1/alerts/violations
     * Frequency: Event-driven on red-light runner or speeding detection
     * Expected Payload:
     * {
     *   "violation_id": "VIO-20261120-0042",
     *   "timestamp": "01:10:04",
     *   "type": "RED_LIGHT_RUNNER",
     *   "lane": "west",
     *   "speed_kmh": 68.4,
     *   "speed_limit_kmh": 50.0,
     *   "plate_number": "ABC-8924",
     *   "vehicle_color": "Silver",
     *   "vehicle_type": "Sedan",
     *   "snapshot_url": "data:image/jpeg;base64,...", // Optional base64 or stream URL
     *   "fine_status": "FLAGGED_FOR_REVIEW"
     * }
     */
    alerts_violations: "traffic/intersection1/alerts/violations",

    /**
     * Topic: traffic/intersection1/health
     * Frequency: Every 3-5 seconds
     * Expected Payload:
     * {
     *   "intersection_id": "INT-01",
     *   "timestamp": "2026-11-20T01:10:05Z",
     *   "status": "HEALTHY", // "HEALTHY", "WARNING", "CRITICAL", "OFFLINE"
     *   "heartbeat_ms": 42,
     *   "uptime": "99.8%",
     *   "faults": [
     *     "West Lane Sensor 1 Disconnected",
     *     "East Orange Lamp Burnt-out Warning"
     *   ],
     *   "components": {
     *     "controller": "ONLINE",
     *     "cameras": { "north": "OK", "south": "OK", "east": "OK", "west": "OFFLINE" },
     *     "sensors": { "north": "OK", "south": "OK", "east": "OK", "west": "FAULT" },
     *     "lamps": { "north": "OK", "south": "OK", "east": "BURNT_OUT_WARNING", "west": "OK" }
     *   }
     * }
     */
    health: "traffic/intersection1/health",

    // ------------------------------------------------------------------------
    // OUTGOING / PUBLISHED TOPICS (From Operator Desktop App to Hardware/Bridge)
    // ------------------------------------------------------------------------

    /**
     * Topic: traffic/intersection1/control/mode
     * Payload:
     * {
     *   "mode": "ADAPTIVE", // "ADAPTIVE" or "FIXED"
     *   "operator_id": "DESKTOP-OP-01",
     *   "timestamp": "2026-11-20T01:10:15Z"
     * }
     */
    control_mode: "traffic/intersection1/control/mode",

    /**
     * Topic: traffic/intersection1/control/timing
     * Payload:
     * {
     *   "green_sec": 18,
     *   "orange_sec": 4,
     *   "red_sec": 2,
     *   "operator_id": "DESKTOP-OP-01",
     *   "timestamp": "2026-11-20T01:10:20Z"
     * }
     */
    control_timing: "traffic/intersection1/control/timing",

    /**
     * Topic: traffic/intersection1/control/command
     * Payload:
     * {
     *   "command": "EMERGENCY_ALL_RED", // or "RESET_FAULTS", "STEP_NEXT"
     *   "operator_id": "DESKTOP-OP-01",
     *   "timestamp": "2026-11-20T01:10:25Z"
     * }
     */
    control_command: "traffic/intersection1/control/command"
  }
};

// CommonJS export for Node.js / Electron
if (typeof module !== "undefined" && module.exports) {
  module.exports = MQTT_CONFIG;
}

