# ESP32 Smart Traffic Light Controller & Control Center

[![PlatformIO](https://img.shields.io/badge/PlatformIO-ESP32-orange.svg)](https://platformio.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Framework: Arduino](https://img.shields.io/badge/Framework-Arduino-green.svg)](https://www.arduino.cc/)
[![Desktop: Electron](https://img.shields.io/badge/Desktop-Electron-47848F.svg)](https://www.electronjs.org/)

An embedded, non-blocking **Adaptive Smart Traffic Light Controller** built for the ESP32 microcontroller using C++ on PlatformIO, paired with a cross-platform **Desktop Control Center App** (Linux & Windows) for real-time monitoring, USB serial telemetry, traffic density estimation, and persistent session logging.

---

## 🚦 System Architecture

```
+---------------------------------------------------------------------------------+
|                       SMART TRAFFIC CONTROL CENTER APP                          |
|                       (Desktop Window on Linux & Windows)                       |
|                                                                                 |
|  +---------------------------------------------------------------------------+  |
|  | Dashboard UI                                                              |  |
|  | - Live junction rendering, timers, buttons, command console               |  |
|  | - Traffic Density Gauges (0%, 50%, 100%) & Dynamic Green Allocator        |  |
|  +---------------------------------------------------------------------------+  |
|                                       |                                         |
|                                       v                                         |
|  +---------------------------------------------------------------------------+  |
|  | Native Integration Layer (Electron main process)                          |  |
|  | 1. Auto-selects USB Serial port (CP210x / CH340 / FTDI / Espressif)       |  |
|  | 2. Background persistence (no tab sleep or drift when minimized)          |  |
|  | 3. Writes continuous log files to disk (logs/traffic_session_*.log)        |  |
|  +---------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------+
                                        ^
                                        | USB Serial (115200 baud)
                                        v
+---------------------------------------------------------------------------------+
|                       ESP32 FIRMWARE (src/main.cpp)                             |
|                                                                                 |
|  [VehicleDetector]      [PedestrianController]    [DemandManager]               |
|  - 6 IR channels        - 2 button channels       - Queue counting              |
|  - 100ms noise filter   - 50ms debouncer          - Wait timing                 |
|  - Stuck sensor filter  - Latching & clearance    - Adaptive score              |
|                                                                                 |
|  [TrafficPhaseManager]  [ConfigurationStorage]    [FaultManager]                |
|  - Keep-Right matrix    - ESP32 NVS (Preferences) - Invariant check             |
|  - Protected turn gate  - FNV-1a checksums        - Bitmask faults              |
+---------------------------------------------------------------------------------+
```

---

## 🌟 Key Features

### 1. Embedded Traffic Controller (ESP32 Firmware)
- **Non-blocking FSM**: 100% `millis()`-driven finite state machine (`STARTUP_SAFE`, `ALL_RED`, `MAIN_GREEN`/`YELLOW`, `SIDE_GREEN`/`YELLOW`, `TURN_GREEN`/`YELLOW`, `PED_WALK`, `FAULT_SAFE`).
- **Conflict Matrix Safety**: Strict mathematical conflict matrix prevents opposing green lights. Conflicting green combinations automatically trip into `FAULT_SAFE`.
- **Right-Hand Traffic Rules**: Designed for Keep-Right junction geometry with protected turning lane gating.
- **Pedestrian Safety Clearance**: Dedicated pedestrian walk phases followed by vehicle all-red clearance intervals.
- **Sensor Conditioning**: 100 ms debounce, 30-second stuck-sensor auto-isolation, and 1-second chatter suppression across all 6 IR channels.

### 2. Traffic Density & Dynamic Green Time Allocation
- **Approach Gauges**: Independent density tracking for Main Road, Side Road, and Protected Turn.
- **Dynamic Timing Policy**:
  - **`0%` (0 sensors active)**: Idle / Minimum standby.
  - **`50%` (1 sensor active)**: Moderate traffic &rarr; **10 seconds** allocated green.
  - **`100%` (2 sensors active)**: Heavy traffic &rarr; **20 seconds** allocated green.
- **Priority Logic**: The traffic approach with 100% density receives priority service before an approach with 50%.
- **Fairness Guarantee**: When multiple approaches have equal density (both 100% or both 50%), equal green time is allocated with round-robin fairness.

### 3. Controller Operating Modes
- **`AUTO`**: Fully adaptive round-robin responding to vehicle demand.
- **`FIXED`**: Deterministic fixed-time cycle.
- **`ACTUATED`**: Green extensions based on real-time vehicle gap detection up to `maxGreenMs`.
- **`ADAPTIVE`**: Real-time scoring based on queue lengths, waiting times, and anti-starvation bonuses.
- **`MANUAL`**: Operator step-by-step advance via `NEXT` command, while preserving mandatory yellow and all-red clearance safety intervals.
- **`FREE / MAINTAIN (Flash Orange)`**: 1 Hz pulsing amber caution mode across the entire intersection for maintenance or bypass.

### 4. Cross-Platform Desktop Control Center (Linux & Windows)
- Runs as a standalone desktop application via Electron.
- Auto-detects ESP32 USB COM ports without browser popups.
- Automatically saves all session logs to disk (`logs/traffic_session_*.log`) with a one-click **📁 Open Logs Folder** button.

---

## 🛠️ Hardware Pinout (ESP32)

| Channel | GPIO Pin | Function |
| :--- | :---: | :--- |
| **MAIN RED** | `GPIO 25` | Main Road Red Lamp |
| **MAIN YELLOW** | `GPIO 26` | Main Road Yellow Lamp |
| **MAIN GREEN** | `GPIO 27` | Main Road Green Lamp |
| **SIDE RED** | `GPIO 14` | Side Road Red Lamp |
| **SIDE YELLOW** | `GPIO 12` (or `5`) | Side Road Yellow Lamp |
| **SIDE GREEN** | `GPIO 13` | Side Road Green Lamp |
| **TURN RED** | `GPIO 21` | Protected Turn Red Lamp |
| **TURN YELLOW** | `GPIO 22` | Protected Turn Yellow Lamp |
| **TURN GREEN** | `GPIO 23` | Protected Turn Green Lamp |
| **PED 1 WALK / DONT_WALK** | `GPIO 19` / `GPIO 18` | Pedestrian Crossing 1 (Green / Red) |
| **PED 2 WALK / DONT_WALK** | `GPIO 17` / `GPIO 16` | Pedestrian Crossing 2 (Green / Red) |
| **PED 1 / PED 2 BUTTONS** | `GPIO 32` / `GPIO 4` | Pedestrian Call Buttons (Input Pullup) |
| **VEHICLE IR SENSORS 1–6** | `33, 34, 35, 36, 39, 15` | IR Vehicle Presence Inputs |

---

## 🚀 Quick Start Guide

### 1. Flash the ESP32 Firmware
Ensure you have [PlatformIO](https://platformio.org/) installed:
```bash
# Build the firmware
pio run

# Upload to connected ESP32
pio run --target upload

# Run automated unit tests
pio test
```

### 2. Launch the Desktop Control Center App
Ensure you have [Node.js](https://nodejs.org/) installed:
```bash
# Install dependencies
npm install

# Start the Control Center Desktop App
npm start
```

### 3. Build Standalone Installers (`.exe` / `.AppImage`)
```bash
# Build Windows .exe installer and portable binary
npm run build:win

# Build Linux .AppImage
npm run build:linux
```

---

## 📖 Documentation
- [Traffic Phase & Conflict Matrix Guide](docs/TRAFFIC_PHASE_AND_CONFLICT_MATRIX.md)
- [Full Traffic Control Architecture](docs/FULL_TRAFFIC_CONTROL_ARCHITECTURE.md)
- [ESP32 Final GPIO Assignment](docs/ESP32_FINAL_GPIO_ASSIGNMENT.md)
- [Desktop App User & Developer Guide](docs/CONTROL_CENTER_APP_GUIDE.md)

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
