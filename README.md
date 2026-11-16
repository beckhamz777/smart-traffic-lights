# ESP32 Smart Traffic Light Controller & MQTT Control System

[![PlatformIO](https://img.shields.io/badge/PlatformIO-ESP32-orange.svg)](https://platformio.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Framework: Arduino](https://img.shields.io/badge/Framework-Arduino-green.svg)](https://www.arduino.cc/)
[![MQTT: Mosquitto](https://img.shields.io/badge/MQTT-Mosquitto-3C5280.svg)](https://mosquitto.org/)

An embedded, non-blocking **Adaptive Smart Traffic Light Controller** built for the ESP32 microcontroller using C++ on PlatformIO, paired with a **Web Serial-to-MQTT Bridge** and an independent **Traffic Control Center** for remote operations, traffic density allocation, and centralized log collection across Linux and Windows.

---

## 🚦 System Architecture (Web App + MQTT Broker + Control Center)

```
+----------------------+       USB Serial        +------------------------------------------+
|    ESP32 Hardware    | <=====================> |  Web Bridge (tools/demo_dashboard.html)  |
|  (TrafficController) |      (115200 baud)      |  - Web Serial USB interface              |
+----------------------+                         |  - Traffic Density Gauges (0/50/100%)    |
                                                 |  - FIXED & FLASH ORANGE quick modes      |
                                                 |  - Publishes telemetry & logs to MQTT    |
                                                 +--------------------+---------------------+
                                                                      |
                                                       MQTT over WebSockets (Port 9001)
                                                                      |
                                                                      v
                                                 +------------------------------------------+
                                                 |     Eclipse Mosquitto MQTT Broker        |
                                                 |  - Port 1883: Standard MQTT              |
                                                 |  - Port 9001: WebSockets                 |
                                                 +--------------------+---------------------+
                                                                      |
                                                       MQTT over WebSockets / TCP
                                                                      |
                                                                      v
                                                 +------------------------------------------+
                                                 | Control Center (tools/control_center.html)|
                                                 |  - Works in ANY browser (Linux/Windows)  |
                                                 |  - Subscribes: telemetry & logs          |
                                                 |  - Publishes: remote control commands    |
                                                 |  - Exports collected .log files          |
                                                 +------------------------------------------+
```

### MQTT Topics
- **`traffic/junction1/telemetry`** *(Bridge &rarr; Control Center)*: Structured JSON containing FSM state, operating mode, lamp states, and sensor density (`0%`, `50% = 10s`, `100% = 20s`).
- **`traffic/junction1/logs`** *(Bridge &rarr; Control Center)*: Raw timestamped serial log lines from the ESP32.
- **`traffic/junction1/command`** *(Control Center &rarr; Bridge &rarr; ESP32)*: Remote commands (`MODE AUTO`, `MODE FIXED`, `MODE ACTUATED`, `MODE ADAPTIVE`, `MODE MANUAL`, `NEXT`, `PED 1`, `CAR MAIN ON`, `FLASH_ORANGE`, `RESUME_AUTO`, `STATUS`, `RESET`).

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
- **Priority & Fairness**: Highest density (`100%`) receives priority service; equal densities receive equal green time via Round-Robin fairness.

### 3. Operating Modes & Maintenance Bypass
- **`AUTO`**, **`FIXED`**, **`ACTUATED`**, **`ADAPTIVE`**, **`MANUAL`**
- **`FREE / MAINTAIN (Flash Orange)`**: 1 Hz pulsing amber caution mode across the intersection.

---

## 🚀 Quick Start Guide

### Step 1: Start the Mosquitto MQTT Broker
Using Docker:
```bash
cd mqtt
docker compose up -d
```
Or native Mosquitto:
- **Linux**: `sudo apt install mosquitto && mosquitto -c mqtt/mosquitto.conf -v`
- **Windows**: Install Eclipse Mosquitto, then run `"C:\Program Files\mosquitto\mosquitto.exe" -c mqtt\mosquitto.conf -v`

This opens **port `1883`** (standard MQTT) and **port `9001`** (WebSockets).

### Step 2: Open the Web Serial-to-MQTT Bridge
1. Plug the ESP32 into your Linux or Windows PC via USB.
2. Open [`tools/demo_dashboard.html`](tools/demo_dashboard.html) in **Google Chrome** or **Microsoft Edge**.
3. Click **`Connect ESP32`** to connect over USB Serial (`115200` baud).
4. Click **`Connect MQTT`** (default `ws://localhost:9001`) to start bridging ESP32 telemetry/logs to MQTT and forwarding remote commands to the ESP32.

### Step 3: Open the Remote Traffic Control Center
1. On any Linux or Windows machine (any browser), open [`tools/control_center.html`](tools/control_center.html).
2. Enter `ws://localhost:9001` (or `ws://<broker-ip>:9001` from another computer on the network) and click **`Connect MQTT`**.
3. Monitor live intersection lights, sensor density, and collected logs, or send remote commands to control the traffic lights.

---

## 🛠️ Hardware Pinout (ESP32)

| Channel | GPIO Pin | Function |
| :--- | :---: | :--- |
| **MAIN RED / YELLOW / GREEN** | `25, 26, 27` | Main Road Signal Group |
| **SIDE RED / YELLOW / GREEN** | `14, 12 (or 5), 13` | Side Road Signal Group |
| **TURN RED / YELLOW / GREEN** | `21, 22, 23` | Protected Turn Signal Group |
| **PED 1 WALK / DONT_WALK** | `19 / 18` | Pedestrian Crossing 1 |
| **PED 2 WALK / DONT_WALK** | `17 / 16` | Pedestrian Crossing 2 |
| **PED 1 / PED 2 BUTTONS** | `32 / 4` | Pedestrian Call Buttons |
| **VEHICLE IR SENSORS 1–6** | `33, 34, 35, 36, 39, 15` | IR Vehicle Presence Inputs |

---

## 📖 Documentation
- [Traffic Phase & Conflict Matrix Guide](docs/TRAFFIC_PHASE_AND_CONFLICT_MATRIX.md)
- [Full Traffic Control Architecture](docs/FULL_TRAFFIC_CONTROL_ARCHITECTURE.md)
- [ESP32 Final GPIO Assignment](docs/ESP32_FINAL_GPIO_ASSIGNMENT.md)

## 📄 License
This project is licensed under the [MIT License](LICENSE).
