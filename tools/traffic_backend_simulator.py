#!/usr/bin/env python3
"""
Smart Traffic Light MQTT Backend & Hardware Simulator
----------------------------------------------------
Simulates a full 4-way intersection (North, South, East, West) with:
- Adaptive Sensor-Driven Timing (0 sensors -> base 6s, 1 sensor -> 10s, 2 sensors -> 20s)
- Real-time Phase Countdowns & Lamp Outputs
- High-Traffic Lane Priority Detection
- Law-Breakers Red-Light Violation Alerts
- System Health Heartbeat & Fault Diagnostics
- Remote Command Ingestion (Mode toggles, manual timing updates)
"""

import json
import random
import subprocess
import sys
import threading
import time
from datetime import datetime

BROKER_HOST = "localhost"
BROKER_PORT = 1883

TOPICS = {
    "lights_status": "traffic/intersection1/lights/status",
    "sensors": "traffic/intersection1/sensors",
    "alerts_violations": "traffic/intersection1/alerts/violations",
    "health": "traffic/intersection1/health",
    "control_mode": "traffic/intersection1/control/mode",
    "control_timing": "traffic/intersection1/control/timing",
    "control_command": "traffic/intersection1/control/command",
}


class TrafficSimulationState:

  def __init__(self):
    self.mode = "ADAPTIVE"  # 'ADAPTIVE' or 'MANUAL'
    self.current_phase = "NS_GREEN"
    self.countdown_sec = 14
    self.prioritized_lane = "east"

    # Lane sensor detections: 2 sensors per lane
    self.sensors = {
        "north": {"s1": False, "s2": False},
        "south": {"s1": False, "s2": False},
        "east": {"s1": True, "s2": True},
        "west": {"s1": True, "s2": False},
    }

    # Signal lights per direction
    self.lights = {
        "north": {"color": "GREEN", "countdown": 14},
        "south": {"color": "GREEN", "countdown": 14},
        "east": {"color": "RED", "countdown": 18},
        "west": {"color": "RED", "countdown": 18},
    }

    # Timings
    self.base_adaptive_sec = 6
    self.manual_green_sec = 15
    self.orange_sec = 3
    self.red_clearance_sec = 2

    # Health
    self.health_status = "WARNING"
    self.faults = [
        "West Lane Sensor 1 Disconnected",
        "East Orange Lamp Burnt-out Warning",
    ]


def publish_mqtt(topic: str, payload_dict: dict):
  """Publish MQTT message using mosquitto_pub utility."""
  payload_json = json.dumps(payload_dict)
  cmd = [
      "mosquitto_pub",
      "-h",
      BROKER_HOST,
      "-p",
      str(BROKER_PORT),
      "-t",
      topic,
      "-m",
      payload_json,
  ]
  try:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
  except Exception as e:
    print(f"Error publishing to {topic}: {e}", file=sys.stderr)


def calculate_lane_green(state: TrafficSimulationState, lane: str) -> int:
  """Adaptive calculation rule:

  0 sensors triggered -> base time (6s)
  1 sensor triggered (50% congestion) -> 10s
  2 sensors triggered (100% congestion) -> 20s
  """
  count = (1 if state.sensors[lane]["s1"] else 0) + (
      1 if state.sensors[lane]["s2"] else 0
  )
  if count == 2:
    return 20
  elif count == 1:
    return 10
  return state.base_adaptive_sec


def evaluate_priority_lane(state: TrafficSimulationState):
  counts = {
      lane: (1 if state.sensors[lane]["s1"] else 0)
      + (1 if state.sensors[lane]["s2"] else 0)
      for lane in ["north", "south", "east", "west"]
  }
  best_lane = max(counts, key=counts.get)
  state.prioritized_lane = best_lane


def listener_thread(state: TrafficSimulationState):
  """Listen for incoming operator control commands."""
  cmd = [
      "mosquitto_sub",
      "-h",
      BROKER_HOST,
      "-p",
      str(BROKER_PORT),
      "-t",
      "traffic/intersection1/control/#",
      "-v",
  ]
  try:
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    for line in proc.stdout:
      parts = line.strip().split(" ", 1)
      if len(parts) == 2:
        topic, msg = parts[0], parts[1]
        try:
          data = json.loads(msg)
          print(f"[RECV COMMAND] {topic}: {data}")
          if topic == TOPICS["control_mode"]:
            if "mode" in data:
              state.mode = data["mode"]
              print(f"  -> Mode updated to {state.mode}")
          elif topic == TOPICS["control_timing"]:
            if "green_sec" in data:
              state.manual_green_sec = int(data["green_sec"])
            if "orange_sec" in data:
              state.orange_sec = int(data["orange_sec"])
            if "red_sec" in data:
              state.red_clearance_sec = int(data["red_sec"])
            print(
                f"  -> Manual timings updated: G={state.manual_green_sec}s,"
                f" O={state.orange_sec}s, R={state.red_clearance_sec}s"
            )
          elif topic == TOPICS["control_command"]:
            if data.get("command") == "EMERGENCY_ALL_RED":
              state.current_phase = "ALL_RED_1"
              state.countdown_sec = 30
              print("  -> EMERGENCY ALL-RED ENGAGED (30s hold)")
        except Exception as err:
          print(f"Failed parsing command payload: {err}")
  except Exception as e:
    print(f"Listener error: {e}")


def main():
  print("=" * 70)
  print("SMART TRAFFIC LIGHT MQTT SIMULATION BACKEND")
  print(f"Broker: {BROKER_HOST}:{BROKER_PORT}")
  print(
      "Publishing to: traffic/intersection1/lights/status, sensors, health,"
      " alerts/violations"
  )
  print("Subscribing to: traffic/intersection1/control/#")
  print("=" * 70)

  state = TrafficSimulationState()

  # Launch listener thread for remote control commands
  t = threading.Thread(target=listener_thread, args=(state,), daemon=True)
  t.start()

  sec_tick = 0
  next_violation_in = random.randint(12, 22)

  while True:
    time.sleep(1.0)
    sec_tick += 1
    state.countdown_sec -= 1

    # 1. State machine transition check
    if state.countdown_sec <= 0:
      if state.current_phase == "NS_GREEN":
        state.current_phase = "NS_YELLOW"
        state.countdown_sec = state.orange_sec
      elif state.current_phase == "NS_YELLOW":
        state.current_phase = "ALL_RED_1"
        state.countdown_sec = state.red_clearance_sec
      elif state.current_phase == "ALL_RED_1":
        state.current_phase = "EW_GREEN"
        if state.mode == "ADAPTIVE":
          ew_dur = max(
              calculate_lane_green(state, "east"),
              calculate_lane_green(state, "west"),
          )
          state.countdown_sec = ew_dur
        else:
          state.countdown_sec = state.manual_green_sec
      elif state.current_phase == "EW_GREEN":
        state.current_phase = "EW_YELLOW"
        state.countdown_sec = state.orange_sec
      elif state.current_phase == "EW_YELLOW":
        state.current_phase = "ALL_RED_2"
        state.countdown_sec = state.red_clearance_sec
      else:  # ALL_RED_2
        state.current_phase = "NS_GREEN"
        if state.mode == "ADAPTIVE":
          ns_dur = max(
              calculate_lane_green(state, "north"),
              calculate_lane_green(state, "south"),
          )
          state.countdown_sec = ns_dur
        else:
          state.countdown_sec = state.manual_green_sec

      evaluate_priority_lane(state)

    # 2. Derive lamp colors per direction
    is_ns_green = state.current_phase == "NS_GREEN"
    is_ns_yellow = state.current_phase == "NS_YELLOW"
    is_ew_green = state.current_phase == "EW_GREEN"
    is_ew_yellow = state.current_phase == "EW_YELLOW"

    state.lights["north"]["color"] = (
        "GREEN" if is_ns_green else ("ORANGE" if is_ns_yellow else "RED")
    )
    state.lights["south"]["color"] = (
        "GREEN" if is_ns_green else ("ORANGE" if is_ns_yellow else "RED")
    )
    state.lights["east"]["color"] = (
        "GREEN" if is_ew_green else ("ORANGE" if is_ew_yellow else "RED")
    )
    state.lights["west"]["color"] = (
        "GREEN" if is_ew_green else ("ORANGE" if is_ew_yellow else "RED")
    )

    state.lights["north"]["countdown"] = state.countdown_sec
    state.lights["south"]["countdown"] = state.countdown_sec
    state.lights["east"]["countdown"] = state.countdown_sec
    state.lights["west"]["countdown"] = state.countdown_sec

    # 3. Publish Status Payload every second
    status_payload = {
        "intersection_id": "INT-01",
        "timestamp": datetime.now().isoformat(),
        "current_phase": state.current_phase,
        "mode": state.mode,
        "countdown_sec": state.countdown_sec,
        "lights": state.lights,
    }
    publish_mqtt(TOPICS["lights_status"], status_payload)

    # 4. Publish Sensors Telemetry every 2 seconds
    if sec_tick % 2 == 0:

      def get_pct(lane):
        count = (1 if state.sensors[lane]["s1"] else 0) + (
            1 if state.sensors[lane]["s2"] else 0
        )
        return 100 if count == 2 else (50 if count == 1 else 0)

      sensors_payload = {
          "intersection_id": "INT-01",
          "timestamp": datetime.now().isoformat(),
          "lanes": {
              lane: {
                  "sensors_active": (1 if state.sensors[lane]["s1"] else 0)
                  + (1 if state.sensors[lane]["s2"] else 0),
                  "congestion_pct": get_pct(lane),
                  "sensor_1": state.sensors[lane]["s1"],
                  "sensor_2": state.sensors[lane]["s2"],
                  "calculated_green_sec": calculate_lane_green(state, lane),
              }
              for lane in ["north", "south", "east", "west"]
          },
          "prioritized_lane": state.prioritized_lane,
          "priority_reason": (
              f"Highest traffic volume ({get_pct(state.prioritized_lane)}%)"
          ),
      }
      publish_mqtt(TOPICS["sensors"], sensors_payload)

    # 5. Publish Health Payload every 3 seconds
    if sec_tick % 3 == 0:
      health_payload = {
          "intersection_id": "INT-01",
          "timestamp": datetime.now().isoformat(),
          "status": state.health_status,
          "heartbeat_ms": random.randint(38, 55),
          "uptime": "99.8%",
          "faults": state.faults,
      }
      publish_mqtt(TOPICS["health"], health_payload)

    # 6. Occasional Red-Light Runner Violation
    next_violation_in -= 1
    if next_violation_in <= 0:
      next_violation_in = random.randint(20, 35)
      plates = ["XYZ-4491", "KBC-1928", "TX-8910", "RAD-2045", "DL-9081"]
      lanes = ["west", "east", "south", "north"]
      red_lane = random.choice(lanes)

      violation_payload = {
          "violation_id": f"VIO-{int(time.time())}",
          "timestamp": datetime.now().strftime("%H:%M:%S"),
          "type": "RED_LIGHT_RUNNER",
          "lane": red_lane,
          "speed_kmh": round(random.uniform(62.0, 88.5), 1),
          "speed_limit_kmh": 50.0,
          "plate_number": random.choice(plates),
          "vehicle_color": random.choice(["Silver", "Black", "Red", "Blue"]),
          "vehicle_type": random.choice(["Sedan", "SUV", "Pickup"]),
          "fine_status": "FLAGGED_FOR_REVIEW",
      }
      publish_mqtt(TOPICS["alerts_violations"], violation_payload)
      print(
          f"[VIOLATION DETECTED] Plate={violation_payload['plate_number']} on"
          f" {red_lane} lane @ {violation_payload['speed_kmh']} km/h"
      )


if __name__ == "__main__":
  try:
    main()
  except KeyboardInterrupt:
    print("\nSimulator stopped.")

