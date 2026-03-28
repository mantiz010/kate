import { createLogger } from "./logger.js";
import { eventBus, EVENTS } from "./eventbus.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const log = createLogger("heartbeat");
const STATE_FILE = path.join(os.homedir(), ".aegis", "heartbeat-state.json");

interface HeartbeatState {
  lastBeat: number;
  checks: number;
  alerts: Array<{ timestamp: number; type: string; message: string; resolved: boolean }>;
  dailyBriefingSent: number;
  thresholds: {
    cpuWarn: number; cpuCrit: number;
    memWarn: number; memCrit: number;
    diskWarn: number; diskCrit: number;
  };
}

let state: HeartbeatState = {
  lastBeat: 0, checks: 0, alerts: [],
  dailyBriefingSent: 0,
  thresholds: { cpuWarn: 70, cpuCrit: 90, memWarn: 80, memCrit: 95, diskWarn: 80, diskCrit: 95 },
};

function loadState() { try { if (fs.existsSync(STATE_FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) }; } catch {} }
function saveState() {
  const d = path.dirname(STATE_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  state.alerts = state.alerts.slice(-100);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const run = async (cmd: string): Promise<string> => {
  try { const { stdout } = await execAsync(cmd, { timeout: 10000 }); return stdout.trim(); } catch { return ""; }
};

export class HeartbeatEngine {
  private interval: NodeJS.Timeout | null = null;
  private agent: any = null;
  private beatCount = 0;

  start(agent?: any) {
    if (this.interval) return;
    this.agent = agent;
    loadState();

    // Beat every 60 seconds
    this.interval = setInterval(() => this.beat(), 60000);

    // First beat immediately
    setTimeout(() => this.beat(), 5000);

    log.info("Heartbeat started — monitoring system health every 60s");
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    log.info("Heartbeat stopped");
  }

  setAgent(agent: any) { this.agent = agent; }

  async beat() {
    this.beatCount++;
    state.lastBeat = Date.now();
    state.checks++;
    const alerts: string[] = [];

    // ── CPU Check ──────────────────────
    const load = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    const cpuPct = Math.round((load / cpuCount) * 100);

    if (cpuPct > state.thresholds.cpuCrit) {
      alerts.push(`🔴 CPU CRITICAL: ${cpuPct}% (load: ${load.toFixed(1)})`);
      eventBus.fire(EVENTS.HEALTH_CRITICAL, "heartbeat", { metric: "cpu", value: cpuPct });
    } else if (cpuPct > state.thresholds.cpuWarn) {
      alerts.push(`🟡 CPU Warning: ${cpuPct}%`);
      eventBus.fire(EVENTS.HEALTH_WARN, "heartbeat", { metric: "cpu", value: cpuPct });
    }

    // ── Memory Check ───────────────────
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memPct = Math.round(((memTotal - memFree) / memTotal) * 100);

    if (memPct > state.thresholds.memCrit) {
      alerts.push(`🔴 MEMORY CRITICAL: ${memPct}%`);
      eventBus.fire(EVENTS.HEALTH_CRITICAL, "heartbeat", { metric: "memory", value: memPct });
    } else if (memPct > state.thresholds.memWarn) {
      alerts.push(`🟡 Memory Warning: ${memPct}%`);
      eventBus.fire(EVENTS.HEALTH_WARN, "heartbeat", { metric: "memory", value: memPct });
    }

    // ── Disk Check ─────────────────────
    const diskOut = await run("df / | tail -1 | awk '{print $5}'");
    const diskPct = parseInt(diskOut) || 0;

    if (diskPct > state.thresholds.diskCrit) {
      alerts.push(`🔴 DISK CRITICAL: ${diskPct}%`);
      eventBus.fire(EVENTS.HEALTH_CRITICAL, "heartbeat", { metric: "disk", value: diskPct });
    } else if (diskPct > state.thresholds.diskWarn) {
      alerts.push(`🟡 Disk Warning: ${diskPct}%`);
      eventBus.fire(EVENTS.HEALTH_WARN, "heartbeat", { metric: "disk", value: diskPct });
    }

    // ── Ollama Check ───────────────────
    try {
      const res = await fetch("http://172.168.1.162:11434/api/version", { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error("bad status");
    } catch {
      if (this.beatCount % 5 === 0) { // Don't spam every minute
        alerts.push("🔴 Ollama is unreachable!");
        eventBus.fire(EVENTS.HEALTH_CRITICAL, "heartbeat", { metric: "ollama", value: "down" });
      }
    }

    // ── Process zombie check ───────────
    if (this.beatCount % 10 === 0) {
      const zombies = await run("ps aux | grep -c defunct");
      const zCount = parseInt(zombies) || 0;
      if (zCount > 5) {
        alerts.push(`🟡 ${zCount} zombie processes detected`);
      }
    }

    // ── Log alerts ─────────────────────
    for (const alert of alerts) {
      log.warn(`Heartbeat: ${alert}`);
      state.alerts.push({ timestamp: Date.now(), type: "alert", message: alert, resolved: false });
      eventBus.fire(EVENTS.HEARTBEAT_ALERT, "heartbeat", { alert });
    }

    // ── Periodic heartbeat event ───────
    eventBus.fire(EVENTS.HEARTBEAT, "heartbeat", {
      cpu: cpuPct, mem: memPct, disk: diskPct,
      alerts: alerts.length, uptime: os.uptime(),
      beat: this.beatCount,
    });

    // ── Daily briefing (once per day at ~8am) ──────
    const now = new Date();
    const today = now.toDateString();
    const lastBriefing = new Date(state.dailyBriefingSent).toDateString();
    if (now.getHours() >= 8 && today !== lastBriefing && this.agent) {
      await this.dailyBriefing();
      state.dailyBriefingSent = Date.now();
    }

    if (alerts.length === 0 && this.beatCount % 60 === 0) {
      log.info(`Heartbeat #${this.beatCount}: All clear — CPU: ${cpuPct}%, MEM: ${memPct}%, DISK: ${diskPct}%`);
    }

    saveState();
  }

  async dailyBriefing() {
    if (!this.agent) return;
    log.info("Generating daily briefing...");

    const briefing = [
      `Daily briefing for ${new Date().toLocaleDateString()}:`,
      ``,
      `System: CPU ${Math.round((os.loadavg()[0] / os.cpus().length) * 100)}%, MEM ${Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100)}%`,
      `Uptime: ${Math.round(os.uptime() / 3600)}h`,
    ];

    // Recent alerts
    const recentAlerts = state.alerts.filter(a => Date.now() - a.timestamp < 86400000);
    if (recentAlerts.length > 0) {
      briefing.push(`Alerts (24h): ${recentAlerts.length}`);
      for (const a of recentAlerts.slice(-5)) {
        briefing.push(`  - ${a.message}`);
      }
    } else {
      briefing.push("No alerts in 24h — all clear.");
    }

    // Scheduled tasks
    try {
      const tasksFile = path.join(os.homedir(), ".aegis", "tasks.json");
      if (fs.existsSync(tasksFile)) {
        const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf-8"));
        const enabled = tasks.filter((t: any) => t.enabled);
        briefing.push(`Scheduled tasks: ${enabled.length} active`);
      }
    } catch {}

    // Memory count
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const Database = require("better-sqlite3");
      const db = new Database(path.join(os.homedir(), ".aegis", "memory.db"));
      const row = db.prepare("SELECT COUNT(*) as count FROM memories").get() as any;
      briefing.push(`Memories stored: ${row?.count || 0}`);
      db.close();
    } catch {}

    const msg = briefing.join("\n");
    log.info(`Briefing:\n${msg}`);

    // Store as memory
    try {
      await this.agent.handleMessage?.({
        id: `briefing-${Date.now()}`, role: "user",
        content: `[SYSTEM BRIEFING - Auto-generated]\n${msg}\n\nRemember this briefing.`,
        timestamp: Date.now(), source: "heartbeat", userId: "system",
      });
    } catch (err: any) {
      log.warn(`Briefing delivery failed: ${err.message}`);
    }
  }

  getState(): HeartbeatState { loadState(); return { ...state }; }
  getAlerts(limit = 20) { return state.alerts.slice(-limit); }
  setThresholds(t: Partial<HeartbeatState["thresholds"]>) {
    Object.assign(state.thresholds, t);
    saveState();
    log.info(`Thresholds updated: ${JSON.stringify(state.thresholds)}`);
  }
}

export const heartbeat = new HeartbeatEngine();

