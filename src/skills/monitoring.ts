import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const run = async (cmd: string, timeout = 30000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 5 });
    return (stdout || stderr || "(no output)").slice(0, 10000);
  } catch (err: any) {
    return `Error: ${err.stderr || err.message}`.slice(0, 3000);
  }
};

const MONITORS_FILE = path.join(os.homedir(), ".aegis", "monitors.json");
let monitors: Array<{ id: string; name: string; url: string; interval: number; lastCheck?: number; lastStatus?: number; uptime: number; checks: number }> = [];

function loadMonitors() {
  try { if (fs.existsSync(MONITORS_FILE)) monitors = JSON.parse(fs.readFileSync(MONITORS_FILE, "utf-8")); } catch {}
}
function saveMonitors() {
  const dir = path.dirname(MONITORS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MONITORS_FILE, JSON.stringify(monitors, null, 2));
}

const monitoring: Skill = {
  id: "builtin.monitoring",
  name: "Monitoring",
  description: "System monitoring, uptime checks, log analysis, process management, health endpoints, resource alerts",
  version: "1.0.0",
  tools: [
    { name: "system_info", description: "Full system overview: CPU, RAM, disk, network, uptime", parameters: [] },
    { name: "process_list", description: "List top processes by CPU or memory usage", parameters: [
      { name: "sortBy", type: "string", description: "cpu or mem (default: cpu)", required: false },
      { name: "count", type: "number", description: "Number of processes (default: 15)", required: false },
    ]},
    { name: "process_kill", description: "Kill a process by PID or name", parameters: [
      { name: "target", type: "string", description: "PID number or process name", required: true },
      { name: "signal", type: "string", description: "Signal: TERM, KILL, HUP (default: TERM)", required: false },
    ]},
    { name: "disk_usage", description: "Show disk usage by mount point and largest directories", parameters: [
      { name: "path", type: "string", description: "Path to check (default: /)", required: false },
    ]},
    { name: "network_info", description: "Show network interfaces, connections, and listening ports", parameters: [] },
    { name: "log_tail", description: "Tail a log file or system journal", parameters: [
      { name: "file", type: "string", description: "Log file path or 'syslog', 'auth', 'kern', 'journal'", required: true },
      { name: "lines", type: "number", description: "Number of lines (default: 30)", required: false },
      { name: "filter", type: "string", description: "Grep filter pattern", required: false },
    ]},
    { name: "uptime_check", description: "HTTP health check on a URL — returns status, latency, response", parameters: [
      { name: "url", type: "string", description: "URL to check", required: true },
      { name: "timeout", type: "number", description: "Timeout in seconds (default: 10)", required: false },
    ]},
    { name: "monitor_add", description: "Add a URL to persistent uptime monitoring", parameters: [
      { name: "name", type: "string", description: "Monitor name", required: true },
      { name: "url", type: "string", description: "URL to monitor", required: true },
      { name: "interval", type: "number", description: "Check interval in seconds (default: 60)", required: false },
    ]},
    { name: "monitor_list", description: "List all active monitors with status", parameters: [] },
    { name: "monitor_remove", description: "Remove a monitor", parameters: [
      { name: "id", type: "string", description: "Monitor ID", required: true },
    ]},
    { name: "service_list", description: "List systemd services and their status", parameters: [
      { name: "filter", type: "string", description: "Filter by name", required: false },
    ]},
    { name: "resource_alert", description: "Check if CPU, memory, or disk exceeds a threshold and report", parameters: [
      { name: "cpuThreshold", type: "number", description: "CPU % threshold (default: 80)", required: false },
      { name: "memThreshold", type: "number", description: "Memory % threshold (default: 85)", required: false },
      { name: "diskThreshold", type: "number", description: "Disk % threshold (default: 90)", required: false },
    ]},
  ],

  async onLoad() { loadMonitors(); },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "system_info": {
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPct = ((usedMem / totalMem) * 100).toFixed(1);
        const uptime = os.uptime();
        const loadAvg = os.loadavg();
        const disk = await run("df -h / | tail -1");
        const hostname = os.hostname();

        return [
          `System: ${hostname}`,
          `OS: ${os.type()} ${os.release()} (${os.arch()})`,
          `CPU: ${cpus[0]?.model || "unknown"} (${cpus.length} cores)`,
          `Load: ${loadAvg.map(l => l.toFixed(2)).join(", ")} (1m, 5m, 15m)`,
          `Memory: ${fmt(usedMem)} / ${fmt(totalMem)} (${memPct}%)`,
          `Disk: ${disk.trim()}`,
          `Uptime: ${fmtTime(uptime)}`,
        ].join("\n");
      }

      case "process_list": {
        const sort = (args.sortBy as string) === "mem" ? "--sort=-%mem" : "--sort=-%cpu";
        const n = (args.count as number) || 15;
        return run(`ps aux ${sort} | head -${n + 1}`);
      }

      case "process_kill": {
        const target = args.target as string;
        const signal = (args.signal as string) || "TERM";
        if (/^\d+$/.test(target)) {
          return run(`kill -${signal} ${target} && echo "Killed PID ${target}"`);
        }
        return run(`pkill -${signal} -f "${target}" && echo "Killed processes matching: ${target}"`);
      }

      case "disk_usage": {
        const p = (args.path as string) || "/";
        const df = await run("df -h");
        const large = await run(`du -sh ${p}/* 2>/dev/null | sort -rh | head -10`);
        return `Mount points:\n${df}\n\nLargest in ${p}:\n${large}`;
      }

      case "network_info": {
        const ifaces = await run("ip -brief addr 2>/dev/null || ifconfig 2>/dev/null | head -30");
        const ports = await run("ss -tlnp 2>/dev/null | head -20 || netstat -tlnp 2>/dev/null | head -20");
        const conns = await run("ss -s 2>/dev/null || netstat -s 2>/dev/null | head -10");
        return `Interfaces:\n${ifaces}\n\nListening ports:\n${ports}\n\nConnection stats:\n${conns}`;
      }

      case "log_tail": {
        const file = args.file as string;
        const lines = (args.lines as number) || 30;
        const filter = args.filter as string;
        let cmd: string;

        switch (file) {
          case "syslog": cmd = `tail -${lines} /var/log/syslog 2>/dev/null || journalctl -n ${lines} --no-pager`; break;
          case "auth": cmd = `tail -${lines} /var/log/auth.log 2>/dev/null || journalctl -u ssh -n ${lines} --no-pager`; break;
          case "kern": cmd = `dmesg | tail -${lines}`; break;
          case "journal": cmd = `journalctl -n ${lines} --no-pager`; break;
          default: cmd = `tail -${lines} "${file}"`; break;
        }
        if (filter) cmd += ` | grep -i "${filter}"`;
        return run(cmd);
      }

      case "uptime_check": {
        const url = args.url as string;
        const timeout = (args.timeout as number) || 10;
        const start = Date.now();
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(timeout * 1000) });
          const latency = Date.now() - start;
          const body = await res.text();
          return [
            `URL: ${url}`,
            `Status: ${res.status} ${res.statusText}`,
            `Latency: ${latency}ms`,
            `Content-Type: ${res.headers.get("content-type") || "unknown"}`,
            `Body preview: ${body.slice(0, 300)}`,
          ].join("\n");
        } catch (err: any) {
          return `URL: ${url}\nStatus: DOWN\nError: ${err.message}\nLatency: ${Date.now() - start}ms`;
        }
      }

      case "monitor_add": {
        loadMonitors();
        const mon = {
          id: `mon-${Date.now().toString(36)}`,
          name: args.name as string,
          url: args.url as string,
          interval: (args.interval as number) || 60,
          uptime: 0,
          checks: 0,
        };
        monitors.push(mon);
        saveMonitors();
        return `Monitor added: ${mon.name} (${mon.id})\nURL: ${mon.url}\nInterval: ${mon.interval}s`;
      }

      case "monitor_list": {
        loadMonitors();
        if (monitors.length === 0) return "No monitors configured. Use monitor_add.";
        return monitors.map(m => {
          const status = m.lastStatus ? (m.lastStatus < 400 ? "● UP" : "✗ DOWN") : "? unknown";
          return `[${m.id}] ${m.name} — ${status}\n  URL: ${m.url} | Checks: ${m.checks} | Uptime: ${m.uptime}%`;
        }).join("\n\n");
      }

      case "monitor_remove": {
        loadMonitors();
        monitors = monitors.filter(m => m.id !== args.id);
        saveMonitors();
        return `Monitor ${args.id} removed.`;
      }

      case "service_list": {
        const filter = (args.filter as string) || "";
        const cmd = filter
          ? `systemctl list-units --type=service --state=running 2>/dev/null | grep -i "${filter}" | head -20`
          : `systemctl list-units --type=service --state=running 2>/dev/null | head -25`;
        return run(cmd);
      }

      case "resource_alert": {
        const cpuT = (args.cpuThreshold as number) || 80;
        const memT = (args.memThreshold as number) || 85;
        const diskT = (args.diskThreshold as number) || 90;
        const alerts: string[] = [];

        const load = os.loadavg()[0];
        const cpuPct = (load / os.cpus().length) * 100;
        if (cpuPct > cpuT) alerts.push(`⚠ CPU load: ${cpuPct.toFixed(1)}% (threshold: ${cpuT}%)`);

        const memPct = ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
        if (memPct > memT) alerts.push(`⚠ Memory: ${memPct.toFixed(1)}% (threshold: ${memT}%)`);

        const diskOut = await run("df / | tail -1 | awk '{print $5}'");
        const diskPct = parseInt(diskOut) || 0;
        if (diskPct > diskT) alerts.push(`⚠ Disk: ${diskPct}% (threshold: ${diskT}%)`);

        return alerts.length > 0
          ? `ALERTS:\n${alerts.join("\n")}`
          : `✓ All clear — CPU: ${cpuPct.toFixed(1)}%, Mem: ${memPct.toFixed(1)}%, Disk: ${diskPct}%`;
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

function fmt(bytes: number): string {
  if (bytes < 1e9) return (bytes / 1e6).toFixed(0) + "MB";
  return (bytes / 1e9).toFixed(1) + "GB";
}

function fmtTime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default monitoring;

