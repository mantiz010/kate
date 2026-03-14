import type { Skill, SkillContext } from "../core/types.js";
import { eventBus, EVENTS } from "../core/eventbus.js";

const events: Skill = {
  id: "builtin.events",
  name: "Event Bus",
  description: "Subscribe to events, create automation rules, view event history. The nervous system of Kate — skills can react to each other automatically.",
  version: "1.0.0",
  tools: [
    { name: "event_fire", description: "Fire a custom event", parameters: [
      { name: "type", type: "string", description: "Event type (e.g. custom.alert, custom.deploy)", required: true },
      { name: "data", type: "string", description: "JSON data payload", required: false },
    ]},
    { name: "event_history", description: "View recent events", parameters: [
      { name: "type", type: "string", description: "Filter by type pattern (e.g. 'tool.*', 'health.*')", required: false },
      { name: "limit", type: "number", description: "Max events (default: 20)", required: false },
    ]},
    { name: "event_stats", description: "Show event bus statistics", parameters: [] },
    { name: "event_subscribe", description: "Subscribe to an event pattern and log when it fires", parameters: [
      { name: "pattern", type: "string", description: "Event pattern (e.g. 'tool.failed', 'health.*', '*')", required: true },
      { name: "label", type: "string", description: "Label for this subscription", required: false },
    ]},
    { name: "event_unsubscribe", description: "Remove a subscription", parameters: [
      { name: "pattern", type: "string", description: "Pattern to unsubscribe from", required: true },
    ]},
    { name: "event_list_subs", description: "List all active subscriptions", parameters: [] },
    { name: "event_rule_add", description: "Create an automation rule: when event X fires, do action Y. Actions are natural language that the agent will execute.", parameters: [
      { name: "when", type: "string", description: "Event pattern to trigger on (e.g. 'health.alert', 'tool.failed')", required: true },
      { name: "do", type: "string", description: "Action to perform — natural language (e.g. 'send MQTT alert', 'restart the service')", required: true },
    ]},
    { name: "event_rule_remove", description: "Remove an automation rule", parameters: [
      { name: "when", type: "string", description: "Event pattern of the rule to remove", required: true },
    ]},
    { name: "event_rule_list", description: "List all automation rules", parameters: [] },
    { name: "event_types", description: "List all known event types", parameters: [] },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "event_fire": {
        let data = {};
        if (args.data) try { data = JSON.parse(args.data as string); } catch {}
        const evt = eventBus.fire(args.type as string, `user:${ctx.userId}`, data);
        return `Event fired: ${evt.type} (${evt.id})`;
      }

      case "event_history": {
        const limit = (args.limit as number) || 20;
        const events = args.type
          ? eventBus.getByType(args.type as string, limit)
          : eventBus.getHistory(limit);
        if (events.length === 0) return "No events yet.";
        return events.map(e => {
          const t = new Date(e.timestamp).toLocaleTimeString();
          const data = Object.keys(e.data).length > 0 ? ` | ${JSON.stringify(e.data).slice(0, 80)}` : "";
          return `[${t}] ${e.type} ← ${e.source}${data}`;
        }).join("\n");
      }

      case "event_stats": {
        const s = eventBus.getStats();
        const lines = [`Event Bus Stats`, `  Total events: ${s.total}`, `  Subscriptions: ${s.subscriptions}`, `  Rules: ${s.rules}`, ``];
        if (Object.keys(s.byType).length > 0) {
          lines.push("  By category:");
          for (const [k, v] of Object.entries(s.byType).sort((a, b) => b[1] - a[1])) {
            lines.push(`    ${k}: ${v}`);
          }
        }
        return lines.join("\n");
      }

      case "event_subscribe": {
        const pattern = args.pattern as string;
        const label = (args.label as string) || pattern;
        eventBus.subscribe(pattern, `user:${label}`, (evt) => {
          ctx.log.info(`[EVENT] ${evt.type}: ${JSON.stringify(evt.data).slice(0, 100)}`);
        });
        return `Subscribed to: ${pattern}`;
      }

      case "event_unsubscribe": {
        eventBus.unsubscribe(args.pattern as string);
        return `Unsubscribed from: ${args.pattern}`;
      }

      case "event_list_subs": {
        const subs = eventBus.getSubs();
        if (subs.length === 0) return "No active subscriptions.";
        return subs.map(s => `  ${s.pattern} ← ${s.source}`).join("\n");
      }

      case "event_rule_add": {
        eventBus.addRule(args.when as string, args.do as string);
        return `Rule added: WHEN "${args.when}" → DO "${args.do}"`;
      }

      case "event_rule_remove": {
        eventBus.removeRule(args.when as string);
        return `Rule removed: ${args.when}`;
      }

      case "event_rule_list": {
        const rules = eventBus.getRules();
        if (rules.length === 0) return "No rules. Create one: event_rule_add when='tool.failed' do='send alert via MQTT'";
        return rules.map((r, i) =>
          `${i + 1}. WHEN "${r.pattern}" → DO "${r.action}" [${r.enabled ? "on" : "off"}]`
        ).join("\n");
      }

      case "event_types": {
        return Object.entries(EVENTS).map(([k, v]) => `  ${v.padEnd(28)} (${k})`).join("\n");
      }

      default: return `Unknown: ${toolName}`;
    }
  },
};
export default events;

