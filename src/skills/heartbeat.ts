import type { Skill, SkillContext } from "../core/types.js";
import { eventBus, Events } from "../core/eventbus.js";
import { createLogger } from "../core/logger.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const log = createLogger("heartbeat");
const run = async (cmd: string) => { try { return (await execAsync(cmd, { timeout: 10000 })).stdout.trim(); } catch { return ""; } };

const HB_FILE = path.join(os.homedir(), ".aegis", "heartbeat.json");
interface HeartbeatState {
  enabled: boolean;
  interval: number;    // ms
  lastBeat: number;
  checks: string[];    // which checks to run
  alerts: Array<{ timestamp: number; type: string; message: string; resolved: boolean }>;
  dailyBriefing: boolean;
  lastBriefing: number;
  thresholds: { cpu: number; mem: number; disk: number; ollamaDown: boolean };
}

let state: HeartbeatState = {
  enabled: false, interval: 300000, lastBeat: 0,
  checks: ["cpu", "mem", "disk", "ollama", "services", "skills"],
  alerts: [], dailyBriefing: true, lastBriefing: 0,
  thresholds: { cpu: 85, mem: 90, disk: 90, ollamaDown: true },
};

let heartbeatTimer: NodeJS.Timeout | null = null;

function load() { try { if (fs.existsSync(HB_FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(HB_FILE, "utf-8")) }; } catch {} }
function save() { const d = path.dirname(HB_FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(HB_FILE, JSON.stringify(state, null, 2)); }

function addAlert(type: string, message: string) {
  state.alerts.push({ timestamp: Date.now(), type, message, resolved: false });
  if (state.alerts.length > 100) state.alerts.shift();
  eventBus.fire(Events.SYSTEM_ALERT, "heartbeat", { type, message });
  log.warn(`ALERT: [${type}] ${message}`);
  save();
}

async function runBeat() {
  if (!state.enabled) return;
  state.lastBeat = Date.now();
  log.debug("Heartbeat pulse");

  const alerts: string[] = [];

  // CPU check
  if (state.checks.includes("cpu")) {
    const load = os.loadavg()[0];
    const pct = Math.round((load / os.cpus().length) * 100);
    if (pct > state.thresholds.cpu) addAlert("cpu", `CPU at ${pct}% (threshold: ${state.thresholds.cpu}%)`);
  }

  // Memory check
  if (state.checks.includes("mem")) {
    const pct = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
    if (pct > state.thresholds.mem) addAlert("mem", `Memory at ${pct}% (threshold: ${state.thresholds.mem}%)`);
  }

  // Disk check
  if (state.checks.includes("disk")) {
    const out = await run("df / | tail -1 | awk '{print $5}'");
    const pct = parseInt(out) || 0;
    if (pct > state.thresholds.disk) addAlert("disk", `Disk at ${pct}% (threshold: ${state.thresholds.disk}%)`);
  }

  // Ollama check
  if (state.checks.includes("ollama") && state.thresholds.ollamaDown) {
    try {
      await fetch("http://172.168.1.162:11434/api/version", { signal: AbortSignal.timeout(5000) });
    } catch {
      addAlert("ollama", "Ollama is unreachable");
    }
  }

  // Check custom skills health
  if (state.checks.includes("skills")) {
    const skillsDir = path.join(os.homedir(), ".aegis", "skills");
    if (fs.existsSync(skillsDir)) {
      for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue;
        if (!fs.existsSync(path.join(skillsDir, d.name, "index.js"))) {
          addAlert("skill", `Broken skill: ${d.name} (no index.js)`);
        }
      }
    }
  }

  eventBus.fire(Events.SYSTEM_HEALTH, "heartbeat", {
    cpu: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
    mem: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
    alerts: state.alerts.filter(a => !a.resolved).length,
  });

  save();
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(runBeat, state.interval);
  runBeat(); // immediate first beat
  log.info(`Heartbeat started (every ${state.interval / 1000}s)`);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  log.info("Heartbeat stopped");
}

const heartbeat: Skill = {
  id: "builtin.heartbeat",
  name: "Heartbeat",
  description: "Proactive monitoring — automatically checks CPU, memory, disk, Ollama, skills health. Fires alerts, generates daily briefings, watches for problems before you notice them.",
  version: "1.0.0",
  tools: [
    { name: "heartbeat_start", description: "Start the heartbeat monitor", parameters: [
      { name: "interval", type: "number", description: "Check interval in seconds (default: 300 = 5min)", required: false },
    ]},
    { name: "heartbeat_stop", description: "Stop the heartbeat monitor", parameters: [] },
    { name: "heartbeat_status", description: "Show heartbeat status, active alerts, and last check results", parameters: [] },
    { name: "heartbeat_pulse", description: "Run a heartbeat check right now", parameters: [] },
    { name: "heartbeat_alerts", description: "Show all alerts (unresolved and resolved)", parameters: [
      { name: "unresolved", type: "boolean", description: "Show only unresolved (default: false)", required: false },
    ]},
    { name: "heartbeat_resolve", description: "Mark an alert as resolved", parameters: [
      { name: "index", type: "number", description: "Alert index (from heartbeat_alerts)", required: true },
    ]},
    { name: "heartbeat_thresholds", description: "Set alert thresholds", parameters: [
      { name: "cpu", type: "number", description: "CPU % threshold", required: false },
      { name: "mem", type: "number", description: "Memory % threshold", required: false },
      { name: "disk", type: "number", description: "Disk % threshold", required: false },
    ]},
    { name: "heartbeat_briefing", description: "Generate a daily briefing — system status, recent errors, recommendations", parameters: [] },
  ],

  async onLoad() { load(); if (state.enabled) startHeartbeat(); },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    load();

    switch (toolName) {
      case "heartbeat_start": {
        state.enabled = true;
        state.interval = ((args.interval as number) || 300) * 1000;
        save();
        startHeartbeat();
        return `Heartbeat started (every ${state.interval / 1000}s)\nChecks: ${state.checks.join(", ")}`;
      }
      case "heartbeat_stop": {
        state.enabled = false; save(); stopHeartbeat();
        return "Heartbeat stopped.";
      }
      case "heartbeat_status": {
        const unresolvedCount = state.alerts.filter(a => !a.resolved).length;
        const lastBeat = state.lastBeat ? new Date(state.lastBeat).toLocaleTimeString() : "never";
        return [
          `Heartbeat: ${state.enabled ? "● ACTIVE" : "○ stopped"}`,
          `Interval: ${state.interval / 1000}s`,
          `Last beat: ${lastBeat}`,
          `Checks: ${state.checks.join(", ")}`,
          `Unresolved alerts: ${unresolvedCount}`,
          `Thresholds: CPU>${state.thresholds.cpu}% MEM>${state.thresholds.mem}% DISK>${state.thresholds.disk}%`,
        ].join("\n");
      }
      case "heartbeat_pulse": {
        await runBeat();
        const unresolvedCount = state.alerts.filter(a => !a.resolved).length;
        return unresolvedCount > 0
          ? `Pulse done. ${unresolvedCount} alert(s) active.`
          : "Pulse done. All clear.";
      }
      case "heartbeat_alerts": {
        const unresolved = args.unresolved as boolean;
        let alerts = state.alerts;
        if (unresolved) alerts = alerts.filter(a => !a.resolved);
        if (alerts.length === 0) return "No alerts.";
        return alerts.map((a, i) => {
          const time = new Date(a.timestamp).toLocaleString();
          const status = a.resolved ? "✓" : "⚠";
          return `  ${status} [${i}] ${time} — [${a.type}] ${a.message}`;
        }).join("\n");
      }
      case "heartbeat_resolve": {
        const idx = args.index as number;
        if (idx >= 0 && idx < state.alerts.length) {
          state.alerts[idx].resolved = true; save();
          return `Alert ${idx} resolved.`;
        }
        return "Invalid alert index.";
      }
      case "heartbeat_thresholds": {
        if (args.cpu) state.thresholds.cpu = args.cpu as number;
        if (args.mem) state.thresholds.mem = args.mem as number;
        if (args.disk) state.thresholds.disk = args.disk as number;
        save();
        return `Thresholds: CPU>${state.thresholds.cpu}% MEM>${state.thresholds.mem}% DISK>${state.thresholds.disk}%`;
      }
      case "heartbeat_briefing": {
        const cpuPct = Math.round((os.loadavg()[0] / os.cpus().length) * 100);
        const memPct = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
        const diskOut = await run("df / | tail -1 | awk '{print $5}'");
        const diskPct = parseInt(diskOut) || 0;
        const uptimeOut = await run("cat /proc/uptime");
        const uptimeHrs = Math.round(parseFloat(uptimeOut.split(" ")[0]) / 3600);
        const unresolvedAlerts = state.alerts.filter(a => !a.resolved);
        const recentAlerts = state.alerts.filter(a => Date.now() - a.timestamp < 86400000);

        let ollamaStatus = "offline";
        try { await fetch("http://172.168.1.162:11434/api/version", { signal: AbortSignal.timeout(3000) }); ollamaStatus = "online"; } catch {}

        const skillCount = fs.readdirSync(path.join(os.homedir(), ".aegis", "skills"), { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith(".")).length;

        state.lastBriefing = Date.now(); save();

        return [
          "═══ Daily Briefing ═══",
          `Time: ${new Date().toLocaleString()}`,
          "",
          "System:",
          `  CPU: ${cpuPct}% | Memory: ${memPct}% | Disk: ${diskPct}%`,
          `  Uptime: ${uptimeHrs} hours`,
          `  Ollama: ${ollamaStatus}`,
          "",
          "Kate:",
          `  Custom skills: ${skillCount}`,
          `  Heartbeat: ${state.enabled ? "active" : "inactive"}`,
          "",
          `Alerts (24h): ${recentAlerts.length} total, ${unresolvedAlerts.length} unresolved`,
          unresolvedAlerts.length > 0 ? unresolvedAlerts.map(a => `  ⚠ [${a.type}] ${a.message}`).join("\n") : "  ✓ All clear",
          "",
          "Status: " + (unresolvedAlerts.length === 0 && cpuPct < 80 && memPct < 85 ? "✓ Healthy" : "⚠ Needs attention"),
        ].join("\n");
      }
      default: return `Unknown: ${toolName}`;
    }
  },
};
export default heartbeat;

