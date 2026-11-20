# Smart Traffic Light Operator Dashboard & MQTT Specification

## 1. System Architecture Overview

The system is engineered as an industrial-grade Traffic Operations Center (TOC) web dashboard communicating in real-time with smart intersection hardware/backends via **MQTT over WebSockets (port 9001)** or standard **MQTT (port 1883)**.

```
+-------------------------------------------------------------------------------+
|                       OPERATOR WEB DASHBOARD (HTML5/Tailwind/MQTT.js)         |
|  - 4-Way 2D Intersection Visualizer     - High-Contrast Signal Lights & Timers |
|  - Real-time Sensor Interactive Pads   - Adaptive Mode & Manual Timing Config  |
|  - CCTV Law-Breakers & Radar Alert Log - System Health & Hardware Diagnostics |
+-------------------------------------------------------------------------------+
                                      |
                      WebSocket (ws://localhost:9001)
                                      v
+-------------------------------------------------------------------------------+
|                      ECLIPSE MOSQUITTO MQTT BROKER                            |
|       Port 1883 (TCP / Native MQTT)  <-->  Port 9001 (WebSockets)            |
+-------------------------------------------------------------------------------+
                                      ^
                         Standard MQTT (TCP / 1883)
                                      |
       +------------------------------+-----------------------------+
       |                                                            |
+-----------------------------+                     +-------------------------------+
|   ESP32 SMART CONTROLLER    |                     |   PYTHON BACKEND SIMULATOR    |
|   (Native C++ Firmware)     |                     | (tools/traffic_backend_sim.py)|
+-----------------------------+                     +-------------------------------+
```

---

## 2. MQTT Topic Hierarchy & JSON Payload Schemas

### Topic Hierarchy Summary
| Direction | Topic | Purpose | Update Frequency |
| :--- | :--- | :--- | :--- |
| **Broker $\rightarrow$ UI** | `traffic/intersection1/lights/status` | Active colors (N, S, E, W) & real-time countdown timers | 1 Hz |
| **Broker $\rightarrow$ UI** | `traffic/intersection1/sensors` | Inductive loop presence, % congestion, adaptive calculations | 0.5 Hz (every 2s) |
| **Broker $\rightarrow$ UI** | `traffic/intersection1/alerts/violations` | Red-light runner alerts, radar speeds, vehicle snapshots | Event-driven |
| **Broker $\rightarrow$ UI** | `traffic/intersection1/health` | Hardware heartbeat ping, offline cameras/sensors/lamps | 0.33 Hz (every 3s) |
| **UI $\rightarrow$ Broker** | `traffic/intersection1/control/mode` | Operator toggle: `ADAPTIVE` vs `MANUAL` | On user toggle |
| **UI $\rightarrow$ Broker** | `traffic/intersection1/control/timing` | Custom manual Green, Orange, Red phase switch times | On publish |
| **UI $\rightarrow$ Broker** | `traffic/intersection1/control/command` | Operator emergency overrides (e.g. `EMERGENCY_ALL_RED`) | On user trigger |

---

### Payload 1: Traffic Lights Status & Countdown
- **Topic**: `traffic/intersection1/lights/status`
- **Sample JSON**:
```json
{
  "intersection_id": "INT-01",
  "timestamp": "2026-11-20T01:10:04.120Z",
  "current_phase": "NS_GREEN",
  "mode": "ADAPTIVE",
  "countdown_sec": 14,
  "lights": {
    "north": { "color": "GREEN", "countdown": 14 },
    "south": { "color": "GREEN", "countdown": 14 },
    "east":  { "color": "RED",   "countdown": 18 },
    "west":  { "color": "RED",   "countdown": 18 }
  }
}
```

---

### Payload 2: Road Sensors & Adaptive Congestion Telemetry
- **Topic**: `traffic/intersection1/sensors`
- **Logic**:
  - `0 sensors active` $\rightarrow$ Base green duration (6 seconds)
  - `1 sensor active` $\rightarrow$ 50% congestion $\rightarrow$ 10 seconds green
  - `2 sensors active` $\rightarrow$ 100% congestion $\rightarrow$ 20 seconds green
- **Sample JSON**:
```json
{
  "intersection_id": "INT-01",
  "timestamp": "2026-11-20T01:10:04.000Z",
  "lanes": {
    "north": {
      "sensors_active": 0,
      "congestion_pct": 0,
      "sensor_1": false,
      "sensor_2": false,
      "calculated_green_sec": 6
    },
    "south": {
      "sensors_active": 0,
      "congestion_pct": 0,
      "sensor_1": false,
      "sensor_2": false,
      "calculated_green_sec": 6
    },
    "east": {
      "sensors_active": 2,
      "congestion_pct": 100,
      "sensor_1": true,
      "sensor_2": true,
      "calculated_green_sec": 20
    },
    "west": {
      "sensors_active": 1,
      "congestion_pct": 50,
      "sensor_1": true,
      "sensor_2": false,
      "calculated_green_sec": 10
    }
  },
  "prioritized_lane": "east",
  "priority_reason": "Highest congestion (100% - 2 active sensors)"
}
```

---

### Payload 3: Operator Mode & Manual Timing Commands
- **Topic**: `traffic/intersection1/control/mode`
```json
{
  "mode": "MANUAL",
  "operator_id": "OP-94",
  "timestamp": "2026-11-20T01:10:15.000Z"
}
```

- **Topic**: `traffic/intersection1/control/timing`
```json
{
  "green_sec": 18,
  "orange_sec": 4,
  "red_sec": 2,
  "operator_id": "OP-94",
  "timestamp": "2026-11-20T01:10:20.000Z"
}
```

---

### Payload 4: Law Breakers & Red-Light Violation Alerts
- **Topic**: `traffic/intersection1/alerts/violations`
- **Sample JSON**:
```json
{
  "violation_id": "VIO-20261120-0042",
  "timestamp": "01:10:04",
  "type": "RED_LIGHT_RUNNER",
  "lane": "west",
  "speed_kmh": 68.4,
  "speed_limit_kmh": 50.0,
  "plate_number": "ABC-8924",
  "vehicle_color": "Silver",
  "vehicle_type": "Sedan",
  "fine_status": "FLAGGED_FOR_REVIEW"
}
```

---

### Payload 5: System Health & Hardware Fault Diagnostics
- **Topic**: `traffic/intersection1/health`
- **Sample JSON**:
```json
{
  "intersection_id": "INT-01",
  "timestamp": "2026-11-20T01:10:05.000Z",
  "status": "WARNING",
  "heartbeat_ms": 42,
  "uptime": "99.8%",
  "faults": [
    "West Lane Sensor 1 Disconnected",
    "East Orange Lamp Burnt-out Warning"
  ]
}
```

---

## 3. Operator Dashboard User Guide

### How to Run:

#### Option A: Standalone In-Browser Test (Zero Setup)
1. Serve the workspace root or open `tools/operator_dashboard.html` in Chrome/Firefox/Edge.
2. The dashboard boots into **Mock Engine Mode** automatically.
3. Every feature works immediately in your browser:
   - Interactive sensor clicking on the 2D intersection map.
   - Dynamic adaptive recalculation (6s $\rightarrow$ 10s $\rightarrow$ 20s).
   - High-traffic priority highlight & ping indicator.
   - Live CCTV simulated camera feed with camera switcher (N, S, E, W).
   - Instant "Simulate Violation" button with audio chime & detail modal.
   - Diagnostic fault injector & clearing buttons.

#### Option B: Live MQTT Broker Mode (Full-Stack)
1. Ensure Mosquitto is active on your machine (ports 1883 and 9001).
2. Start the Python traffic simulator:
   ```bash
   python3 tools/traffic_backend_simulator.py
   ```
3. In the top-right of the dashboard header, click **Live Broker (9001)**.
4. The dashboard switches to live WebSockets, syncing real-time packets directly with the backend!

