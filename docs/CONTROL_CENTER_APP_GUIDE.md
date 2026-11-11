# Smart Traffic Control Center — Desktop App & Logging Guide

This document explains how to run, use, and package the **Smart Traffic Control Center Desktop App** across Linux and Windows.

---

## 1. Overview & Features

The Control Center Desktop App wraps the traffic light controller interface into a native, cross-platform desktop application powered by Electron. It includes:

1. **Auto USB Serial Port Approval**:
   - Automatically detects and binds to ESP32 USB COM ports (Silicon Labs CP210x, CH340, FTDI, Espressif) without browser permission popups.
2. **Background Persistence**:
   - Configured with `backgroundThrottling: false`, ensuring serial polling and traffic timers never sleep or drift when minimized.
3. **Continuous Local File Logging**:
   - Automatically writes every telemetry update, console event, and user action to disk in `logs/traffic_session_YYYY-MM-DD_HH-mm-ss.log`.
   - Includes a one-click **📁 Open Logs Folder** button in the header.
4. **Traffic Density & Dynamic Green Time Allocation Engine**:
   - Visual gauges showing density percentages per approach:
     - **0% (0 sensors triggered)**: Idle / Standby.
     - **50% (1 sensor triggered)**: Moderate traffic &rarr; Allocates **10 seconds** green time.
     - **100% (2 sensors triggered)**: Heavy traffic &rarr; Allocates **20 seconds** green time.
   - **Priority Logic**: The traffic side with 100% density is served first before a side with 50%.
   - **Fairness Logic**: When sides have equal traffic (both 100% or both 50%), they receive equal green time (20s or 10s respectively) via Round-Robin fairness.
   - Interactive `IR1` &ndash; `IR6` toggle buttons allow simulating or testing each sensor independently.
5. **Quick Mode Controls**:
   - **AUTO Mode**: Fully adaptive traffic allocation.
   - **FIXED Mode**: Fixed-time cyclic scheduling.
   - **ACTUATED Mode**: Extends green while vehicles are detected up to max green.
6. **Free-Flow / Maintenance Mode (Flashing Amber/Orange)**:
   - Dedicated button `⚠️ FREE / MAINTAIN (Flash Orange)`.
   - Flashes all intersection yellow lights at 1 Hz for maintenance or free traffic flow, with a prominent alert banner and a one-click button to resume normal automatic control.

---

## 2. Quick Start

### Prerequisites
- Node.js (v18 or higher) and npm installed.

### Run on Linux
Open a terminal in the project directory:
```bash
# 1. Install dependencies
npm install

# 2. Launch the Control Center App
npm start
```

### Run on Windows
Open PowerShell or Command Prompt in the project folder:
```powershell
# 1. Install dependencies
npm install

# 2. Launch the Control Center App
npm start
```

---

## 3. Creating Standalone Installers (`.exe` / `.AppImage`)

To distribute the app to colleagues who do not have Node.js installed:

### For Windows (`.exe` installer & portable binary)
From Windows (or via wine on Linux):
```bash
npm run build:win
```
The output `TrafficControlCenter Setup.exe` and portable `.exe` will be located in the `dist/` folder.

### For Linux (`.AppImage` / `tar.gz`)
```bash
npm run build:linux
```
The output `.AppImage` will be located in the `dist/` folder. Make it executable (`chmod +x TrafficControlCenter.AppImage`) and double-click to launch.

---

## 4. Log File Storage

- All session logs are stored locally in the `logs/` directory inside the project root.
- Log entries are timestamped with millisecond precision:
  ```
  [2026-11-11T08:30:15.120Z] === ESP32 Smart Traffic Control Center Session Started ===
  [2026-11-11T08:30:15.122Z] Auto-selecting USB Serial Port: /dev/ttyUSB0 (VID: 0x10C4, PID: 0xEA60)
  [2026-11-11T08:30:16.450Z] [TEL:FSM] State: MAIN_GREEN | Elapsed: 4200 ms | Demands: MAIN=0, SIDE=1
  [2026-11-11T08:30:20.100Z] [DENSITY:MAIN] Density updated to 100% (20s allocated).
  ```
- Click **📁 Open Logs Folder** in the top navigation bar to access the active directory.

