# Smart Traffic T-Junction Operations — Electron Desktop Application

A production-grade Electron desktop application specifically designed for a traffic operator to monitor and command a **3-approach Right-Hand Traffic (RHT / KeepRight) T-Junction** traffic light system. It interfaces directly with the live Web Bridge ([tools/demo_dashboard.html](file:///home/bexwrld/Downloads/smart-traffic-lights-main/tools/demo_dashboard.html)) and the ESP32-WROOM-32 microcontroller via MQTT WebSockets (`ws://localhost:9001`).

---

## 🏛️ T-Junction Topology Specification (RHT / Keep-Right)

This desktop application strictly models the 3-approach T-Junction matching the 13-channel hardware controller and [docs/ESP32_FINAL_GPIO_ASSIGNMENT.md](file:///home/bexwrld/Downloads/smart-traffic-lights-main/docs/ESP32_FINAL_GPIO_ASSIGNMENT.md):

```
       =========================================================
       MAIN ROAD (Arterial EB / WB): Approach A (Main) <--> Approach B (Turn)
       =======================+          +======================
                              |          |
                              |  STEM /  |
                              |   SIDE   |  Approach C (Side Road NB)
                              |   ROAD   |
                              |          |
```

### Physical 13-Channel Signal Outputs & Heads
1. **Main Road Head (EB / WB Arterial)**:
   - **RED**: GPIO 27
   - **YELLOW**: GPIO 26
   - **GREEN**: GPIO 25
2. **Side Road Head (NB Stem)**:
   - **RED**: GPIO 14
   - **YELLOW**: GPIO 12
   - **GREEN**: GPIO 13
3. **Protected Turn Head (RHT Left-Turn)**:
   - **RED**: GPIO 22
   - **YELLOW**: GPIO 23
   - **GREEN**: GPIO 21
4. **Pedestrian 1 Head (East Crosswalk)**:
   - **WALK**: GPIO 19 | **DON'T WALK**: GPIO 18 | **Pushbutton**: GPIO 32
5. **Pedestrian 2 Head (Side Crosswalk)**:
   - **WALK**: GPIO 16 | **DON'T WALK**: GPIO 17 | **Pushbutton**: GPIO 4

### 6 IR Sensor Ingress Channels (Active-Low: 0 = Vehicle Detected)
- **IR1 (GPIO 33)**: Main Road Front Sensor S1 (Entry)
- **IR2 (GPIO 34)**: Main Road Rear Sensor S2 (Stopbar)
- **IR3 (GPIO 35)**: Side Road Front Sensor S1 (Entry)
- **IR4 (GPIO 36)**: Side Road Rear Sensor S2 (Stopbar)
- **IR5 (GPIO 39)**: Turn Front Sensor S1 (Entry)
- **IR6 (GPIO 15)**: Turn Rear Sensor S2 (Stopbar)

---

## ⚡ Strictly Live Telemetry (Zero Simulators)

- **Zero Mock Simulators / No Synthetic Timers**: Does not contain artificial traffic generators, synthetic state machines, or fake countdown loops.
- **Authoritative Telemetry Ingress**: Signal colors, countdown timers, sensor states, and hardware faults strictly reflect the incoming MQTT payload from the ESP32 / web bridge.
- **Explicit Offline Presentation**: When disconnected from Mosquitto or the bridge, the interface immediately enters **OFFLINE / WAITING FOR BRIDGE** state with unlit signal lenses, `--` countdowns, and dimmed sensor indicators.

---

## 📂 Project Architecture

```
electron-operator-app/
├── package.json               # Application manifest & dependencies
├── mqtt-bridge-protocol.js    # Centralized MQTT bridge protocol & GPIO hardware map
├── main.js                    # Electron main process (IPC handlers & MQTT socket transport)
├── preload.js                 # Secure contextBridge API bridge (contextIsolation: true)
├── src/
│   ├── index.html             # 3-Approach T-Junction RHT operator dashboard
│   ├── renderer.js            # Telemetry normalizer, DOM updater & command publisher
│   └── styles.css             # High-contrast signal glows & dark theme styles
└── README.md                  # Complete operator documentation
```

---

## 🚀 Quickstart Guide

### 1. Verify Prerequisites
- **Node.js**: v18+ or v20+
- **MQTT Broker (Mosquitto)**: Running locally with WebSocket support on port `9001` (e.g. `mosquitto -c mosquitto.conf`).
- **Web Bridge**: [tools/demo_dashboard.html](file:///home/bexwrld/Downloads/smart-traffic-lights-main/tools/demo_dashboard.html) open in Chrome / Edge with Web Serial connected to the ESP32 and MQTT connected to `ws://localhost:9001`.

### 2. Install Dependencies
```bash
cd electron-operator-app
npm install
```

### 3. Launch the Application
```bash
npm start
```

---

## 📡 Centralized Topic Mapping (`mqtt-bridge-protocol.js`)

All channels and payload transformations are centralized in [mqtt-bridge-protocol.js](file:///home/bexwrld/Downloads/smart-traffic-lights-main/electron-operator-app/mqtt-bridge-protocol.js):

| Channel | Type | Topic | Payload / Role |
| :--- | :--- | :--- | :--- |
| **Telemetry Ingress** | Subscribed | `traffic/junction1/telemetry` | Full junction snapshot (`outputs`, `density`, `currentFsmState`, `controlMode`, `stateElapsedMs`) |
| **Serial Logs Ingress** | Subscribed | `traffic/junction1/logs` | Real-time firmware events, state transitions, and diagnostic logs |
| **Command Egress** | Published | `traffic/junction1/command` | Mode switches (`MODE ADAPTIVE`, `MODE FIXED`, `MODE MANUAL`), custom timings (`TIMING SET ...`), flashing caution (`FLASH_ORANGE`, `RESUME_AUTO`), emergency interlocks (`FAULT`, `CLEAR`, `NEXT`) |
| **Violations Ingress** | Subscribed | `traffic/junction1/violations` | Red-light camera alerts with radar speed, plate number, and approach |
| **Health Ingress** | Subscribed | `traffic/junction1/health` | Hardware heartbeat and diagnostic component flags |

---

## 🚦 Core Operator Features

1. **Interactive T-Junction Schematic & Signal Heads**:
   - Vector T-Junction schematic showing Main Road Arterial, Protected Left Turn, and Side Road Stem.
   - High-contrast LED lenses with authentic optical glows for all 5 signal heads.
   - Live remaining countdown timers updated directly from incoming telemetry.
2. **Adaptive Density & High-Traffic Priority Indicator**:
   - Visual dual-sensor indicators reflecting the hardware rules:
     - 0 sensors = 0% demand (idle / base rotation).
     - 1 sensor = 50% demand (10 seconds green allocation).
     - 2 sensors = 100% demand (20 seconds green allocation).
   - Dynamic priority banner and pulsing SVG beacons automatically highlighting the approach with highest congestion.
3. **Flashing Orange & Emergency Controls**:
   - 1-click **FLASH ORANGE** caution mode (1 Hz flashing amber on all approaches).
   - Instant **FAULT** engagement (interlocks intersection into safe state) and **CLEAR / RESET** recovery.
   - Manual **NEXT** step override for non-automatic phase advancing.
4. **Law Breakers CCTV & Violation Alerts**:
   - Dedicated panel displaying red-light infraction alerts, vehicle speed, approach, and timestamp.
5. **Bridge Event Log Terminal**:
   - Integrated live terminal displaying all inbound ESP32 serial lines and outbound operator commands with Copy & Clear functionality.
