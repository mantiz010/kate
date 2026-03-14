import { EventEmitter } from "node:events";
import { createLogger } from "./logger.js";

const log = createLogger("eventbus");

export interface KateEvent {
  id: string;
  type: string;
  source: string;
  data: Record<string, any>;
  timestamp: number;
}

export type EventHandler = (event: KateEvent) => Promise<void> | void;

interface Subscription {
  pattern: string;
  handler: EventHandler;
  source: string;
  once: boolean;
}

class KateEventBus extends EventEmitter {
  private subs: Subscription[] = [];
  private history: KateEvent[] = [];
  private maxHistory = 500;
  private rules: Array<{ pattern: string; action: string; enabled: boolean }> = [];

  fire(type: string, source: string, data: Record<string, any> = {}): KateEvent {
    const event: KateEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type, source, data, timestamp: Date.now(),
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.shift();
    log.debug(`Event: ${type} from ${source}`);

    for (const sub of [...this.subs]) {
      if (this.match(sub.pattern, type)) {
        try { sub.handler(event); } catch (err: any) { log.error(`Handler error: ${err.message}`); }
        if (sub.once) this.subs = this.subs.filter(s => s !== sub);
      }
    }
    this.emit(type, event);
    this.emit("*", event);
    return event;
  }

  subscribe(pattern: string, source: string, handler: EventHandler, once = false): void {
    this.subs.push({ pattern, handler, source, once });
    log.debug(`Sub: ${source} → ${pattern}`);
  }

  unsubscribe(pattern: string, source?: string): void {
    this.subs = this.subs.filter(s => !(s.pattern === pattern && (!source || s.source === source)));
  }

  addRule(pattern: string, action: string): void {
    this.rules.push({ pattern, action, enabled: true });
    log.info(`Rule: ${pattern} → ${action}`);
  }

  removeRule(pattern: string): void {
    this.rules = this.rules.filter(r => r.pattern !== pattern);
  }

  getRules(): Array<{ pattern: string; action: string; enabled: boolean }> {
    return [...this.rules];
  }

  getMatchingRules(eventType: string): string[] {
    return this.rules.filter(r => r.enabled && this.match(r.pattern, eventType)).map(r => r.action);
  }

  getHistory(limit = 50): KateEvent[] { return this.history.slice(-limit); }

  getByType(type: string, limit = 20): KateEvent[] {
    return this.history.filter(e => this.match(type, e.type)).slice(-limit);
  }

  getStats(): { total: number; byType: Record<string, number>; subscriptions: number; rules: number } {
    const byType: Record<string, number> = {};
    for (const e of this.history) { const p = e.type.split(".")[0]; byType[p] = (byType[p] || 0) + 1; }
    return { total: this.history.length, byType, subscriptions: this.subs.length, rules: this.rules.length };
  }

  getSubs(): Array<{ pattern: string; source: string }> {
    return this.subs.map(s => ({ pattern: s.pattern, source: s.source }));
  }

  private match(pattern: string, type: string): boolean {
    if (pattern === "*" || pattern === type) return true;
    const pp = pattern.split("."), tp = type.split(".");
    for (let i = 0; i < pp.length; i++) {
      if (pp[i] === "*") return true;
      if (pp[i] !== tp[i]) return false;
    }
    return pp.length === tp.length;
  }

  clear(): void { this.history = []; this.subs = []; this.rules = []; }
}

export const eventBus = new KateEventBus();

export const EVENTS = {
  AGENT_START: "agent.start", AGENT_ERROR: "agent.error",
  TOOL_CALLED: "tool.called", TOOL_SUCCESS: "tool.success", TOOL_FAILED: "tool.failed",
  FILE_CREATED: "file.created", FILE_MODIFIED: "file.modified",
  WORKER_SPAWNED: "worker.spawned", WORKER_TASK_DONE: "worker.task.done", WORKER_TASK_FAILED: "worker.task.failed",
  HEALTH_ALERT: "health.alert", HEALTH_CRITICAL: "health.critical",
  TASK_COMPLETED: "scheduler.task.completed", TASK_FAILED: "scheduler.task.failed",
  MEMORY_STORED: "memory.stored",
  SKILL_CREATED: "skill.created", SKILL_ERROR: "skill.error",
  WEBHOOK_RECEIVED: "webhook.received", MQTT_MESSAGE: "mqtt.message",
  MESSAGE_RECEIVED: "message.received", RESPONSE_SENT: "response.sent",
};

