import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);

const MQTT_HOST = "172.168.1.8";
const MQTT_PORT = 1883;
const MQTT_USER = "mantiz010";
const MQTT_PASS = "DavidCross010";
const NTFY_URL = "https://ntfy.sh/kate-alerts";
const LOG_FILE = path.join(os.homedir(), ".kate", "notifications.log");
const ETBUS_STATE_FILE = path.join(os.homedir(), ".kate", "etbus-state.json");

type Channel = "ha" | "mqtt" | "ntfy" | "log";
type Priority = "low" | "normal" | "high" | "urgent";

const ALL_CHANNELS: Channel[] = ["ha", "mqtt", "ntfy", "log"];

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString();
}

// ── Channel senders ──────────────────────────────────────────────

async function sendEtBusHA(message: string, title: string, priority: Priority): Promise<string> {
  try {
    ensureDir(ETBUS_STATE_FILE);
    let state: Record<string, any> = {};
    if (fs.existsSync(ETBUS_STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(ETBUS_STATE_FILE, "utf-8"));
    }
    state.notification = {
      message,
      title,
      priority,
      timestamp: timestamp(),
    };
    fs.writeFileSync(ETBUS_STATE_FILE, JSON.stringify(state, null, 2));
    return "ET-Bus/HA: notification written to etbus-state.json";
  } catch (err: any) {
    return `ET-Bus/HA error: ${err.message}`;
  }
}

async function sendMQTT(message: string, title: string, priority: Priority, topic?: string): Promise<string> {
  const t = topic || "homeassistant/notify";
  const payload = JSON.stringify({ message, title, priority, timestamp: timestamp() });
  const cmd = `mosquitto_pub -h ${MQTT_HOST} -p ${MQTT_PORT} -u ${MQTT_USER} -P ${MQTT_PASS} -t "${t}" -m '${payload.replace(/'/g, "'\\''")}'`;
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
    return `MQTT: published to ${t}` + (stderr ? ` (${stderr.trim()})` : "");
  } catch (err: any) {
    return `MQTT error: ${err.stderr || err.message}`.slice(0, 500);
  }
}

async function sendNtfy(message: string, title: string, priority: Priority): Promise<string> {
  try {
    const ntfyPriority = priority === "urgent" ? "5" : priority === "high" ? "4" : priority === "normal" ? "3" : "2";
    const resp = await fetch(NTFY_URL, {
      method: "POST",
      headers: {
        "Title": title || "Kate Notification",
        "Priority": ntfyPriority,
        "Content-Type": "text/plain",
      },
      body: message,
    });
    if (resp.ok) return `ntfy: sent (HTTP ${resp.status})`;
    return `ntfy error: HTTP ${resp.status} ${resp.statusText}`;
  } catch (err: any) {
    return `ntfy error: ${err.message}`;
  }
}

async function sendLog(message: string, title: string, priority: Priority, channel: string): Promise<string> {
  try {
    ensureDir(LOG_FILE);
    const entry = JSON.stringify({
      timestamp: timestamp(),
      channel,
      title,
      message,
      priority,
    }) + "\n";
    fs.appendFileSync(LOG_FILE, entry);
    return "log: appended to notifications.log";
  } catch (err: any) {
    return `log error: ${err.message}`;
  }
}

// ── Dispatch ─────────────────────────────────────────────────────

async function dispatch(
  message: string,
  title: string,
  channels: Channel[],
  priority: Priority,
): Promise<string> {
  const results: string[] = [];

  for (const ch of channels) {
    switch (ch) {
      case "ha":
        results.push(await sendEtBusHA(message, title, priority));
        break;
      case "mqtt":
        results.push(await sendMQTT(message, title, priority));
        break;
      case "ntfy":
        results.push(await sendNtfy(message, title, priority));
        break;
      case "log":
        results.push(await sendLog(message, title, priority, channels.join(",")));
        break;
    }
  }

  return results.join("\n");
}

function parseChannels(channel?: string): Channel[] {
  if (!channel || channel === "all") return ALL_CHANNELS;
  const valid: Channel[] = ["ha", "mqtt", "ntfy", "log"];
  const ch = channel as Channel;
  return valid.includes(ch) ? [ch] : ALL_CHANNELS;
}

async function readHistory(limit: number): Promise<string> {
  try {
    if (!fs.existsSync(LOG_FILE)) return "No notification history found.";
    const content = fs.readFileSync(LOG_FILE, "utf-8").trim();
    if (!content) return "Notification log is empty.";
    const lines = content.split("\n");
    const recent = lines.slice(-limit);
    const entries = recent.map((line) => {
      try {
        const e = JSON.parse(line);
        return `[${e.timestamp}] [${e.priority}] [${e.channel}] ${e.title ? e.title + ": " : ""}${e.message}`;
      } catch {
        return line;
      }
    });
    return `Last ${recent.length} notifications:\n${entries.join("\n")}`;
  } catch (err: any) {
    return `Error reading history: ${err.message}`;
  }
}

// ── Skill definition ─────────────────────────────────────────────

const notify: Skill = {
  id: "builtin.notify",
  name: "Notify",
  description: "Send notifications and alerts through multiple channels: ET-Bus/Home Assistant, MQTT, ntfy.sh push notifications, and local log file.",
  version: "1.0.0",
  tools: [
    {
      name: "notify_send",
      description: "Send a notification through one or more channels",
      parameters: [
        { name: "message", type: "string", description: "Notification message", required: true },
        { name: "title", type: "string", description: "Notification title", required: false },
        { name: "channel", type: "string", description: "Channel: all, ha, mqtt, ntfy, log (default: all)", required: false },
        { name: "priority", type: "string", description: "Priority: low, normal, high, urgent (default: normal)", required: false },
      ],
    },
    {
      name: "notify_ha",
      description: "Send a notification specifically to Home Assistant via MQTT",
      parameters: [
        { name: "message", type: "string", description: "Notification message", required: true },
        { name: "title", type: "string", description: "Notification title", required: false },
      ],
    },
    {
      name: "notify_alert",
      description: "Send an urgent alert to all channels immediately",
      parameters: [
        { name: "message", type: "string", description: "Alert message", required: true },
        { name: "source", type: "string", description: "Source of the alert (e.g. monitoring, backup, service)", required: false },
      ],
    },
    {
      name: "notify_history",
      description: "Show recent notifications from the log file",
      parameters: [
        { name: "limit", type: "number", description: "Number of recent entries to show (default: 20)", required: false },
      ],
    },
    {
      name: "notify_test",
      description: "Send a test notification to verify all channels are working",
      parameters: [],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "notify_send": {
        const message = args.message as string;
        const title = (args.title as string) || "";
        const channels = parseChannels(args.channel as string | undefined);
        const priority = (args.priority as Priority) || "normal";
        return dispatch(message, title, channels, priority);
      }

      case "notify_ha": {
        const message = args.message as string;
        const title = (args.title as string) || "";
        const mqttResult = await sendMQTT(message, title, "normal", "homeassistant/notify");
        const logResult = await sendLog(message, title, "normal", "ha");
        return [mqttResult, logResult].join("\n");
      }

      case "notify_alert": {
        const message = args.message as string;
        const source = (args.source as string) || "kate";
        const title = `ALERT from ${source}`;
        return dispatch(message, title, ALL_CHANNELS, "urgent");
      }

      case "notify_history": {
        const limit = (args.limit as number) || 20;
        return readHistory(limit);
      }

      case "notify_test": {
        const testMsg = `Kate notification test at ${timestamp()}`;
        const results = await dispatch(testMsg, "Test Notification", ALL_CHANNELS, "low");
        return `Test notification sent to all channels:\n${results}`;
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },
};

export default notify;
