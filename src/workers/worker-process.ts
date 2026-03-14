// This script runs inside each forked worker process.
// It receives tasks via IPC, runs them through an agent, sends results back.

import { loadConfig } from "../core/config.js";
import { Agent } from "../core/agent.js";
import { ProviderRegistry } from "../providers/registry.js";
import { SkillManager } from "../skills/manager.js";
import { InMemoryStore } from "../memory/store.js";
import { createLogger } from "../core/logger.js";
import type { Message } from "../core/types.js";

const workerId = process.env.KATE_WORKER_ID || "unknown";
const workerName = process.env.KATE_WORKER_NAME || "Worker";
const workerModel = process.env.KATE_WORKER_MODEL;

const log = createLogger(`worker:${workerName}`);

async function init() {
  log.info(`Worker ${workerName} starting (PID: ${process.pid})`);

  const config = await loadConfig();

  // Override model if specified
  if (workerModel) {
    config.provider.ollama.model = workerModel;
  }

  const memory = new InMemoryStore();
  const providers = new ProviderRegistry(config);
  const skills = new SkillManager();
  await skills.loadBuiltin(config.skills.builtin);

  const agent = new Agent(config, providers, skills, memory);

  log.info(`Worker ${workerName} ready (model: ${config.provider.ollama.model}, ${skills.getAllTools().length} tools)`);

  // Listen for tasks from parent
  process.on("message", async (msg: any) => {
    if (msg.type === "task") {
      const { taskId, prompt } = msg;

      log.info(`Executing task ${taskId}: ${prompt.slice(0, 80)}...`);

      // Send log to parent
      process.send?.({ type: "log", message: `Starting: ${prompt.slice(0, 100)}` });

      try {
        const message: Message = {
          id: taskId,
          role: "user",
          content: prompt,
          timestamp: Date.now(),
          source: "worker",
          userId: `worker:${workerId}`,
        };

        const result = await agent.handleMessage(message);

        process.send?.({
          type: "result",
          taskId,
          result,
        });

        log.info(`Task ${taskId} complete`);
      } catch (err: any) {
        log.error(`Task ${taskId} failed: ${err.message}`);
        process.send?.({
          type: "error",
          taskId,
          error: err.message,
        });
      }
    }

    if (msg.type === "ping") {
      process.send?.({ type: "pong", workerId });
    }

    if (msg.type === "shutdown") {
      log.info(`Worker ${workerName} shutting down`);
      process.exit(0);
    }
  });
}

init().catch((err) => {
  console.error(`Worker ${workerName} init failed:`, err);
  process.exit(1);
});

