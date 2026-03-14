import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import { createLogger } from "../core/logger.js";
import type { KateConfig, Logger } from "../core/types.js";

const log = createLogger("workers");

// ── Types ──────────────────────────────────────────────────────

export type WorkerStatus = "idle" | "busy" | "starting" | "error" | "stopped";

export interface WorkerTask {
  id: string;
  prompt: string;
  priority: number;       // 0 = low, 1 = normal, 2 = high
  assignedTo?: string;
  status: "queued" | "running" | "done" | "failed";
  result?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkerInfo {
  id: string;
  name: string;
  status: WorkerStatus;
  currentTask?: string;
  tasksCompleted: number;
  tasksFailed: number;
  uptime: number;
  startedAt: number;
  lastActivity: number;
  model?: string;
  pid?: number;
}

interface WorkerProcess {
  info: WorkerInfo;
  process: ChildProcess | null;
  onResult?: (result: string) => void;
}

// ── Worker Pool ────────────────────────────────────────────────

export class WorkerPool extends EventEmitter {
  private workers = new Map<string, WorkerProcess>();
  private taskQueue: WorkerTask[] = [];
  private taskHistory: WorkerTask[] = [];
  private config: KateConfig;
  private nextWorkerId = 1;

  constructor(config: KateConfig) {
    super();
    this.config = config;
  }

  // ── Spawn a new worker ───────────────────────────────────
  async spawnWorker(name?: string, model?: string): Promise<WorkerInfo> {
    const id = `worker-${this.nextWorkerId++}`;
    const workerName = name || `${this.config.agent.name}-${id}`;
    const workerModel = model || this.config.provider.ollama.model;

    log.info(`Spawning worker: ${workerName} (${workerModel})`);

    const info: WorkerInfo = {
      id,
      name: workerName,
      status: "starting",
      tasksCompleted: 0,
      tasksFailed: 0,
      uptime: 0,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      model: workerModel,
    };

    // Fork a child process that runs the worker script
    const workerScript = path.join(path.dirname(new URL(import.meta.url).pathname), "worker-process.js");

    let proc: ChildProcess | null = null;
    try {
      proc = fork(workerScript, [], {
        env: {
          ...process.env,
          KATE_WORKER_ID: id,
          KATE_WORKER_NAME: workerName,
          KATE_WORKER_MODEL: workerModel,
          KATE_OLLAMA_URL: this.config.provider.ollama.baseUrl,
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });

      info.pid = proc.pid;
      info.status = "idle";

      proc.on("message", (msg: any) => {
        this.handleWorkerMessage(id, msg);
      });

      proc.on("exit", (code) => {
        log.warn(`Worker ${workerName} exited (code: ${code})`);
        const w = this.workers.get(id);
        if (w) {
          w.info.status = "stopped";
          this.emit("worker:stopped", w.info);
        }
      });

      proc.on("error", (err) => {
        log.error(`Worker ${workerName} error: ${err.message}`);
        const w = this.workers.get(id);
        if (w) {
          w.info.status = "error";
          this.emit("worker:error", { worker: w.info, error: err.message });
        }
      });

    } catch (err: any) {
      log.error(`Failed to spawn worker: ${err.message}`);
      info.status = "error";
    }

    const worker: WorkerProcess = { info, process: proc };
    this.workers.set(id, worker);

    this.emit("worker:spawned", info);
    log.info(`Worker ${workerName} ready (PID: ${info.pid})`);

    return info;
  }

  // ── Submit a task ────────────────────────────────────────
  async submitTask(prompt: string, priority: number = 1, targetWorker?: string): Promise<WorkerTask> {
    const task: WorkerTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      prompt,
      priority,
      status: "queued",
      createdAt: Date.now(),
    };

    if (targetWorker) {
      task.assignedTo = targetWorker;
    }

    this.taskQueue.push(task);
    this.taskQueue.sort((a, b) => b.priority - a.priority);

    this.emit("task:queued", task);
    log.info(`Task queued: ${task.id} (priority: ${priority})`);

    // Try to dispatch immediately
    this.dispatchTasks();

    return task;
  }

  // ── Submit multiple tasks at once ────────────────────────
  async submitBatch(prompts: string[], priority: number = 1): Promise<WorkerTask[]> {
    const tasks: WorkerTask[] = [];
    for (const prompt of prompts) {
      const task = await this.submitTask(prompt, priority);
      tasks.push(task);
    }
    return tasks;
  }

  // ── Dispatch queued tasks to idle workers ────────────────
  private dispatchTasks() {
    for (const task of this.taskQueue) {
      if (task.status !== "queued") continue;

      // Find an idle worker (prefer assigned, fall back to any idle)
      let worker: WorkerProcess | undefined;

      if (task.assignedTo) {
        const assigned = this.workers.get(task.assignedTo);
        if (assigned && assigned.info.status === "idle") {
          worker = assigned;
        }
      }

      if (!worker) {
        for (const w of this.workers.values()) {
          if (w.info.status === "idle") {
            worker = w;
            break;
          }
        }
      }

      if (worker && worker.process) {
        task.status = "running";
        task.startedAt = Date.now();
        task.assignedTo = worker.info.id;

        worker.info.status = "busy";
        worker.info.currentTask = task.id;
        worker.info.lastActivity = Date.now();

        // Send task to worker process
        worker.process.send({
          type: "task",
          taskId: task.id,
          prompt: task.prompt,
        });

        this.emit("task:started", { task, worker: worker.info });
        log.info(`Task ${task.id} → ${worker.info.name}`);
      }
    }
  }

  // ── Handle messages from worker processes ────────────────
  private handleWorkerMessage(workerId: string, msg: any) {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    if (msg.type === "result") {
      const taskId = msg.taskId;
      const task = this.taskQueue.find(t => t.id === taskId);

      if (task) {
        task.status = "done";
        task.result = msg.result;
        task.completedAt = Date.now();

        worker.info.status = "idle";
        worker.info.currentTask = undefined;
        worker.info.tasksCompleted++;
        worker.info.lastActivity = Date.now();

        // Move to history
        this.taskQueue = this.taskQueue.filter(t => t.id !== taskId);
        this.taskHistory.push(task);
        if (this.taskHistory.length > 200) this.taskHistory.shift();

        this.emit("task:done", { task, worker: worker.info });
        log.info(`Task ${taskId} completed by ${worker.info.name}`);
      }

      // Dispatch next task
      this.dispatchTasks();
    }

    if (msg.type === "error") {
      const taskId = msg.taskId;
      const task = this.taskQueue.find(t => t.id === taskId);

      if (task) {
        task.status = "failed";
        task.error = msg.error;
        task.completedAt = Date.now();

        worker.info.status = "idle";
        worker.info.currentTask = undefined;
        worker.info.tasksFailed++;

        this.taskQueue = this.taskQueue.filter(t => t.id !== taskId);
        this.taskHistory.push(task);

        this.emit("task:failed", { task, worker: worker.info, error: msg.error });
        log.error(`Task ${taskId} failed on ${worker.info.name}: ${msg.error}`);
      }

      this.dispatchTasks();
    }

    if (msg.type === "log") {
      this.emit("worker:log", { workerId, message: msg.message });
    }
  }

  // ── Kill a specific worker ───────────────────────────────
  async killWorker(workerId: string): Promise<boolean> {
    const worker = this.workers.get(workerId);
    if (!worker) return false;

    if (worker.process) {
      worker.process.kill("SIGTERM");
    }

    worker.info.status = "stopped";

    // Re-queue any task it was working on
    if (worker.info.currentTask) {
      const task = this.taskQueue.find(t => t.id === worker.info.currentTask);
      if (task && task.status === "running") {
        task.status = "queued";
        task.assignedTo = undefined;
        task.startedAt = undefined;
        log.info(`Re-queued task ${task.id} from killed worker`);
      }
    }

    this.workers.delete(workerId);
    this.emit("worker:killed", worker.info);
    log.info(`Worker ${worker.info.name} killed`);

    // Dispatch any queued tasks to remaining workers
    this.dispatchTasks();

    return true;
  }

  // ── Scale workers ────────────────────────────────────────
  async scale(count: number, model?: string): Promise<WorkerInfo[]> {
    const current = this.getActiveCount();
    const spawned: WorkerInfo[] = [];

    if (count > current) {
      // Scale up
      const needed = count - current;
      log.info(`Scaling up: ${current} → ${count} (+${needed})`);
      for (let i = 0; i < needed; i++) {
        const info = await this.spawnWorker(undefined, model);
        spawned.push(info);
      }
    } else if (count < current) {
      // Scale down
      const toRemove = current - count;
      log.info(`Scaling down: ${current} → ${count} (-${toRemove})`);
      const idle = [...this.workers.values()]
        .filter(w => w.info.status === "idle")
        .slice(0, toRemove);

      for (const w of idle) {
        await this.killWorker(w.info.id);
      }

      // If still need to remove more, kill busy ones too
      if (idle.length < toRemove) {
        const busy = [...this.workers.values()]
          .filter(w => w.info.status !== "stopped")
          .slice(0, toRemove - idle.length);
        for (const w of busy) {
          await this.killWorker(w.info.id);
        }
      }
    }

    return spawned;
  }

  // ── Shutdown all workers ─────────────────────────────────
  async shutdown(): Promise<void> {
    log.info("Shutting down all workers...");
    for (const [id] of this.workers) {
      await this.killWorker(id);
    }
    this.taskQueue = [];
  }

  // ── Getters ──────────────────────────────────────────────
  getWorkers(): WorkerInfo[] {
    return [...this.workers.values()].map(w => ({
      ...w.info,
      uptime: Math.floor((Date.now() - w.info.startedAt) / 1000),
    }));
  }

  getActiveCount(): number {
    return [...this.workers.values()].filter(w =>
      w.info.status === "idle" || w.info.status === "busy"
    ).length;
  }

  getIdleCount(): number {
    return [...this.workers.values()].filter(w => w.info.status === "idle").length;
  }

  getBusyCount(): number {
    return [...this.workers.values()].filter(w => w.info.status === "busy").length;
  }

  getQueue(): WorkerTask[] {
    return [...this.taskQueue];
  }

  getTaskHistory(limit: number = 50): WorkerTask[] {
    return this.taskHistory.slice(-limit);
  }

  getStats(): {
    workers: { total: number; idle: number; busy: number; error: number };
    tasks: { queued: number; running: number; completed: number; failed: number };
  } {
    const workers = this.getWorkers();
    const allTasks = [...this.taskQueue, ...this.taskHistory];

    return {
      workers: {
        total: workers.length,
        idle: workers.filter(w => w.status === "idle").length,
        busy: workers.filter(w => w.status === "busy").length,
        error: workers.filter(w => w.status === "error").length,
      },
      tasks: {
        queued: this.taskQueue.filter(t => t.status === "queued").length,
        running: this.taskQueue.filter(t => t.status === "running").length,
        completed: this.taskHistory.filter(t => t.status === "done").length,
        failed: this.taskHistory.filter(t => t.status === "failed").length,
      },
    };
  }
}

