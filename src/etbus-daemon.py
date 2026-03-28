#!/usr/bin/env python3
"""
Kate ET-Bus Device — Pure ET-Bus, no MQTT.
- Joins multicast 239.10.0.1:5555
- Responds to hub pings with encrypted pong (stays online in HA)
- Sends encrypted state every 10s (sensors in HA)
- Receives encrypted commands from HA, sends to Kate API
- Sends encrypted response back via state update
- Reports: cpu, memory, disk, load, temp, processes, ollama, skills, tools
"""

import asyncio
import hashlib
import json
import os
import socket
import struct
import subprocess
import time
from base64 import b64encode, b64decode

try:
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
except ImportError:
    print("Run: pip install cryptography --break-system-packages")
    exit(1)

# ── Config ──────────────────────────────────────────────────
MCAST_IP    = "239.10.0.1"
PORT        = 5555
KATE_ID     = "kate_ai"
KATE_CLASS  = "sensor.kate_ai"
KATE_NAME   = "Kate AI Agent"
KID         = 1
PSK_HEX     = "b6f0c3d7a12e4f9c8d77e0b35b9a6c1f4b2a3e19c0d4f8a1b7c2d9e3f4a5b6c7"
HA_IP       = "172.168.1.8"
KATE_API    = "http://localhost:3201/api/message"
STATE_FILE  = os.path.expanduser("~/.kate/etbus-state.json")

# ── Crypto ──────────────────────────────────────────────────
PSK = bytes.fromhex(PSK_HEX)
KEY = hashlib.sha256(PSK + KATE_ID.encode("utf-8")).digest()
aead = ChaCha20Poly1305(KEY)

tx_ctr = int(time.time())
rx_last_ctr = 0
hub_ip = HA_IP
hub_port = PORT
hub_known = False
last_pong = 0
start_time = time.time()


def encrypt(plain_dict):
    global tx_ctr
    tx_ctr += 1
    nonce = b"\x00\x00\x00\x00" + tx_ctr.to_bytes(8, "little")
    pt = json.dumps(plain_dict, separators=(",", ":")).encode("utf-8")
    out = aead.encrypt(nonce, pt, None)
    ct, tag = out[:-16], out[-16:]
    return {
        "_enc": 1, "kid": KID, "ctr": tx_ctr,
        "nonce": b64encode(nonce).decode(),
        "ct": b64encode(ct).decode(),
        "tag": b64encode(tag).decode(),
    }


def decrypt(wrapper):
    try:
        nonce = b64decode(wrapper["nonce"])
        ct = b64decode(wrapper["ct"])
        tag = b64decode(wrapper["tag"])
        pt = aead.decrypt(nonce, ct + tag, None)
        return json.loads(pt.decode("utf-8"))
    except Exception as e:
        print(f"[DECRYPT ERROR] {e}")
        return None


# ── State ───────────────────────────────────────────────────

import urllib.request, json as _json

def get_kate_stats():
    """Query Kate's live API for real skill/tool counts"""
    try:
        with urllib.request.urlopen("http://localhost:3201/api/tools", timeout=3) as r:
            tools = len(_json.loads(r.read()))
    except: tools = 0
    try:
        with urllib.request.urlopen("http://localhost:3201/api/skills", timeout=3) as r:
            skills = len(_json.loads(r.read()))
    except: skills = 0
    return skills, tools

state = {
    "status": "online",
    "skills": 0,
    "tools": 0,
    "last_command": "",
    "last_response": "",
    "uptime": 0,
    "requests": 0,
    "errors": 0,
    "cpu": 0,
    "memory": 0,
    "disk": 0,
    "load": 0.0,
    "temp": 0,
    "processes": 0,
    "ollama": "unknown",
}


def load_state():
    global state
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                saved = json.load(f)
                state.update(saved)
    except Exception:
        pass
    state["uptime"] = int(time.time() - start_time)


def save_state():
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


# ── Socket ──────────────────────────────────────────────────
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("", PORT))
mreq = struct.pack("4s4s", socket.inet_aton(MCAST_IP), socket.inet_aton("0.0.0.0"))
sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
sock.setblocking(False)


def udp_send(ip, port, msg):
    data = json.dumps(msg, separators=(",", ":")).encode("utf-8")
    try:
        sock.sendto(data, (ip, port))
    except Exception:
        pass


# ── Protocol Messages ───────────────────────────────────────
def send_pong():
    load_state()
    payload = encrypt({**state, "name": KATE_NAME, "fw": "1.0.0"})
    msg = {"v": 1, "type": "pong", "id": KATE_ID, "class": KATE_CLASS, "payload": payload}
    udp_send(hub_ip, hub_port, msg)
    print(f"[PONG] → {hub_ip}:{hub_port}")


def send_state_update():
    load_state()
    payload = encrypt(state)
    msg = {"v": 1, "type": "state", "id": KATE_ID, "class": KATE_CLASS, "payload": payload}
    udp_send(hub_ip, hub_port, msg)


def send_discover():
    load_state()
    disco = {
        **state,
        "name": KATE_NAME,
        "manufacturer": "OpenClaw",
        "model": "Kate v1.0",
        "fw": "1.0.0",
    }
    payload = encrypt(disco)
    msg = {"v": 1, "type": "state", "id": KATE_ID, "class": KATE_CLASS, "payload": payload}
    # Send to both multicast and direct to hub
    udp_send(MCAST_IP, PORT, msg)
    udp_send(hub_ip, hub_port, msg)
    print(f"[DISCOVER] → multicast + {hub_ip}")


# ── Command Processing ──────────────────────────────────────
async def process_command(cmd_text, sender):
    """Send command to Kate's web API and return response."""
    print(f"[CMD] from {sender}: {cmd_text[:80]}")

    state["last_command"] = cmd_text[:200]
    state["status"] = "busy"
    state["requests"] = state.get("requests", 0) + 1
    save_state()
    send_state_update()

    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "-m", "120",
            "-X", "POST", KATE_API,
            "-H", "Content-Type: application/json",
            "-d", json.dumps({"content": cmd_text}),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
        result = stdout.decode().strip()

        try:
            data = json.loads(result)
            response = data.get("response", result[:500])
        except Exception:
            response = result[:500] if result else "No response from Kate"

    except asyncio.TimeoutError:
        response = "Kate timed out processing the request."
        state["errors"] = state.get("errors", 0) + 1
    except Exception as e:
        response = f"Error: {e}"
        state["errors"] = state.get("errors", 0) + 1

    print(f"[RESP] {response[:80]}")

    state["last_response"] = response[:200]
    state["status"] = "online"
    save_state()
    send_state_update()

    return response


# ── RX Loop ─────────────────────────────────────────────────
async def rx_loop():
    global hub_ip, hub_port, hub_known, last_pong
    loop = asyncio.get_running_loop()

    def _blocking_rx():
        """Run in thread — blocking recv works better with multicast."""
        import select
        while True:
            try:
                ready, _, _ = select.select([sock], [], [], 1.0)
                if not ready:
                    continue
                data, addr = sock.recvfrom(8192)
                loop.call_soon_threadsafe(_handle_packet, data, addr)
            except Exception as e:
                time.sleep(0.1)

    def _handle_packet(data, addr):
        global hub_ip, hub_port, hub_known, last_pong

        try:
            msg = json.loads(data.decode("utf-8"))
        except Exception:
            return

        v = msg.get("v", 0)
        mtype = msg.get("type", "")
        dev_id = msg.get("id", "")


        if v != 1 or not mtype or not dev_id:
            return
        if dev_id == KATE_ID:
            return

        if dev_id == "hub":
            hub_ip = addr[0]
            if mtype == "ping":
                hub_port = (msg.get("payload") or {}).get("port", PORT)
            hub_known = True

        # COMMANDS first
        if mtype == "command":
            payload = msg.get("payload", {})
            if isinstance(payload, dict) and payload.get("_enc") == 1:
                decrypted = decrypt(payload)
                if decrypted is None:
                    print(f"[CMD DECRYPT FAIL] from {dev_id}")
                    return
                payload = decrypted

            cmd = payload.get("command") or payload.get("message") or payload.get("text") or ""
            if cmd:
                print(f"[CMD] from {dev_id}: {cmd[:80]}")
                asyncio.run_coroutine_threadsafe(process_command(cmd, dev_id), loop)
            return

        # PINGS
        if mtype == "ping":
            now = time.time()
            if now - last_pong > 2:
                send_pong()
                last_pong = now

    import threading
    t = threading.Thread(target=_blocking_rx, daemon=True)
    t.start()
    print("[RX] Threaded receiver started")

    # Keep the coroutine alive
    while True:
        await asyncio.sleep(60)


# ── State broadcast loop ────────────────────────────────────
async def state_loop():
    send_discover()
    await asyncio.sleep(2)
    send_state_update()

    while True:
        await asyncio.sleep(10)
        send_state_update()


# ── System stats loop ───────────────────────────────────────
async def stats_loop():
    while True:
        await asyncio.sleep(30)
        try:
            r = lambda c: subprocess.check_output(c, shell=True, timeout=5).decode().strip()

            try:
                state["cpu"] = round(float(r("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'")))
            except Exception:
                pass

            try:
                state["memory"] = round(float(r("free | grep Mem | awk '{print ($3/$2)*100}'")))
            except Exception:
                pass

            try:
                state["disk"] = round(float(r("df / | tail -1 | awk '{print $5}' | tr -d '%'")))
            except Exception:
                pass

            try:
                state["load"] = round(float(r("cat /proc/loadavg | awk '{print $1}'")), 1)
            except Exception:
                pass

            try:
                state["temp"] = round(float(r("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null")) / 1000, 1)
            except Exception:
                state["temp"] = 0

            try:
                state["processes"] = int(r("ps aux | wc -l"))
            except Exception:
                pass

            try:
                result = r("curl -s -m 3 http://172.168.1.162:11434/api/tags 2>/dev/null | head -1")
                state["ollama"] = "online" if "models" in result else "offline"
            except Exception:
                state["ollama"] = "offline"

            save_state()
        except Exception:
            pass


# ── Main ────────────────────────────────────────────────────
async def main():
    print("=" * 50)
    print(f"Kate ET-Bus Device")
    print(f"  ID:     {KATE_ID}")
    print(f"  Class:  {KATE_CLASS}")
    print(f"  Mcast:  {MCAST_IP}:{PORT}")
    print(f"  Hub:    {hub_ip}:{hub_port}")
    print(f"  Crypto: ChaCha20-Poly1305 (PSK: {PSK_HEX[:16]}...)")
    print(f"  API:    {KATE_API}")
    print("=" * 50)

    await asyncio.gather(
        rx_loop(),
        state_loop(),
        stats_loop(),
    )


if __name__ == "__main__":
    asyncio.run(main())
