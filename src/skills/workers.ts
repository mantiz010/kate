import type { Skill, SkillContext } from "../core/types.js";
import { WorkerPool } from "../workers/pool.js";
import { loadConfig } from "../core/config.js";

let pool: WorkerPool | null = null;

async function getPool(): Promise<WorkerPool> {
  if (!pool) {
    const config = await loadConfig();
    pool = new WorkerPool(config);

    // Log events
    pool.on("task:done", ({ task, worker }) => {
      console.log(`  [worker:${worker.name}] ✓ Task done: ${task.prompt.slice(0, 60)}`);
    });
    pool.on("task:failed", ({ task, worker, error }) => {
      console.log(`  [worker:${worker.name}] ✗ Task failed: ${error}`);
    });
    pool.on("worker:log", ({ workerId, message }) => {
      console.log(`  [${workerId}] ${message}`);
    });
  }
  return pool;
}

const workers: Skill = {
  id: "builtin.workers",
  name: "Workers",
  description: "Spawn and manage parallel worker nodes. Each worker is an independent Kate agent that can execute tasks concurrently.",
  version: "1.0.0",
  tools: [
    {
      name: "worker_spawn",
      description: "Spawn a new worker node. Each worker is an independent agent that can run tasks in parallel.",
      parameters: [
        { name: "name", type: "string", description: "Worker name (optional)", required: false },
        { name: "model", type: "string", description: "Ollama model to use (optional, defaults to your configured model)", required: false },
        { name: "count", type: "number", description: "Number of workers to spawn (default: 1)", required: false },
      ],
    },
    {
      name: "worker_list",
      description: "List all active workers and their status",
      parameters: [],
    },
    {
      name: "worker_kill",
      description: "Stop and remove a worker node",
      parameters: [
        { name: "id", type: "string", description: "Worker ID to kill (or 'all' to kill all)", required: true },
      ],
    },
    {
      name: "worker_scale",
      description: "Scale worker pool to a specific number of workers. Automatically spawns or kills workers to reach the target.",
      parameters: [
        { name: "count", type: "number", description: "Target number of workers", required: true },
        { name: "model", type: "string", description: "Model for new workers", required: false },
      ],
    },
    {
      name: "worker_task",
      description: "Submit a task to be executed by a worker. The task is a natural language prompt that a worker will execute using its tools.",
      parameters: [
        { name: "prompt", type: "string", description: "The task prompt — what the worker should do", required: true },
        { name: "priority", type: "number", description: "Priority: 0=low, 1=normal, 2=high (default: 1)", required: false },
        { name: "worker", type: "string", description: "Specific worker ID to assign to (optional)", required: false },
      ],
    },
    {
      name: "worker_batch",
      description: "Submit multiple tasks at once. They'll be distributed across available workers automatically.",
      parameters: [
        { name: "prompts", type: "string", description: "Tasks separated by newlines or | pipe characters", required: true },
        { name: "priority", type: "number", description: "Priority for all tasks (default: 1)", required: false },
      ],
    },
    {
      name: "worker_status",
      description: "Get overview stats: worker counts, task queue, completion rates",
      parameters: [],
    },
    {
      name: "worker_queue",
      description: "Show the current task queue and running tasks",
      parameters: [],
    },
    {
      name: "worker_history",
      description: "Show recent task results",
      parameters: [
        { name: "limit", type: "number", description: "Number of results to show (default: 10)", required: false },
      ],
    },
    {
      name: "worker_wait",
      description: "Wait for all current tasks to complete and return results",
      parameters: [
        { name: "timeout", type: "number", description: "Max wait time in seconds (default: 300)", required: false },
      ],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const p = await getPool();

    switch (toolName) {
      case "worker_spawn": {
        const name = args.name as string | undefined;
        const model = args.model as string | undefined;
        const count = (args.count as number) || 1;

        const spawned = [];
        for (let i = 0; i < count; i++) {
          const info = await p.spawnWorker(
            count > 1 ? `${name || "worker"}-${i + 1}` : name,
            model,
          );
          spawned.push(info);
        }

        return spawned.map(w =>
          `Spawned: ${w.name} (${w.id}) — model: ${w.model}, PID: ${w.pid}, status: ${w.status}`
        ).join("\n");
      }

      case "worker_list": {
        const workers = p.getWorkers();
        if (workers.length === 0) return "No workers running. Use worker_spawn to create some.";

        return workers.map(w => {
          const uptime = formatDuration(w.uptime);
          const status = w.status === "idle" ? "● idle" :
                         w.status === "busy" ? "◉ busy" :
                         w.status === "error" ? "✗ error" : "○ stopped";
          return [
            `[${w.id}] ${w.name} — ${status}`,
            `  Model: ${w.model} | PID: ${w.pid} | Uptime: ${uptime}`,
            `  Tasks: ${w.tasksCompleted} done, ${w.tasksFailed} failed`,
            w.currentTask ? `  Current: ${w.currentTask}` : "",
          ].filter(Boolean).join("\n");
        }).join("\n\n");
      }

      case "worker_kill": {
        const id = args.id as string;
        if (id === "all") {
          await p.shutdown();
          return "All workers stopped.";
        }
        const killed = await p.killWorker(id);
        return killed ? `Worker ${id} killed.` : `Worker ${id} not found.`;
      }

      case "worker_scale": {
        const count = args.count as number;
        const model = args.model as string | undefined;
        const before = p.getActiveCount();
        await p.scale(count, model);
        const after = p.getActiveCount();
        return `Scaled: ${before} → ${after} workers`;
      }

      case "worker_task": {
        const prompt = args.prompt as string;
        const priority = (args.priority as number) ?? 1;
        const worker = args.worker as string | undefined;

        if (p.getActiveCount() === 0) {
          // Auto-spawn a worker if none exist
          await p.spawnWorker();
        }

        const task = await p.submitTask(prompt, priority, worker);
        return `Task submitted: ${task.id}\nPrompt: ${prompt.slice(0, 100)}\nPriority: ${priority}\nStatus: ${task.status}${task.assignedTo ? `\nAssigned: ${task.assignedTo}` : ""}`;
      }

      case "worker_batch": {
        const raw = args.prompts as string;
        const priority = (args.priority as number) ?? 1;

        const prompts = raw.includes("|")
          ? raw.split("|").map(s => s.trim()).filter(Boolean)
          : raw.split("\n").map(s => s.trim()).filter(Boolean);

        if (prompts.length === 0) return "No tasks provided.";

        // Auto-scale if needed
        const needed = Math.min(prompts.length, os.cpus().length);
        if (p.getActiveCount() < needed) {
          await p.scale(needed);
        }

        const tasks = await p.submitBatch(prompts, priority);
        return `Batch submitted: ${tasks.length} tasks across ${p.getActiveCount()} workers\n` +
          tasks.map(t => `  ${t.id}: ${t.prompt.slice(0, 60)}`).join("\n");
      }

      case "worker_status": {
        const stats = p.getStats();
        return [
          `Workers: ${stats.workers.total} total (${stats.workers.idle} idle, ${stats.workers.busy} busy, ${stats.workers.error} error)`,
          `Tasks: ${stats.tasks.queued} queued, ${stats.tasks.running} running, ${stats.tasks.completed} completed, ${stats.tasks.failed} failed`,
          `Queue depth: ${stats.tasks.queued}`,
        ].join("\n");
      }

      case "worker_queue": {
        const queue = p.getQueue();
        if (queue.length === 0) return "Task queue is empty.";

        return queue.map(t => {
          const age = formatDuration(Math.floor((Date.now() - t.createdAt) / 1000));
          return `[${t.id}] ${t.status} — ${t.prompt.slice(0, 60)}... (age: ${age}${t.assignedTo ? `, worker: ${t.assignedTo}` : ""})`;
        }).join("\n");
      }

      case "worker_history": {
        const limit = (args.limit as number) || 10;
        const history = p.getTaskHistory(limit);
        if (history.length === 0) return "No task history yet.";

        return history.map(t => {
          const duration = t.startedAt && t.completedAt
            ? formatDuration(Math.floor((t.completedAt - t.startedAt) / 1000))
            : "—";
          return [
            `[${t.id}] ${t.status === "done" ? "✓" : "✗"} ${t.prompt.slice(0, 60)}`,
            `  Duration: ${duration} | Worker: ${t.assignedTo || "—"}`,
            t.result ? `  Result: ${t.result.slice(0, 150)}` : "",
            t.error ? `  Error: ${t.error}` : "",
          ].filter(Boolean).join("\n");
        }).join("\n\n");
      }

      case "worker_wait": {
        const timeout = ((args.timeout as number) || 300) * 1000;
        const start = Date.now();

        return new Promise<string>((resolve) => {
          const check = () => {
            const stats = p.getStats();
            if (stats.tasks.queued === 0 && stats.tasks.running === 0) {
              const history = p.getTaskHistory(20);
              const results = history.slice(-10).map(t =>
                `${t.status === "done" ? "✓" : "✗"} ${t.prompt.slice(0, 50)}: ${(t.result || t.error || "").slice(0, 100)}`
              ).join("\n");
              resolve(`All tasks complete.\n\nRecent results:\n${results}`);
              return;
            }
            if (Date.now() - start > timeout) {
              resolve(`Timeout after ${timeout / 1000}s. ${stats.tasks.running} tasks still running, ${stats.tasks.queued} queued.`);
              return;
            }
            setTimeout(check, 1000);
          };
          check();
        });
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },

  async onUnload() {
    if (pool) {
      await pool.shutdown();
      pool = null;
    }
  },
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// Needed for os.cpus() in worker_batch
import os from "node:os";

export default workers;

