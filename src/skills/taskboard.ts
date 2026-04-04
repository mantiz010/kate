import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Types ─────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "done" | "blocked";
  priority: "low" | "medium" | "high" | "critical";
  project: string;
  createdAt: number;
  updatedAt: number;
  dueDate?: string;
  notes: string[];
  createdBy: string;
}

interface TaskBoard {
  tasks: Task[];
  version: number;
}

// ── Persistence ───────────────────────────────────────────────

const TASKBOARD_FILE = path.join(os.homedir(), ".kate", "taskboard.json");

function ensureDir(): void {
  const dir = path.dirname(TASKBOARD_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadBoard(): TaskBoard {
  ensureDir();
  if (!fs.existsSync(TASKBOARD_FILE)) {
    return { tasks: [], version: 1 };
  }
  try {
    const raw = fs.readFileSync(TASKBOARD_FILE, "utf-8");
    return JSON.parse(raw) as TaskBoard;
  } catch {
    return { tasks: [], version: 1 };
  }
}

function saveBoard(board: TaskBoard): void {
  ensureDir();
  fs.writeFileSync(TASKBOARD_FILE, JSON.stringify(board, null, 2), "utf-8");
}

function generateId(): string {
  return "task-" + Date.now().toString(36);
}

// ── Formatting helpers ────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  open: "\u{1F7E2}",        // green circle
  in_progress: "\u{1F535}",  // blue circle
  done: "\u2705",            // check mark
  blocked: "\u{1F534}",      // red circle
};

const PRIORITY_ICON: Record<string, string> = {
  low: "\u2B07\uFE0F",
  medium: "\u25AA\uFE0F",
  high: "\u26A0\uFE0F",
  critical: "\u{1F525}",
};

function formatTask(t: Task): string {
  const status = STATUS_ICON[t.status] ?? t.status;
  const priority = PRIORITY_ICON[t.priority] ?? t.priority;
  const due = t.dueDate ? ` | Due: ${t.dueDate}` : "";
  const proj = t.project ? ` [${t.project}]` : "";
  const desc = t.description ? `\n   ${t.description}` : "";
  const notes = t.notes.length > 0
    ? "\n   Notes: " + t.notes.map((n) => `\n    - ${n}`).join("")
    : "";
  return `${status} ${priority} ${t.title}${proj}${due}\n   ID: ${t.id} | Status: ${t.status} | Priority: ${t.priority}${desc}${notes}`;
}

function isOverdue(t: Task): boolean {
  if (!t.dueDate || t.status === "done") return false;
  return new Date(t.dueDate).getTime() < Date.now();
}

// ── Tool implementations ──────────────────────────────────────

function taskCreate(args: Record<string, unknown>, ctx: SkillContext): string {
  const title = args.title as string;
  if (!title) return "Error: title is required.";

  const board = loadBoard();
  const task: Task = {
    id: generateId(),
    title,
    description: (args.description as string) ?? "",
    status: "open",
    priority: (args.priority as Task["priority"]) ?? "medium",
    project: (args.project as string) ?? "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    notes: [],
    createdBy: ctx.userId,
  };
  if (args.due_date) task.dueDate = args.due_date as string;

  board.tasks.push(task);
  saveBoard(board);
  return `Task created:\n${formatTask(task)}`;
}

function taskList(args: Record<string, unknown>): string {
  const board = loadBoard();
  let filtered = board.tasks;

  if (args.status) filtered = filtered.filter((t) => t.status === args.status);
  if (args.project) filtered = filtered.filter((t) => t.project.toLowerCase() === (args.project as string).toLowerCase());
  if (args.priority) filtered = filtered.filter((t) => t.priority === args.priority);

  if (filtered.length === 0) return "No tasks found matching the given filters.";

  // Sort: critical/high first, then by updatedAt desc
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  filtered.sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2) || b.updatedAt - a.updatedAt);

  const lines = filtered.map(formatTask);
  return `Tasks (${filtered.length}):\n\n${lines.join("\n\n")}`;
}

function taskUpdate(args: Record<string, unknown>): string {
  const taskId = args.task_id as string;
  if (!taskId) return "Error: task_id is required.";

  const board = loadBoard();
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return `Error: task '${taskId}' not found.`;

  if (args.status) task.status = args.status as Task["status"];
  if (args.title) task.title = args.title as string;
  if (args.description) task.description = args.description as string;
  if (args.priority) task.priority = args.priority as Task["priority"];
  if (args.notes) task.notes.push(args.notes as string);
  task.updatedAt = Date.now();

  saveBoard(board);
  return `Task updated:\n${formatTask(task)}`;
}

function taskComplete(args: Record<string, unknown>): string {
  const taskId = args.task_id as string;
  if (!taskId) return "Error: task_id is required.";

  const board = loadBoard();
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return `Error: task '${taskId}' not found.`;

  task.status = "done";
  task.updatedAt = Date.now();
  if (args.notes) task.notes.push(args.notes as string);

  saveBoard(board);
  return `Task completed:\n${formatTask(task)}`;
}

function taskDelete(args: Record<string, unknown>): string {
  const taskId = args.task_id as string;
  if (!taskId) return "Error: task_id is required.";

  const board = loadBoard();
  const idx = board.tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return `Error: task '${taskId}' not found.`;

  const removed = board.tasks.splice(idx, 1)[0];
  saveBoard(board);
  return `Deleted task: ${removed.title} (${removed.id})`;
}

function taskSummary(): string {
  const board = loadBoard();
  const tasks = board.tasks;

  if (tasks.length === 0) return "Taskboard is empty. No tasks tracked yet.";

  const counts = { open: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const t of tasks) counts[t.status]++;

  const overdue = tasks.filter(isOverdue);
  const recent = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

  // Per-project breakdown
  const projects = new Map<string, number>();
  for (const t of tasks) {
    const p = t.project || "(none)";
    projects.set(p, (projects.get(p) ?? 0) + 1);
  }

  let out = "=== Taskboard Summary ===\n\n";
  out += `${STATUS_ICON.open} Open: ${counts.open}\n`;
  out += `${STATUS_ICON.in_progress} In Progress: ${counts.in_progress}\n`;
  out += `${STATUS_ICON.done} Done: ${counts.done}\n`;
  out += `${STATUS_ICON.blocked} Blocked: ${counts.blocked}\n`;
  out += `Total: ${tasks.length}\n`;

  if (projects.size > 1 || !projects.has("(none)")) {
    out += "\nProjects:\n";
    for (const [proj, count] of projects) {
      out += `  - ${proj}: ${count} task${count !== 1 ? "s" : ""}\n`;
    }
  }

  if (overdue.length > 0) {
    out += `\n\u{1F6A8} Overdue (${overdue.length}):\n`;
    for (const t of overdue) {
      out += `  - ${t.title} (due ${t.dueDate}) [${t.id}]\n`;
    }
  }

  out += "\nRecent activity:\n";
  for (const t of recent) {
    const ago = timeSince(t.updatedAt);
    out += `  - ${STATUS_ICON[t.status]} ${t.title} (${ago})\n`;
  }

  return out;
}

function taskSearch(args: Record<string, unknown>): string {
  const query = (args.query as string ?? "").toLowerCase();
  if (!query) return "Error: query is required.";

  const board = loadBoard();
  const matches = board.tasks.filter((t) =>
    t.title.toLowerCase().includes(query) ||
    t.description.toLowerCase().includes(query) ||
    t.project.toLowerCase().includes(query) ||
    t.notes.some((n) => n.toLowerCase().includes(query))
  );

  if (matches.length === 0) return `No tasks found matching "${args.query}".`;

  const lines = matches.map(formatTask);
  return `Search results for "${args.query}" (${matches.length}):\n\n${lines.join("\n\n")}`;
}

function timeSince(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── Skill definition ──────────────────────────────────────────

const taskboardSkill: Skill = {
  id: "taskboard",
  name: "Taskboard",
  description: "Persistent task and project tracking. Create, update, search, and summarize tasks across sessions.",
  version: "1.0.0",

  tools: [
    {
      name: "task_create",
      description: "Create a new task on the taskboard.",
      parameters: [
        { name: "title", type: "string", description: "Task title", required: true },
        { name: "description", type: "string", description: "Detailed description of the task", required: false },
        { name: "priority", type: "string", description: "Priority level: low, medium, high, or critical", required: false },
        { name: "project", type: "string", description: "Project name to group the task under", required: false },
        { name: "due_date", type: "string", description: "Due date in YYYY-MM-DD format", required: false },
      ],
    },
    {
      name: "task_list",
      description: "List tasks, optionally filtered by status, project, or priority.",
      parameters: [
        { name: "status", type: "string", description: "Filter by status: open, in_progress, done, or blocked", required: false },
        { name: "project", type: "string", description: "Filter by project name", required: false },
        { name: "priority", type: "string", description: "Filter by priority: low, medium, high, or critical", required: false },
      ],
    },
    {
      name: "task_update",
      description: "Update an existing task's fields. Append notes without overwriting previous ones.",
      parameters: [
        { name: "task_id", type: "string", description: "The task ID to update", required: true },
        { name: "status", type: "string", description: "New status: open, in_progress, done, or blocked", required: false },
        { name: "title", type: "string", description: "New title", required: false },
        { name: "description", type: "string", description: "New description", required: false },
        { name: "priority", type: "string", description: "New priority: low, medium, high, or critical", required: false },
        { name: "notes", type: "string", description: "Note to append to the task", required: false },
      ],
    },
    {
      name: "task_complete",
      description: "Mark a task as done.",
      parameters: [
        { name: "task_id", type: "string", description: "The task ID to complete", required: true },
        { name: "notes", type: "string", description: "Optional completion note", required: false },
      ],
    },
    {
      name: "task_delete",
      description: "Permanently delete a task from the taskboard.",
      parameters: [
        { name: "task_id", type: "string", description: "The task ID to delete", required: true },
      ],
    },
    {
      name: "task_summary",
      description: "Get a summary of the taskboard: counts by status, overdue tasks, project breakdown, and recent activity.",
      parameters: [],
    },
    {
      name: "task_search",
      description: "Search tasks by keyword across title, description, project, and notes.",
      parameters: [
        { name: "query", type: "string", description: "Search keyword", required: true },
      ],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "task_create":   return taskCreate(args, ctx);
      case "task_list":     return taskList(args);
      case "task_update":   return taskUpdate(args);
      case "task_complete": return taskComplete(args);
      case "task_delete":   return taskDelete(args);
      case "task_summary":  return taskSummary();
      case "task_search":   return taskSearch(args);
      default:              return `Unknown tool: ${toolName}`;
    }
  },
};

export default taskboardSkill;
