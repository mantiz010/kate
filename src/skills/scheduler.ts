import type { Skill, SkillContext, MemoryStore } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const log = createLogger("scheduler");

interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  command: string;
  type: "shell" | "message" | "skill";
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  lastResult?: string;
  lastError?: string;
  nextRun?: number;
  runCount: number;
  userId: string;
}

const TASKS_FILE = path.join(os.homedir(), ".aegis", "tasks.json");
let tasks: ScheduledTask[] = [];
let intervals = new Map<string, NodeJS.Timeout>();

// ── Activity log — shared with web UI ──────────────────────────
export interface ActivityEntry {
  timestamp: number;
  type: "task" | "tool" | "worker" | "error" | "info";
  source: string;
  message: string;
  details?: string;
}

const MAX_ACTIVITY = 200;
let activityLog: ActivityEntry[] = [];

export function getActivity(limit = 50): ActivityEntry[] {
  return activityLog.slice(-limit);
}

export function addActivity(entry: Omit<ActivityEntry, "timestamp">) {
  activityLog.push({ ...entry, timestamp: Date.now() });
  if (activityLog.length > MAX_ACTIVITY) activityLog.shift();
}

// ── Known bad commands that are Kate tools, not shell commands ──
const KATE_TOOL_NAMES = [
  "system_info", "disk_usage", "network_info", "process_list", "resource_alert",
  "run_command", "read_file", "write_file", "list_directory", "search_files",
  "remember", "recall", "forget", "list_memories",
  "fetch_url", "extract_text", "search", "fetch_page",
  "git_status", "git_log", "git_diff",
  "uptime_check", "monitor_add", "service_list",
  "worker_spawn", "worker_task", "worker_status",
  "schedule_create", "schedule_list",
];

function validateShellCommand(cmd: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  for (const toolName of KATE_TOOL_NAMES) {
    // Check if the command uses an Kate tool name as if it were a bash command
    const pattern = new RegExp(`(^|&&|;|\\|)\\s*${toolName}\\b`, "g");
    if (pattern.test(cmd)) {
      issues.push(`"${toolName}" is an Kate tool, not a shell command. Use real bash commands instead.`);
    }
  }

  // Suggest fixes for common mistakes
  if (cmd.includes("system_info")) issues.push("Use instead: uname -a && lscpu | head -10 && free -h");
  if (cmd.includes("disk_usage")) issues.push("Use instead: df -h");
  if (cmd.includes("network_info")) issues.push("Use instead: ip addr && ss -tlnp | head -20");
  if (cmd.includes("process_list")) issues.push("Use instead: ps aux --sort=-%cpu | head -15");
  if (cmd.includes("resource_alert")) issues.push("Use instead: echo CPU: $(top -bn1 | head -3 | tail -1) && echo MEM: $(free -h | head -2 | tail -1)");

  return { valid: issues.length === 0, issues };
}

function loadTasks(): ScheduledTask[] {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      tasks = JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8"));
      return tasks;
    }
  } catch {}
  return [];
}

function saveTasks(): void {
  const dir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function parseCron(expr: string): number | null {
  const match = expr.match(/^every\s+(\d+)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "s": case "sec": return val * 1000;
    case "m": case "min": return val * 60 * 1000;
    case "h": case "hr": case "hour": return val * 60 * 60 * 1000;
    case "d": case "day": return val * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

function startTask(task: ScheduledTask, ctx: SkillContext): void {
  if (intervals.has(task.id)) return;
  const ms = parseCron(task.cron);
  if (!ms) { log.warn(`Invalid schedule for ${task.id}: ${task.cron}`); return; }

  log.info(`Scheduling: "${task.name}" (${task.cron})`);
  addActivity({ type: "info", source: "scheduler", message: `Scheduled: ${task.name} (${task.cron})` });

  const interval = setInterval(async () => {
    if (!task.enabled) return;

    log.info(`Running task: ${task.name}`);
    addActivity({ type: "task", source: "scheduler", message: `Running: ${task.name}`, details: task.command });
    task.lastRun = Date.now();
    task.runCount++;

    if (task.type === "shell") {
      try {
        const { stdout, stderr } = await execAsync(task.command, { timeout: 60000, maxBuffer: 1024 * 1024 });
        const output = (stdout || stderr || "(no output)").slice(0, 2000);
        task.lastResult = output;
        task.lastError = undefined;
        log.info(`Task "${task.name}" OK: ${output.slice(0, 100)}`);
        addActivity({ type: "task", source: "scheduler", message: `✓ ${task.name} completed`, details: output.slice(0, 200) });

        await ctx.memory.set(
          `task_result:${task.id}`,
          `Task "${task.name}" at ${new Date().toISOString()}: ${output.slice(0, 500)}`,
          "task", task.userId, 0.3,
        );
      } catch (err: any) {
        const errMsg = (err.stderr || err.message || "unknown error").slice(0, 500);
        task.lastError = errMsg;
        log.error(`Task "${task.name}" failed: ${errMsg}`);
        addActivity({ type: "error", source: "scheduler", message: `✗ ${task.name} failed`, details: errMsg });
      }
    }

    saveTasks();
  }, ms);

  intervals.set(task.id, interval);
}

function stopTask(taskId: string): void {
  const interval = intervals.get(taskId);
  if (interval) { clearInterval(interval); intervals.delete(taskId); }
}

const scheduler: Skill = {
  id: "builtin.scheduler",
  name: "Scheduler",
  description: "Schedule recurring tasks using REAL SHELL COMMANDS (bash). NOT Kate tool names. Supports: every 5m, every 1h, every 30s, every 2d. IMPORTANT: Commands must be valid bash — use df -h NOT disk_usage, use ps aux NOT process_list.",
  version: "2.0.0",
  tools: [
    {
      name: "schedule_create",
      description: "Create a scheduled task. CRITICAL: The command MUST be a real bash command (like 'df -h', 'ps aux', 'curl ...'), NOT an Kate tool name (like 'system_info' or 'disk_usage').",
      parameters: [
        { name: "name", type: "string", description: "Task name", required: true },
        { name: "schedule", type: "string", description: "When: 'every 5m', 'every 1h', 'every 30s', etc.", required: true },
        { name: "command", type: "string", description: "REAL BASH command to run (e.g. 'df -h', NOT 'disk_usage')", required: true },
        { name: "type", type: "string", description: "shell (default)", required: false },
      ],
    },
    { name: "schedule_list", description: "List all tasks with status and last results", parameters: [] },
    { name: "schedule_enable", description: "Enable a task", parameters: [
      { name: "id", type: "string", description: "Task ID", required: true },
    ]},
    { name: "schedule_disable", description: "Disable a task", parameters: [
      { name: "id", type: "string", description: "Task ID", required: true },
    ]},
    { name: "schedule_delete", description: "Delete a task", parameters: [
      { name: "id", type: "string", description: "Task ID", required: true },
    ]},
    { name: "schedule_run_now", description: "Run a task immediately", parameters: [
      { name: "id", type: "string", description: "Task ID", required: true },
    ]},
    { name: "schedule_history", description: "View recent task results from memory", parameters: [
      { name: "taskId", type: "string", description: "Task ID (optional)", required: false },
    ]},
    { name: "set_reminder", description: "One-time reminder after a delay", parameters: [
      { name: "message", type: "string", description: "Reminder text", required: true },
      { name: "delay", type: "string", description: "Delay: 5m, 1h, 30s, 2d", required: true },
    ]},
    { name: "schedule_fix", description: "Scan scheduled tasks for invalid commands (Kate tool names used as bash) and show fixes", parameters: [] },
    { name: "schedule_clear_all", description: "Delete ALL scheduled tasks", parameters: [
      { name: "confirm", type: "boolean", description: "Must be true", required: true },
    ]},
  ],

  async onLoad() {
    loadTasks();
    log.info(`Loaded ${tasks.length} scheduled tasks`);
  },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "schedule_create": {
        const name = args.name as string;
        const schedule = args.schedule as string;
        const command = args.command as string;
        const type = (args.type as string) || "shell";

        const ms = parseCron(schedule);
        if (!ms) return `Invalid schedule: "${schedule}". Use: every 5m, every 1h, every 30s, every 2d`;

        // Validate command — reject Kate tool names
        const validation = validateShellCommand(command);
        if (!validation.valid) {
          return [
            `⚠ INVALID COMMAND — you used Kate tool names as shell commands:`,
            "",
            ...validation.issues.map(i => `  ✗ ${i}`),
            "",
            "Scheduled tasks run REAL BASH commands, not Kate tools.",
            "Fix the command and try again.",
          ].join("\n");
        }

        const task: ScheduledTask = {
          id: `task_${Date.now().toString(36)}`,
          name, cron: schedule, command,
          type: type as any, enabled: true,
          createdAt: Date.now(), runCount: 0, userId: ctx.userId,
        };

        tasks.push(task);
        saveTasks();
        startTask(task, ctx);
        addActivity({ type: "info", source: "scheduler", message: `Created task: ${name} (${schedule})`, details: command });

        return `Created: "${name}" (${task.id})\nSchedule: ${schedule}\nCommand: ${command}\nStatus: ✓ running`;
      }

      case "schedule_list": {
        loadTasks();
        if (tasks.length === 0) return "No scheduled tasks.";

        return tasks.map(t => {
          const status = t.enabled ? "● enabled" : "○ disabled";
          const lastRun = t.lastRun ? new Date(t.lastRun).toLocaleString() : "never";
          const result = t.lastResult ? `\n  Last result: ${t.lastResult.slice(0, 150)}` : "";
          const error = t.lastError ? `\n  Last error: ${t.lastError.slice(0, 150)}` : "";
          return [
            `[${t.id}] ${t.name} — ${status}`,
            `  Schedule: ${t.cron}`,
            `  Command: ${t.command.slice(0, 100)}`,
            `  Runs: ${t.runCount} | Last: ${lastRun}`,
            result, error,
          ].filter(Boolean).join("\n");
        }).join("\n\n");
      }

      case "schedule_enable": {
        const task = tasks.find(t => t.id === args.id);
        if (!task) return `Task not found: ${args.id}`;
        task.enabled = true; saveTasks(); startTask(task, ctx);
        return `Enabled: ${task.name}`;
      }

      case "schedule_disable": {
        const task = tasks.find(t => t.id === args.id);
        if (!task) return `Task not found: ${args.id}`;
        task.enabled = false; stopTask(task.id); saveTasks();
        return `Disabled: ${task.name}`;
      }

      case "schedule_delete": {
        const idx = tasks.findIndex(t => t.id === args.id);
        if (idx === -1) return `Task not found: ${args.id}`;
        const removed = tasks.splice(idx, 1)[0];
        stopTask(removed.id); saveTasks();
        addActivity({ type: "info", source: "scheduler", message: `Deleted task: ${removed.name}` });
        return `Deleted: ${removed.name}`;
      }

      case "schedule_run_now": {
        const task = tasks.find(t => t.id === args.id);
        if (!task) return `Task not found: ${args.id}`;

        addActivity({ type: "task", source: "scheduler", message: `Manual run: ${task.name}` });
        try {
          const { stdout, stderr } = await execAsync(task.command, { timeout: 60000 });
          const output = stdout || stderr || "(no output)";
          task.lastRun = Date.now(); task.runCount++; task.lastResult = output.slice(0, 2000);
          task.lastError = undefined; saveTasks();
          addActivity({ type: "task", source: "scheduler", message: `✓ ${task.name} done`, details: output.slice(0, 200) });
          return `${task.name} executed:\n${output.slice(0, 5000)}`;
        } catch (err: any) {
          task.lastError = err.message; saveTasks();
          addActivity({ type: "error", source: "scheduler", message: `✗ ${task.name} failed`, details: err.message });
          return `Failed: ${err.stderr || err.message}`;
        }
      }

      case "schedule_history": {
        const taskId = args.taskId as string | undefined;
        const query = taskId ? `task_result:${taskId}` : "task_result";
        const results = await ctx.memory.search(query, ctx.userId, 10);
        if (results.length === 0) return "No task history.";
        return results.map(r => r.value).join("\n\n");
      }

      case "set_reminder": {
        const message = args.message as string;
        const delayStr = args.delay as string;
        const ms = parseCron(`every ${delayStr}`);
        if (!ms) return `Invalid delay: ${delayStr}`;

        setTimeout(() => {
          log.info(`⏰ REMINDER: ${message}`);
          addActivity({ type: "info", source: "reminder", message: `⏰ ${message}` });
        }, ms);

        const when = new Date(Date.now() + ms).toLocaleTimeString();
        addActivity({ type: "info", source: "scheduler", message: `Reminder set for ${when}: ${message}` });
        return `Reminder set for ${when}: "${message}"`;
      }

      case "schedule_fix": {
        loadTasks();
        const broken: string[] = [];
        for (const task of tasks) {
          if (task.type !== "shell") continue;
          const v = validateShellCommand(task.command);
          if (!v.valid) {
            broken.push(`[${task.id}] ${task.name}:\n${v.issues.map(i => `  ✗ ${i}`).join("\n")}`);
            task.enabled = false;
            stopTask(task.id);
          }
        }
        saveTasks();
        if (broken.length === 0) return "✓ All tasks have valid shell commands.";
        return `Found ${broken.length} broken task(s) — DISABLED them:\n\n${broken.join("\n\n")}\n\nDelete them with schedule_delete or fix the commands.`;
      }

      case "schedule_clear_all": {
        if (!(args.confirm as boolean)) return "Set confirm=true to delete all tasks.";
        for (const t of tasks) stopTask(t.id);
        tasks = []; saveTasks();
        addActivity({ type: "info", source: "scheduler", message: "All scheduled tasks cleared" });
        return "All scheduled tasks deleted.";
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export default scheduler;

