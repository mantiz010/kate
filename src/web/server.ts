import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { KateConfig, Message } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { Agent } from "../core/agent.js";
import { ProviderRegistry } from "../providers/registry.js";
import { SkillManager } from "../skills/manager.js";
import { SQLiteMemory, InMemoryStore } from "../memory/store.js";
import { loadConfig } from "../core/config.js";
import { WorkerPool } from "../workers/pool.js";
import { getActivity, addActivity } from "../skills/scheduler.js";

const log = createLogger("web");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export async function startWebServer(port: number = 3201) {
  log.info("Starting web server...");

  // ── Init core ────────────────────────────────────────────
  const config = await loadConfig();

  let memory;
  try {
    memory = new SQLiteMemory(config.memory.dbPath);
  } catch {
    memory = new InMemoryStore();
  }

  const providers = new ProviderRegistry(config);
  const skills = new SkillManager();
  await skills.loadBuiltin(config.skills.builtin);
  await skills.loadFromDirectory(config.skills.directory || require("path").join(require("os").homedir(), ".kate", "skills"));

  const agent = new Agent(config, providers, skills, memory);
  const workerPool = new WorkerPool(config);
  const startTime = Date.now();

  // Track connected clients
  const clients = new Set<WebSocket>();
  let metricsHistory: any[] = [];

  // Auto-collect metrics every 30 seconds
  setInterval(async () => {
    const os = await import("node:os");
    metricsHistory.push({
      timestamp: Date.now(),
      cpu: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
      mem: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
      load: os.loadavg()[0],
      connections: clients.size,
      workers: workerPool.getActiveCount(),
    });
    if (metricsHistory.length > 360) metricsHistory.shift();
  }, 30000);

  // ── HTTP Server ──────────────────────────────────────────
  const webDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "web");

  const server = http.createServer(async (req, res) => {
    // API routes
    if (req.url === "/api/message" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", async () => {
          try {
            const data = JSON.parse(body);
        const response = await agent.handleMessage({ content: data.content, userId: "etbus:ha", sessionId: "etbus" });
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ response }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }
      if (req.url === "/api/logs") {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        try {
          const { stdout } = await execAsync("journalctl -u kate -n 100 --no-pager 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'", { timeout: 5000, maxBuffer: 1024 * 1024 });
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ logs: stdout.split("\n").filter(Boolean) }));
        } catch (e: any) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ logs: ["Error reading logs: " + e.message] }));
        }
        return;
      }
      if (req.url?.startsWith("/api/logs/etbus")) {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        try {
          const { stdout } = await execAsync("journalctl -u kate-etbus -n 50 --no-pager 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'", { timeout: 5000, maxBuffer: 1024 * 1024 });
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ logs: stdout.split("\n").filter(Boolean) }));
        } catch (e: any) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ logs: ["Error: " + e.message] }));
        }
        return;
      }
      if (req.url === "/api/history") {
        const { listSessions } = await import("../core/chathistory.js");
        const sessions = listSessions(30);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(sessions));
        return;
      }
      if (req.url?.startsWith("/api/history/search?q=")) {
        const { searchHistory } = await import("../core/chathistory.js");
        const q = decodeURIComponent(req.url.split("q=")[1] || "");
        const results = searchHistory(q);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(results));
        return;
      }
      if (req.url?.startsWith("/api/history/")) {
        const { getSession } = await import("../core/chathistory.js");
        const id = req.url.split("/api/history/")[1];
        const session = getSession(id);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(session || { error: "not found" }));
        return;
      }
      if (req.url === "/api/status") {
      const os = await import("node:os");
      const cacheStats = (agent as any).getCacheStats?.() || {};
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        agent: config.agent.name,
        provider: config.provider.default,
        model: config.provider.ollama.model,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        skills: skills.list().map(s => ({
          id: s.id, name: s.name, tools: s.tools.length, description: s.description,
        })),
        connections: clients.size,
        cache: cacheStats,
        system: {
          cpuUsage: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
          memTotal: os.totalmem(),
          memFree: os.freemem(),
          memUsage: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
          loadAvg: os.loadavg(),
          cpuCount: os.cpus().length,
          hostname: os.hostname(),
          platform: os.platform(),
        },
      }));
    }

    // Time-series metrics endpoint for dashboard graphs
    if (req.url === "/api/metrics") {
      const os = await import("node:os");
      const point = {
        timestamp: Date.now(),
        cpu: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
        mem: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
        load: os.loadavg()[0],
        connections: clients.size,
        workers: workerPool.getActiveCount(),
      };

      // Store in rolling buffer
      if (!metricsHistory) metricsHistory = [];
      metricsHistory.push(point);
      if (metricsHistory.length > 360) metricsHistory.shift(); // 3 hours at 30s intervals

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(metricsHistory));
    }

    if (req.url === "/api/skills") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(skills.list().map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        version: s.version,
        tools: s.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
      }))));
    }

    // ── Webhook receiver — HA, GitHub, Zigbee, custom ──
    if (req.url?.startsWith("/api/webhook") && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { eventBus, Events } = await import("../core/eventbus.js");
        const source = new URL(req.url, "http://localhost").searchParams.get("source") || "webhook";
        let data: any = {};
        try { data = JSON.parse(body); } catch { data = { raw: body }; }

        eventBus.fire(Events.WEBHOOK, source, data);
        log.info(`Webhook received from: ${source}`);

        // If webhook has a "prompt" field, send it to the agent
        if (data.prompt || data.message || data.command) {
          const prompt = data.prompt || data.message || data.command;
          const msg = {
            id: `webhook-${Date.now()}`, role: "user" as const,
            content: `[Webhook from ${source}] ${prompt}`,
            timestamp: Date.now(), source: "webhook", userId: source,
          };
          agent.handleMessage(msg).then(response => {
            log.info(`Webhook response: ${response.slice(0, 100)}`);
          }).catch(err => log.error(`Webhook handler error: ${err.message}`));
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, source, timestamp: Date.now() }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // ── Evolution API ──
    if (req.url === "/api/evolution") {
      try {
        const { evolution } = await import("../core/evolution.js");
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          stats: evolution.getStats(),
          patterns: evolution.getPatterns(),
          log: evolution.getLog(10),
        }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ stats: {}, patterns: {}, log: [] }));
      }
    }

    // ── Heartbeat API ──
    if (req.url === "/api/heartbeat") {
      try {
        const { heartbeat } = await import("../core/heartbeat.js");
        const s = heartbeat.getState();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          lastBeat: s.lastBeat, checks: s.checks,
          alerts: s.alerts.slice(-10), thresholds: s.thresholds,
        }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({}));
      }
    }

    // ── Event bus API ──
    if (req.url === "/api/events") {
      try {
        const { eventBus } = await import("../core/eventbus.js");
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          stats: eventBus.getStats(),
          rules: eventBus.getRules().map(r => ({ id: r.id, name: r.name, trigger: r.trigger, enabled: r.enabled, fires: r.fires })),
          history: eventBus.getHistory(20),
        }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ stats: {}, rules: [], history: [] }));
      }
    }

    if (req.url === "/api/activity" || req.url?.startsWith("/api/activity?")) {
      const limit = parseInt(new URL(req.url, "http://localhost").searchParams.get("limit") || "50");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(getActivity(limit)));
    }

    // Worker API routes
    if (req.url === "/api/workers") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        workers: workerPool.getWorkers(),
        stats: workerPool.getStats(),
        queue: workerPool.getQueue(),
        history: workerPool.getTaskHistory(20),
      }));
    }

    if (req.url === "/api/workers/spawn" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", async () => {
        try {
          const { name, model, count } = JSON.parse(body || "{}");
          const spawned = [];
          for (let i = 0; i < (count || 1); i++) {
            const info = await workerPool.spawnWorker(name, model);
            spawned.push(info);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(spawned));
          // Notify WebSocket clients
          broadcast({ type: "workers:update", data: workerPool.getStats() });
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.url === "/api/workers/task" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", async () => {
        try {
          const { prompt, priority, worker } = JSON.parse(body);
          if (workerPool.getActiveCount() === 0) await workerPool.spawnWorker();
          const task = await workerPool.submitTask(prompt, priority || 1, worker);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(task));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.url?.startsWith("/api/workers/kill/")) {
      const id = req.url.split("/").pop()!;
      let killed = true; if (id === "all") { await workerPool.shutdown(); } else { await workerPool.killWorker(id); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ killed }));
      broadcast({ type: "workers:update", data: workerPool.getStats() });
      return;
    }

    // Static files
    let filePath = req.url === "/" ? "/index.html" : req.url || "/index.html";
    filePath = path.join(webDir, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "text/plain";

    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch {
      res.writeHead(500);
      res.end("Server error");
    }
  });

  // ── WebSocket ────────────────────────────────────────────
  const wss = new WebSocketServer({ server });

  function broadcast(data: any) {
    const msg = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  // Forward worker events to all WebSocket clients
  workerPool.on("worker:spawned", (info) => broadcast({ type: "workers:spawned", data: info }));
  workerPool.on("worker:stopped", (info) => broadcast({ type: "workers:stopped", data: info }));
  workerPool.on("task:queued", (task) => broadcast({ type: "workers:task:queued", data: task }));
  workerPool.on("task:started", ({ task, worker }) => broadcast({ type: "workers:task:started", data: { task, worker } }));
  workerPool.on("task:done", ({ task, worker }) => broadcast({ type: "workers:task:done", data: { task, worker } }));
  workerPool.on("task:failed", ({ task, error }) => broadcast({ type: "workers:task:failed", data: { task, error } }));
  workerPool.on("worker:log", (msg) => broadcast({ type: "workers:log", data: msg }));

  wss.on("connection", (ws) => {
    clients.add(ws);
    log.info(`Client connected (${clients.size} total)`);

    // Send welcome
    ws.send(JSON.stringify({
      type: "system",
      content: `Connected to ${config.agent.name}. ${skills.list().length} skills, ${skills.getAllTools().length} tools ready.`,
      timestamp: Date.now(),
    }));

    ws.on("message", async (data) => {
      let parsed: any;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (parsed.type === "message") {
        const msg: Message = {
          id: Date.now().toString(),
          role: "user",
          content: parsed.content,
          timestamp: Date.now(),
          source: "web",
          userId: "web-user",
        };

        // Acknowledge
        ws.send(JSON.stringify({
          type: "status",
          content: "thinking",
          timestamp: Date.now(),
        }));

        try {
          addActivity({ type: "info", source: "web-user", message: `${parsed.content.slice(0, 100)}` });
          // Stream tokens to client
          agent.onToken = (token: string) => {
            try { ws.send(JSON.stringify({ type: "token", content: token })); } catch {}
          };
          const response = await agent.handleMessage(msg);
          agent.onToken = undefined;
          addActivity({ type: "info", source: "agent", message: `Done: ${response.slice(0, 80)}` });
          ws.send(JSON.stringify({
            type: "response",
            content: response,
            timestamp: Date.now(),
          }));
        } catch (err: any) {
          addActivity({ type: "error", source: "agent", message: err.message });
          ws.send(JSON.stringify({
            type: "error",
            content: err.message,
            timestamp: Date.now(),
          }));
        }
      }

      if (parsed.type === "command") {
        // Direct command execution
        const msg: Message = {
          id: Date.now().toString(),
          role: "user",
          content: parsed.content,
          timestamp: Date.now(),
          source: "web",
          userId: "web-user",
        };

        ws.send(JSON.stringify({ type: "status", content: "executing", timestamp: Date.now() }));

        try {
          addActivity({ type: "tool", source: "web-user", message: `Command: ${parsed.content.slice(0, 100)}` });
          // Stream tokens to client
          agent.onToken = (token: string) => {
            try { ws.send(JSON.stringify({ type: "token", content: token })); } catch {}
          };
          const response = await agent.handleMessage(msg);
          agent.onToken = undefined;
          addActivity({ type: "tool", source: "agent", message: `Result: ${response.slice(0, 80)}` });
          ws.send(JSON.stringify({ type: "response", content: response, timestamp: Date.now() }));
        } catch (err: any) {
          addActivity({ type: "error", source: "agent", message: err.message });
          ws.send(JSON.stringify({ type: "error", content: err.message, timestamp: Date.now() }));
        }
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      log.info(`Client disconnected (${clients.size} total)`);
    });
  });

  // Push activity feed to all clients every 3 seconds
  let lastActivityPush = 0;
  setInterval(() => {
    const recent = getActivity(10);
    const newItems = recent.filter(a => a.timestamp > lastActivityPush);
    if (newItems.length > 0 && clients.size > 0) {
      broadcast({ type: "activity", data: newItems });
      lastActivityPush = Date.now();
    }
  }, 3000);

  server.listen(port, "0.0.0.0", () => {
    log.info(`Web UI: http://localhost:${port}`);
    log.info(`Network: http://0.0.0.0:${port}`);
  });

  return server;
}

