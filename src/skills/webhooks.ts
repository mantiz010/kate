import type { Skill, SkillContext } from "../core/types.js";
import { eventBus, EVENTS } from "../core/eventbus.js";
import { createLogger } from "../core/logger.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const log = createLogger("webhooks");
const HOOKS_FILE = path.join(os.homedir(), ".aegis", "webhooks.json");

interface WebhookDef {
  id: string;
  name: string;
  path: string;          // e.g. /webhook/github, /webhook/ha
  secret?: string;       // optional auth
  action: string;        // "event", "command", or shell command
  eventType?: string;    // event type to fire
  enabled: boolean;
  hits: number;
  lastHit?: number;
}

let hooks: WebhookDef[] = [];
let webhookServer: http.Server | null = null;

function load() { try { if (fs.existsSync(HOOKS_FILE)) hooks = JSON.parse(fs.readFileSync(HOOKS_FILE, "utf-8")); } catch {} }
function save() { const d = path.dirname(HOOKS_FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(HOOKS_FILE, JSON.stringify(hooks, null, 2)); }

const webhooks: Skill = {
  id: "builtin.webhooks",
  name: "Webhooks",
  description: "Receive webhook events from Home Assistant, GitHub, Zigbee2MQTT, and custom sources. Triggers event bus rules and agent actions.",
  version: "1.0.0",
  tools: [
    { name: "webhook_create", description: "Create a new webhook endpoint", parameters: [
      { name: "name", type: "string", description: "Webhook name", required: true },
      { name: "path", type: "string", description: "URL path (e.g. /webhook/github)", required: true },
      { name: "action", type: "string", description: "Action: 'event' (fires event bus), 'log', or a shell command", required: true },
      { name: "eventType", type: "string", description: "Event type to fire (if action=event)", required: false },
      { name: "secret", type: "string", description: "Auth secret (sent as ?secret= or X-Webhook-Secret header)", required: false },
    ]},
    { name: "webhook_list", description: "List all webhook endpoints", parameters: [] },
    { name: "webhook_delete", description: "Delete a webhook", parameters: [
      { name: "id", type: "string", description: "Webhook ID", required: true },
    ]},
    { name: "webhook_start", description: "Start the webhook listener server", parameters: [
      { name: "port", type: "number", description: "Port (default: 3201)", required: false },
    ]},
    { name: "webhook_stop", description: "Stop the webhook listener", parameters: [] },
    { name: "webhook_test", description: "Send a test webhook to yourself", parameters: [
      { name: "path", type: "string", description: "Webhook path to test", required: true },
      { name: "data", type: "string", description: "JSON payload", required: false },
    ]},
    { name: "webhook_history", description: "Show recent webhook hits", parameters: [
      { name: "limit", type: "number", description: "Max entries (default: 20)", required: false },
    ]},
    { name: "webhook_setup_ha", description: "Generate Home Assistant automation YAML to send webhooks to Kate", parameters: [
      { name: "trigger", type: "string", description: "HA trigger (e.g. 'state change', 'button press', 'motion detected')", required: true },
      { name: "entity", type: "string", description: "HA entity ID (e.g. binary_sensor.motion)", required: true },
    ]},
  ],

  async onLoad() { load(); },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    load();

    switch (toolName) {
      case "webhook_create": {
        const hook: WebhookDef = {
          id: `wh-${Date.now().toString(36)}`,
          name: args.name as string,
          path: (args.path as string).startsWith("/") ? args.path as string : "/" + args.path,
          action: args.action as string,
          eventType: args.eventType as string,
          secret: args.secret as string,
          enabled: true, hits: 0,
        };
        hooks.push(hook);
        save();
        return `Webhook created: ${hook.name}\n  URL: http://YOUR_IP:3201${hook.path}\n  Action: ${hook.action}\n  ID: ${hook.id}`;
      }

      case "webhook_list": {
        if (hooks.length === 0) return "No webhooks. Create one with webhook_create.";
        return hooks.map(h =>
          `  ${h.enabled ? "●" : "○"} [${h.id}] ${h.name}\n    Path: ${h.path} | Action: ${h.action} | Hits: ${h.hits}`
        ).join("\n\n");
      }

      case "webhook_delete": {
        hooks = hooks.filter(h => h.id !== args.id);
        save();
        return `Deleted webhook: ${args.id}`;
      }

      case "webhook_start": {
        const port = (args.port as number) || 3201;
        if (webhookServer) return "Webhook server already running.";

        const hitLog: Array<{ timestamp: number; path: string; data: any }> = [];

        webhookServer = http.createServer(async (req, res) => {
          const url = new URL(req.url || "/", `http://localhost:${port}`);
          const hookPath = url.pathname;

          // Find matching webhook
          const hook = hooks.find(h => h.enabled && h.path === hookPath);
          if (!hook) {
            if (hookPath === "/health") {
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ status: "ok", webhooks: hooks.length }));
            }
            res.writeHead(404);
            return res.end("Not found");
          }

          // Auth check
          if (hook.secret) {
            const qSecret = url.searchParams.get("secret");
            const hSecret = req.headers["x-webhook-secret"];
            if (qSecret !== hook.secret && hSecret !== hook.secret) {
              res.writeHead(401);
              return res.end("Unauthorized");
            }
          }

          // Read body
          let body = "";
          for await (const chunk of req) body += chunk;
          let data: any = {};
          try { data = JSON.parse(body); } catch { data = { raw: body }; }

          hook.hits++;
          hook.lastHit = Date.now();
          save();

          hitLog.push({ timestamp: Date.now(), path: hookPath, data });
          if (hitLog.length > 100) hitLog.shift();

          log.info(`Webhook: ${hook.name} (${hookPath}) — ${hook.action}`);

          // Execute action
          if (hook.action === "event") {
            eventBus.fire(hook.eventType || EVENTS.WEBHOOK, `webhook:${hook.name}`, data);
          } else if (hook.action === "log") {
            log.info(`Webhook data: ${JSON.stringify(data).slice(0, 200)}`);
          } else {
            // Shell command
            const { exec } = await import("node:child_process");
            exec(hook.action, { timeout: 30000, env: { ...process.env, WEBHOOK_DATA: JSON.stringify(data) } });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ received: true, webhook: hook.name }));
        });

        webhookServer.listen(port, "0.0.0.0", () => {
          log.info(`Webhook server: http://0.0.0.0:${port}`);
        });

        // Store hitLog reference for history
        (webhookServer as any)._hitLog = hitLog;

        return `Webhook server started on port ${port}\n  Health: http://localhost:${port}/health\n  Webhooks: ${hooks.length} registered`;
      }

      case "webhook_stop": {
        if (!webhookServer) return "No webhook server running.";
        webhookServer.close();
        webhookServer = null;
        return "Webhook server stopped.";
      }

      case "webhook_test": {
        const port = 3201;
        const data = args.data ? JSON.parse(args.data as string) : { test: true, timestamp: Date.now() };
        try {
          const res = await fetch(`http://localhost:${port}${args.path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          const result = await res.text();
          return `Test webhook ${args.path}: ${res.status}\n${result}`;
        } catch (err: any) {
          return `Test failed: ${err.message}. Is webhook server running?`;
        }
      }

      case "webhook_history": {
        const limit = (args.limit as number) || 20;
        if (!webhookServer || !(webhookServer as any)._hitLog) return "No webhook server running.";
        const hitLog = (webhookServer as any)._hitLog as Array<{ timestamp: number; path: string; data: any }>;
        if (hitLog.length === 0) return "No webhook hits yet.";
        return hitLog.slice(-limit).map(h => {
          const t = new Date(h.timestamp).toLocaleTimeString();
          return `  [${t}] ${h.path}: ${JSON.stringify(h.data).slice(0, 80)}`;
        }).join("\n");
      }

      case "webhook_setup_ha": {
        const trigger = args.trigger as string;
        const entity = args.entity as string;
        const yaml = `# Home Assistant Automation — send webhook to Kate
automation:
  - alias: "Kate: ${trigger}"
    trigger:
      - platform: state
        entity_id: ${entity}
    action:
      - service: rest_command.aegis_webhook
        data:
          entity_id: "${entity}"
          state: "{{ trigger.to_state.state }}"
          old_state: "{{ trigger.from_state.state }}"

# Add this to configuration.yaml:
rest_command:
  kate_webhook:
    url: "http://172.168.1.72:3201/webhook/ha"
    method: POST
    content_type: "application/json"
    payload: '{"entity_id":"{{ entity_id }}","state":"{{ state }}","old_state":"{{ old_state }}"}'
`;
        return yaml;
      }

      default: return `Unknown: ${toolName}`;
    }
  },
};
export default webhooks;

