import dgram from "node:dgram";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("etbus-device");

const MCAST_IP = "239.10.0.1";
const DEFAULT_PORT = 5555;
const KATE_ID = "kate_ai";
const KATE_CLASS = "sensor.kate_ai";
const KID = 1;
const CONFIG_FILE = path.join(os.homedir(), ".kate", "etbus.json");

interface Config {
  port: number;
  cryptoEnabled: boolean;
  pskHex: string;
}

let config: Config = { port: DEFAULT_PORT, cryptoEnabled: false, pskHex: "" };
let sock: dgram.Socket | null = null;
let hubIp: string | null = "172.168.1.8";
let hubPort: number = DEFAULT_PORT;
let running = false;
let txCtr = 0;
let rxLastCtr = 0;

// Kate's state — what HA sees
let kateState: Record<string, any> = {
  status: "online",
  skills: 0,
  tools: 0,
  last_command: "",
  last_response: "",
  uptime: 0,
  requests: 0,
  errors: 0,
  cpu: 0,
  memory: 0,
};

let commandHandler: ((cmd: string) => Promise<string>) | null = null;
let startTime = Date.now();
let requestCount = 0;
let errorCount = 0;

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) }; } catch {}
}

function deriveKey(devId: string): Buffer | null {
  if (!config.cryptoEnabled || !config.pskHex) return null;
  const hex = config.pskHex.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 64) return null;
  const psk = Buffer.from(hex, "hex");
  return crypto.createHash("sha256").update(Buffer.concat([psk, Buffer.from(devId, "utf-8")])).digest();
}

function nonceFromCtr(ctr: number): Buffer {
  const buf = Buffer.alloc(12, 0);
  buf.writeBigUInt64LE(BigInt(ctr), 4);
  return buf;
}

function encrypt(plain: Record<string, any>): Record<string, any> | null {
  const key = deriveKey(KATE_ID);
  if (!key) return null;
  txCtr++;
  const nonce = nonceFromCtr(txCtr);
  const pt = Buffer.from(JSON.stringify(plain), "utf-8");
  try {
    const cipher = crypto.createCipheriv("chacha20-poly1305" as any, key, nonce, { authTagLength: 16 });
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { _enc: 1, kid: KID, ctr: txCtr, nonce: nonce.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
  } catch { return null; }
}

function decrypt(devId: string, wrapper: Record<string, any>): Record<string, any> | null {
  const key = deriveKey(devId);
  if (!key) return null;
  try {
    const nonce = Buffer.from(wrapper.nonce, "base64");
    const ct = Buffer.from(wrapper.ct, "base64");
    const tag = Buffer.from(wrapper.tag, "base64");
    const decipher = crypto.createDecipheriv("chacha20-poly1305" as any, key, nonce, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString("utf-8"));
  } catch { return null; }
}

function udpSend(ip: string, port: number, msg: Record<string, any>) {
  if (!sock) return;
  const data = Buffer.from(JSON.stringify(msg), "utf-8");
  try { sock.send(data, 0, data.length, port, ip); } catch {}
}

function sendState() {
  // Update dynamic values
  kateState.uptime = Math.floor((Date.now() - startTime) / 1000);
  kateState.requests = requestCount;
  kateState.errors = errorCount;

  let payload: Record<string, any> = { ...kateState };

  if (config.cryptoEnabled) {
    const enc = encrypt(payload);
    if (enc) payload = enc;
  }

  const msg = {
    v: 1,
    type: "state",
    id: KATE_ID,
    class: KATE_CLASS,
    payload,
  };

  // Send to hub if known, otherwise multicast
  if (hubIp) {
    udpSend(hubIp, hubPort, msg);
  } else {
    udpSend(MCAST_IP, config.port, msg);
  }
}

function sendDiscovery() {
  // Send as flat multi-metric payload — HA sensor.py picks up each key
  const payload: Record<string, any> = { ...kateState, name: "Kate AI Agent", fw: "1.0.0" };

  const msg = {
    v: 1,
    type: "state",
    id: KATE_ID,
    class: KATE_CLASS,
    payload: config.cryptoEnabled ? (encrypt(payload) || payload) : payload,
  };

  udpSend(MCAST_IP, config.port, msg);
  log.info("ET-Bus discovery sent for " + KATE_ID);
}

function sendPong() {
  let payload: Record<string, any> = { ...kateState, name: "Kate AI Agent" };

  if (config.cryptoEnabled) {
    const enc = encrypt(payload);
    if (enc) payload = enc;
  }

  const msg = {
    v: 1,
    type: "pong",
    id: KATE_ID,
    class: KATE_CLASS,
    payload,
  };

  if (hubIp) {
    udpSend(hubIp, hubPort, msg);
  } else {
    udpSend(MCAST_IP, config.port, msg);
  }
}

export function updateKateState(updates: Partial<typeof kateState>) {
  Object.assign(kateState, updates);
}

export function recordRequest() { requestCount++; }
export function recordError() { errorCount++; }

export async function startEtBusDevice(onCommand: (cmd: string) => Promise<string>): Promise<void> {
  if (running) return;
  loadConfig();
  commandHandler = onCommand;
  startTime = Date.now();

  sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

  sock.on("message", async (data, rinfo) => {
    try {
      const msg = JSON.parse(data.toString("utf-8"));
      if (msg.v !== 1 || !msg.type || !msg.id) return;
      if (msg.id === KATE_ID) return; // ignore own messages

      let payload = msg.payload || {};

      // Track hub
      if (msg.id === "hub" || msg.type === "ping") {
        hubIp = rinfo.address;
        hubPort = msg.payload?.port || config.port;

        // Respond to ping with pong + state
        sendPong();
        return;
      }

      // Decrypt if needed
      if (config.cryptoEnabled && payload._enc === 1) {
        const plain = decrypt(msg.id, payload);
        if (!plain) return;
        payload = plain;
      }

      // Handle commands sent TO kate
      if (msg.type === "command" && commandHandler) {
        const cmdText = payload.command || payload.message || payload.text || JSON.stringify(payload);
        log.info("ET-Bus command from " + msg.id + ": " + cmdText.slice(0, 80));

        kateState.last_command = cmdText.slice(0, 200);
        updateKateState({ status: "busy" });
        sendState();

        try {
          const response = await commandHandler(cmdText);
          kateState.last_response = response.slice(0, 200);
          updateKateState({ status: "online" });
          sendState();

          // Send response back to the sender
          const respMsg = {
            v: 1,
            type: "state",
            id: KATE_ID,
            class: KATE_CLASS,
            payload: config.cryptoEnabled
              ? (encrypt({ response: response.slice(0, 500), status: "done" }) || { response: response.slice(0, 500) })
              : { response: response.slice(0, 500), status: "done" },
          };
          udpSend(rinfo.address, config.port, respMsg);
        } catch (err: any) {
          kateState.last_response = "Error: " + err.message;
          updateKateState({ status: "error" });
          sendState();
        }
      }
    } catch {}
  });

  sock.bind(config.port, () => {
    try { sock!.addMembership(MCAST_IP); } catch {}
    log.info("Kate ET-Bus device started on " + MCAST_IP + ":" + config.port);
  });

  running = true;

  // Send discovery immediately, then state every 10s
  setTimeout(sendDiscovery, 1000);
  setTimeout(sendState, 2000);
  setInterval(sendState, 10000);

  // Update CPU/memory every 30s
  setInterval(async () => {
    try {
      const { execSync } = await import("node:child_process");
      const cpu = parseFloat(execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", { timeout: 5000 }).toString().trim()) || 0;
      const memOut = execSync("free | grep Mem | awk '{print ($3/$2)*100}'", { timeout: 5000 }).toString().trim();
      const mem = parseFloat(memOut) || 0;
      updateKateState({ cpu: Math.round(cpu), memory: Math.round(mem) });
    } catch {}
  }, 30000);
}

export function stopEtBusDevice() {
  if (sock) { sock.close(); sock = null; }
  running = false;
  log.info("Kate ET-Bus device stopped");
}
