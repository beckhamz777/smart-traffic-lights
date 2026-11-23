#!/usr/bin/env python3
"""
Lightweight Serial-to-WebSocket Bridge for tools/demo_dashboard.html (?bridge=true)
Listens on ws://127.0.0.1:8081 and bridges bidirectional bytes to ESP32 serial.
Uses only Python stdlib + pyserial (avoids Chrome Linux Web Serial cp210x bugs).
"""

import argparse
import asyncio
import base64
import glob
import hashlib
import struct
import sys
import serial

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def open_available_serial(preferred: str | None, baud: int) -> serial.Serial | None:
    candidates = [preferred] if preferred else sorted(glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*"))
    for cand in candidates:
        if not cand:
            continue
        try:
            ser = serial.Serial()
            ser.port = cand
            ser.baudrate = baud
            ser.timeout = 0
            # Keep DTR/RTS low on open to avoid resetting ESP32 or causing CP210x brownout spikes
            ser.dtr = False
            ser.rts = False
            ser.open()
            print(f"[BRIDGE] Opened {cand} at {baud} baud")
            return ser
        except Exception as e:
            print(f"[BRIDGE] Could not open {cand}: {e}", file=sys.stderr)
    return None


def encode_ws_frame(payload: bytes, opcode: int = 0x2) -> bytes:
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + payload


async def read_ws_frame(reader: asyncio.StreamReader):
    hdr = await reader.readexactly(2)
    opcode = hdr[0] & 0x0F
    masked = (hdr[1] & 0x80) != 0
    length = hdr[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await reader.readexactly(8))[0]
    mask_key = await reader.readexactly(4) if masked else b""
    data = bytearray(await reader.readexactly(length))
    if masked:
        for i in range(length):
            data[i] ^= mask_key[i % 4]
    return opcode, bytes(data)


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, state: dict, clients: set):
    try:
        req = await reader.readuntil(b"\r\n\r\n")
        headers = {}
        for line in req.decode("utf-8", errors="ignore").split("\r\n")[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        ws_key = headers.get("sec-websocket-key")
        if not ws_key:
            writer.close()
            return

        accept = base64.b64encode(hashlib.sha1((ws_key + WS_MAGIC).encode()).digest()).decode()
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        )
        writer.write(resp.encode())
        await writer.drain()

        clients.add(writer)
        print(f"[BRIDGE] Dashboard connected ({len(clients)} active)")

        while True:
            opcode, payload = await read_ws_frame(reader)
            if opcode == 0x8:  # Close
                break
            elif opcode == 0x9:  # Ping -> Pong
                writer.write(encode_ws_frame(payload, opcode=0xA))
                await writer.drain()
            elif opcode in (0x1, 0x2):  # Text or Binary -> Serial
                ser = state.get("ser")
                if ser and ser.is_open:
                    try:
                        ser.write(payload)
                        ser.flush()
                    except Exception as e:
                        print(f"[BRIDGE] Serial write error: {e}", file=sys.stderr)
                        try:
                            ser.close()
                        except Exception:
                            pass
                        state["ser"] = None
    except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
        pass
    finally:
        clients.discard(writer)
        try:
            writer.close()
        except Exception:
            pass
        print(f"[BRIDGE] Dashboard disconnected ({len(clients)} active)")


async def serial_pump(state: dict, preferred_port: str | None, baud: int, clients: set):
    while True:
        ser = state.get("ser")
        if ser is None or not ser.is_open:
            ser = open_available_serial(preferred_port, baud)
            state["ser"] = ser
            if ser is None:
                await asyncio.sleep(1.0)
                continue
        try:
            waiting = ser.in_waiting
            data = ser.read(waiting if waiting > 0 else 1)
            if data and clients:
                frame = encode_ws_frame(data, opcode=0x2)
                dead = []
                for w in list(clients):
                    try:
                        w.write(frame)
                        await w.drain()
                    except Exception:
                        dead.append(w)
                for w in dead:
                    clients.discard(w)
            else:
                await asyncio.sleep(0.01)
        except Exception as e:
            print(f"[BRIDGE] Serial read error (re-scanning): {e}", file=sys.stderr)
            try:
                ser.close()
            except Exception:
                pass
            state["ser"] = None
            await asyncio.sleep(0.5)


async def main_async(preferred_port: str | None, baud: int, host: str, ws_port: int):
    state = {"ser": open_available_serial(preferred_port, baud)}
    clients: set = set()
    server = await asyncio.start_server(
        lambda r, w: handle_client(r, w, state, clients), host, ws_port
    )
    print(f"[BRIDGE] WebSocket serial bridge listening on ws://{host}:{ws_port}")
    print(f"[BRIDGE] Open: http://localhost:8080/tools/demo_dashboard.html")
    async with server:
        await asyncio.gather(server.serve_forever(), serial_pump(state, preferred_port, baud, clients))


def main():
    parser = argparse.ArgumentParser(description="ESP32 Serial-to-WebSocket Bridge")
    parser.add_argument("--port", default=None, help="Serial port (default: auto-detect /dev/ttyUSB* or /dev/ttyACM*)")
    parser.add_argument("--baud", type=int, default=115200, help="Baud rate (default: 115200)")
    parser.add_argument("--host", default="127.0.0.1", help="WebSocket bind host")
    parser.add_argument("--ws-port", type=int, default=8081, help="WebSocket port (default: 8081)")
    args = parser.parse_args()

    try:
        asyncio.run(main_async(args.port, args.baud, args.host, args.ws_port))
    except KeyboardInterrupt:
        print("\n[BRIDGE] Stopped.")


if __name__ == "__main__":
    main()

