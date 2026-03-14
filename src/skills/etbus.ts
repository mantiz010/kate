import type { Skill, SkillContext } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import dgram from "node:dgram";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const log = createLogger("etbus");

const MCAST_IP = "239.10.0.1";
const DEFAULT_PORT = 5555;
const KATE_ID = "kate";
const KID = 1;
const CONFIG_FILE = path.join(os.homedir(), ".kate", "etbus.json");

interface EtBusConfig {
  port: number;
  cryptoEnabled: boolean;
  pskHex: string;
}

interface EtBusDevice {
  id: string;
  ip: string;
  devClass: string;
  lastSeen: number;
  online: boolean;
  payload: Record<string, any>;
}

let config: EtBusConfig = { port: DEFAULT_PORT, cryptoEnabled: false, pskHex: "" };
let devices: Map<string, EtBusDevice> = new Map();
let sock: dgram.Socket | null = null;
let txCtr: Map<string, number> = new Map();
let listening = false;

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) }; } catch {}
}
function saveConfig() {
  const d = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function deriveKey(devId: string): Buffer | null {
  if (!config.cryptoEnabled || !config.pskHex) return null;
  const psk = Buffer.from(config.pskHex.replace(/[^0-9a-fA-F]/g, ""), "hex");
  if (psk.length !== 32) return null;
  return crypto.createHash("sha256").update(Buffer.concat([psk, Buffer.from(devId, "utf-8")])).digest();
}

function nonceCmd(ctr: number): Buffer {
  const buf = Buffer.alloc(12, 0);
  buf.writeBigUInt64LE(BigInt(ctr), 4);
  return buf;
}

function encryptPayload(devId: string, plain: Record<string, any>): Record<string, any> | null {
  const key = deriveKey(devId);
  if (!key) return null;
  const ctr = (txCtr.get(devId) || 0) + 1;
  txCtr.set(devId, ctr);
  const nonce = nonceCmd(ctr);
  const pt = Buffer.from(JSON.stringify(plain), "utf-8");
  const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    _enc: 1,
    kid: KID,
    ctr,
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptPayload(devId: string, wrapper: Record<string, any>): Record<string, any> | null {
  const key = deriveKey(devId);
  if (!key) return null;
  try {
    const nonce = Buffer.from(wrapper.nonce, "base64");
    const ct = Buffer.from(wrapper.ct, "base64");
    const tag = Buffer.from(wrapper.tag, "base64");
    const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString("utf-8"));
  } catch (e) {
    log.error("Decrypt failed for " + devId + ": " + e);
    return null;
  }
}

function udpSend(ip: string, port: number, msg: Record<string, any>) {
  if (!sock) return;
  const data = Buffer.from(JSON.stringify(msg), "utf-8");
  sock.send(data, 0, data.length, port, ip);
}

function sendPing() {
  const msg = {
    v: 1,
    type: "ping",
    id: KATE_ID,
    class: "agent",
    payload: { port: config.port, ts: Math.floor(Date.now() / 1000) },
  };
  udpSend(MCAST_IP, config.port, msg);
}

function sendCommand(devId: string, devClass: string, payload: Record<string, any>) {
  const dev = devices.get(devId);
  if (!dev) return "Device not found: " + devId;

  let finalPayload: Record<string, any> = payload;
  if (config.cryptoEnabled) {
    const enc = encryptPayload(devId, payload);
    if (!enc) return "Encryption failed for " + devId;
    finalPayload = enc;
  }

  const msg = {
    v: 1,
    type: "command",
    id: KATE_ID,
    class: devClass,
    payload: finalPayload,
  };
  udpSend(dev.ip, config.port, msg);
  return "Command sent to " + devId + " at " + dev.ip;
}

function startListener(): string {
  if (listening) return "Already listening on port " + config.port;

  loadConfig();
  sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

  sock.on("message", (data, rinfo) => {
    try {
      const msg = JSON.parse(data.toString("utf-8"));
      const v = msg.v || 0;
      const mtype = msg.type || "";
      const devId = msg.id || "";
      const devClass = msg.class || "";

      if (v !== 1 || !mtype || !devId || devId === KATE_ID) return;

      let payload = msg.payload || {};
      if (config.cryptoEnabled && payload._enc === 1) {
        const plain = decryptPayload(devId, payload);
        if (!plain) return;
        payload = plain;
      }

      const existing = devices.get(devId) || { id: devId, ip: "", devClass: "", lastSeen: 0, online: false, payload: {} };
      existing.ip = rinfo.address;
      existing.devClass = devClass || existing.devClass;
      existing.lastSeen = Date.now();
      existing.online = true;
      if (mtype === "state" || mtype === "pong") {
        existing.payload = { ...existing.payload, ...payload };
      }
      devices.set(devId, existing);

      log.info(mtype + " from " + devId + " (" + rinfo.address + ") class=" + devClass);
    } catch {}
  });

  sock.bind(config.port, () => {
    sock!.addMembership(MCAST_IP);
    log.info("ET-Bus listening on " + MCAST_IP + ":" + config.port);
  });

  listening = true;

  // Ping every 10s
  setInterval(sendPing, 10000);
  // Initial ping
  setTimeout(sendPing, 500);

  return "ET-Bus listener started on " + MCAST_IP + ":" + config.port + (config.cryptoEnabled ? " (encrypted)" : " (plaintext)");
}

const etbus: Skill = {
  id: "builtin.etbus",
  name: "ET-Bus",
  description: "Kate speaks ET-Bus protocol — UDP multicast discovery, unicast commands, ChaCha20-Poly1305 encryption. Controls ESP32 devices directly.",
  version: "1.0.0",
  tools: [
    { name: "etbus_start", description: "Start the ET-Bus listener and begin discovering devices", parameters: [
      { name: "port", type: "number", description: "UDP port (default: 5555)", required: false },
    ]},
    { name: "etbus_stop", description: "Stop the ET-Bus listener", parameters: [] },
    { name: "etbus_discover", description: "Send a ping and list all discovered ET-Bus devices", parameters: [] },
    { name: "etbus_devices", description: "List all known ET-Bus devices with their status", parameters: [] },
    { name: "etbus_command", description: "Send a command to an ET-Bus device", parameters: [
      { name: "deviceId", type: "string", description: "Device ID", required: true },
      { name: "devClass", type: "string", description: "Device class: switch, light, fan, sensor", required: true },
      { name: "payload", type: "string", description: "JSON payload e.g. {\"switches\":{\"1\":true}}", required: true },
    ]},
    { name: "etbus_switch", description: "Turn an ET-Bus switch on or off", parameters: [
      { name: "deviceId", type: "string", description: "Device ID", required: true },
      { name: "channel", type: "string", description: "Switch channel (1, 2, etc)", required: true },
      { name: "state", type: "string", description: "on or off", required: true },
    ]},
    { name: "etbus_light", description: "Control an ET-Bus light", parameters: [
      { name: "deviceId", type: "string", description: "Device ID", required: true },
      { name: "state", type: "string", description: "on or off", required: true },
      { name: "brightness", type: "number", description: "Brightness 0-255", required: false },
    ]},
    { name: "etbus_state", description: "Get the last known state of an ET-Bus device", parameters: [
      { name: "deviceId", type: "string", description: "Device ID", required: true },
    ]},
    { name: "etbus_config", description: "Configure ET-Bus: port, encryption, PSK", parameters: [
      { name: "port", type: "number", description: "UDP port", required: false },
      { name: "cryptoEnabled", type: "string", description: "true or false", required: false },
      { name: "pskHex", type: "string", description: "64-char hex pre-shared key", required: false },
    ]},
    { name: "etbus_ping", description: "Send a multicast ping to discover devices", parameters: [] },
    { name: "etbus_raw", description: "Send a raw JSON message to a device IP", parameters: [
      { name: "ip", type: "string", description: "Device IP address", required: true },
      { name: "message", type: "string", description: "Raw JSON message", required: true },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case "etbus_start": {
        loadConfig();
        if (args.port) config.port = args.port as number;
        return startListener();
      }

      case "etbus_stop": {
        if (sock) { sock.close(); sock = null; }
        listening = false;
        return "ET-Bus listener stopped.";
      }

      case "etbus_discover": {
        if (!listening) startListener();
        sendPing();
        // Wait for responses
        await new Promise(r => setTimeout(r, 3000));
        if (devices.size === 0) return "No ET-Bus devices found. Make sure devices are powered on and on the same network.";
        return "Discovered " + devices.size + " device(s):\n\n" + [...devices.values()].map(d =>
          (d.online ? "🟢" : "🔴") + " " + d.id + " [" + d.devClass + "] at " + d.ip +
          "\n  Last seen: " + new Date(d.lastSeen).toLocaleTimeString() +
          (Object.keys(d.payload).length > 0 ? "\n  State: " + JSON.stringify(d.payload).slice(0, 150) : "")
        ).join("\n\n");
      }

      case "etbus_devices": {
        if (devices.size === 0) return "No devices known. Run etbus_discover first.";
        return "ET-Bus Devices (" + devices.size + "):\n\n" + [...devices.values()].map(d =>
          (d.online ? "🟢" : "🔴") + " " + d.id +
          "\n  Class: " + d.devClass +
          "\n  IP: " + d.ip +
          "\n  Online: " + d.online +
          "\n  Last seen: " + new Date(d.lastSeen).toLocaleTimeString() +
          (Object.keys(d.payload).length > 0 ? "\n  State: " + JSON.stringify(d.payload).slice(0, 200) : "")
        ).join("\n\n");
      }

      case "etbus_command": {
        if (!listening) startListener();
        const devId = args.deviceId as string;
        const devClass = args.devClass as string;
        let payload: Record<string, any>;
        try { payload = JSON.parse(args.payload as string); } catch { return "Invalid JSON payload"; }
        return sendCommand(devId, devClass, payload);
      }

      case "etbus_switch": {
        if (!listening) startListener();
        const devId = args.deviceId as string;
        const channel = args.channel as string;
        const on = (args.state as string).toLowerCase() === "on";
        const payload = { switches: { [channel]: on } };
        return sendCommand(devId, "switch", payload);
      }

      case "etbus_light": {
        if (!listening) startListener();
        const devId = args.deviceId as string;
        const on = (args.state as string).toLowerCase() === "on";
        const payload: Record<string, any> = { state: on ? "ON" : "OFF" };
        if (args.brightness !== undefined) payload.brightness = args.brightness as number;
        return sendCommand(devId, "light", payload);
      }

      case "etbus_state": {
        const devId = args.deviceId as string;
        const dev = devices.get(devId);
        if (!dev) return "Device not found: " + devId + ". Run etbus_discover.";
        return "Device: " + dev.id + "\n  Class: " + dev.devClass + "\n  IP: " + dev.ip + "\n  Online: " + dev.online + "\n  State: " + JSON.stringify(dev.payload, null, 2);
      }

      case "etbus_config": {
        loadConfig();
        if (args.port !== undefined) config.port = args.port as number;
        if (args.cryptoEnabled !== undefined) config.cryptoEnabled = (args.cryptoEnabled as string) === "true";
        if (args.pskHex !== undefined) config.pskHex = args.pskHex as string;
        saveConfig();
        return "ET-Bus config updated:\n  Port: " + config.port + "\n  Crypto: " + config.cryptoEnabled + "\n  PSK: " + (config.pskHex ? config.pskHex.slice(0, 8) + "..." : "not set");
      }

      case "etbus_ping": {
        if (!listening) startListener();
        sendPing();
        return "Ping sent to " + MCAST_IP + ":" + config.port;
      }

      case "etbus_raw": {
        if (!listening) startListener();
        const ip = args.ip as string;
        let msg: Record<string, any>;
        try { msg = JSON.parse(args.message as string); } catch { return "Invalid JSON"; }
        udpSend(ip, config.port, msg);
        return "Raw message sent to " + ip + ":" + config.port;
      }

      default: return "Unknown: " + toolName;
    }
  },
};

export default etbus;
