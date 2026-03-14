import type { Skill, SkillContext } from "../core/types.js";
import { eventBus, Events } from "../core/eventbus.js";
import { createLogger } from "../core/logger.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const log = createLogger("evolution");
const EVOLUTION_DIR = path.join(os.homedir(), ".aegis", "evolution");
const ERROR_PATTERNS_FILE = path.join(EVOLUTION_DIR, "error-patterns.json");
const IMPROVEMENTS_FILE = path.join(EVOLUTION_DIR, "improvements.json");

interface ErrorPattern {
  pattern: string;
  count: number;
  lastSeen: number;
  source: string;
  autoFixed: boolean;
  fix?: string;
}

interface Improvement {
  id: string;
  type: "fix" | "optimization" | "new_rule" | "config_change";
  description: string;
  applied: boolean;
  timestamp: number;
  result?: string;
}

let errorPatterns: ErrorPattern[] = [];
let improvements: Improvement[] = [];

function ensureDir() { if (!fs.existsSync(EVOLUTION_DIR)) fs.mkdirSync(EVOLUTION_DIR, { recursive: true }); }
function loadData() {
  ensureDir();
  try { if (fs.existsSync(ERROR_PATTERNS_FILE)) errorPatterns = JSON.parse(fs.readFileSync(ERROR_PATTERNS_FILE, "utf-8")); } catch {}
  try { if (fs.existsSync(IMPROVEMENTS_FILE)) improvements = JSON.parse(fs.readFileSync(IMPROVEMENTS_FILE, "utf-8")); } catch {}
}
function saveData() {
  ensureDir();
  fs.writeFileSync(ERROR_PATTERNS_FILE, JSON.stringify(errorPatterns.slice(-200), null, 2));
  fs.writeFileSync(IMPROVEMENTS_FILE, JSON.stringify(improvements.slice(-100), null, 2));
}

// ── Auto-track errors from event bus ──────────────────────────
function trackError(source: string, message: string) {
  const key = message.replace(/[0-9]+/g, "N").replace(/\/[^\s]+/g, "/PATH").slice(0, 100);
  const existing = errorPatterns.find(p => p.pattern === key && p.source === source);
  if (existing) {
    existing.count++;
    existing.lastSeen = Date.now();
  } else {
    errorPatterns.push({ pattern: key, count: 1, lastSeen: Date.now(), source, autoFixed: false });
  }
  saveData();
}

// ── Known auto-fixes ──────────────────────────────────────────
const KNOWN_FIXES: Array<{
  pattern: RegExp;
  fix: string;
  apply: () => Promise<string>;
}> = [
  {
    pattern: /tools is not iterable/,
    fix: "Skill created with bad tools format — quarantine and regenerate",
    apply: async () => {
      const skillsDir = path.join(os.homedir(), ".aegis", "skills");
      if (!fs.existsSync(skillsDir)) return "No skills dir";
      const q = path.join(skillsDir, ".quarantine");
      if (!fs.existsSync(q)) fs.mkdirSync(q, { recursive: true });
      let fixed = 0;
      for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue;
        const idx = path.join(skillsDir, d.name, "index.js");
        if (!fs.existsSync(idx)) continue;
        const code = fs.readFileSync(idx, "utf-8");
        if (!code.includes("tools: [") && !code.includes("tools:[")) {
          fs.renameSync(path.join(skillsDir, d.name), path.join(q, d.name));
          fixed++;
        }
      }
      return `Quarantined ${fixed} broken skills`;
    },
  },
  {
    pattern: /module\.exports/,
    fix: "Replace module.exports with export default in custom skills",
    apply: async () => {
      const skillsDir = path.join(os.homedir(), ".aegis", "skills");
      if (!fs.existsSync(skillsDir)) return "No skills dir";
      let fixed = 0;
      for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue;
        const idx = path.join(skillsDir, d.name, "index.js");
        if (!fs.existsSync(idx)) continue;
        let code = fs.readFileSync(idx, "utf-8");
        if (code.includes("module.exports")) {
          code = code.replace(/module\.exports\s*=\s*/g, "export default ");
          fs.writeFileSync(idx, code);
          fixed++;
        }
      }
      return `Fixed exports in ${fixed} skills`;
    },
  },
  {
    pattern: /fetch failed|ECONNREFUSED.*11434/,
    fix: "Ollama connection lost — log for monitoring",
    apply: async () => { return "Ollama connection issue logged. Check: curl http://172.168.1.162:11434/api/version"; },
  },
  {
    pattern: /Cannot read properties of undefined/,
    fix: "Null reference — usually bad LLM output passed to tool",
    apply: async () => { return "Added to error log. The model sent malformed arguments to a tool."; },
  },
];

const evolution: Skill = {
  id: "builtin.evolution",
  name: "Self-Evolution",
  description: "Reviews its own errors, learns patterns, writes fixes, optimizes performance. Makes itself better over time.",
  version: "1.0.0",
  tools: [
    { name: "evolve_review", description: "Review recent errors, find patterns, and suggest or apply fixes automatically", parameters: [
      { name: "autofix", type: "boolean", description: "Auto-apply known fixes (default: true)", required: false },
    ]},
    { name: "evolve_patterns", description: "Show learned error patterns — what breaks most often", parameters: [
      { name: "limit", type: "number", description: "Max patterns (default: 20)", required: false },
    ]},
    { name: "evolve_improvements", description: "Show history of self-improvements applied", parameters: [] },
    { name: "evolve_add_rule", description: "Add a reactive event bus rule (when X happens, do Y)", parameters: [
      { name: "name", type: "string", description: "Rule name", required: true },
      { name: "event", type: "string", description: "Event pattern (e.g. 'tool:failure', 'system:*', '*')", required: true },
      { name: "action", type: "string", description: "What to do: 'log', 'alert', 'heal', or shell command", required: true },
    ]},
    { name: "evolve_rules", description: "List active event bus rules", parameters: [] },
    { name: "evolve_event_history", description: "Show recent events from the bus", parameters: [
      { name: "filter", type: "string", description: "Filter by event type pattern", required: false },
      { name: "limit", type: "number", description: "Max events (default: 30)", required: false },
    ]},
    { name: "evolve_fire_event", description: "Manually fire an event on the bus (for testing)", parameters: [
      { name: "type", type: "string", description: "Event type", required: true },
      { name: "data", type: "string", description: "JSON data payload", required: false },
    ]},
    { name: "evolve_stats", description: "Show evolution engine statistics", parameters: [] },
    { name: "evolve_report", description: "Generate a full self-assessment: errors, patterns, health, recommendations", parameters: [] },
  ],

  async onLoad() {
    loadData();
    // Wire into event bus — track all errors
    eventBus.addRule("evolution:track-errors", "tool:failure", (evt) => {
      trackError(evt.source, String(evt.data.error || ""));
    });
    eventBus.addRule("evolution:track-agent-errors", "agent:error", (evt) => {
      trackError("agent", String(evt.data.error || evt.data.message || ""));
    });
    log.info("Self-evolution engine active");
  },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    loadData();

    switch (toolName) {
      case "evolve_review": {
        const autofix = args.autofix !== false;
        const results: string[] = ["=== Self-Evolution Review ===\n"];

        // Find recurring errors
        const recurring = errorPatterns.filter(p => p.count >= 2).sort((a, b) => b.count - a.count).slice(0, 10);
        if (recurring.length === 0) {
          results.push("No recurring error patterns found. System is stable.");
          return results.join("\n");
        }

        results.push(`Found ${recurring.length} recurring error patterns:\n`);

        for (const ep of recurring) {
          results.push(`  [${ep.count}x] ${ep.source}: ${ep.pattern}`);

          if (autofix && !ep.autoFixed) {
            for (const fix of KNOWN_FIXES) {
              if (fix.pattern.test(ep.pattern)) {
                results.push(`    → Applying fix: ${fix.fix}`);
                const result = await fix.apply();
                results.push(`    → Result: ${result}`);
                ep.autoFixed = true;

                improvements.push({
                  id: `imp-${Date.now().toString(36)}`,
                  type: "fix",
                  description: `Auto-fixed: ${fix.fix}`,
                  applied: true,
                  timestamp: Date.now(),
                  result,
                });
                break;
              }
            }
          }
        }

        saveData();
        return results.join("\n");
      }

      case "evolve_patterns": {
        const limit = (args.limit as number) || 20;
        if (errorPatterns.length === 0) return "No error patterns recorded yet.";
        const sorted = [...errorPatterns].sort((a, b) => b.count - a.count).slice(0, limit);
        return sorted.map(p => {
          const ago = Math.round((Date.now() - p.lastSeen) / 60000);
          return `  [${p.count}x] ${p.source}: ${p.pattern}\n    Last: ${ago}m ago | Fixed: ${p.autoFixed ? "yes" : "no"}`;
        }).join("\n\n");
      }

      case "evolve_improvements": {
        if (improvements.length === 0) return "No improvements applied yet. Run evolve_review to start.";
        return improvements.slice(-20).map(imp => {
          const time = new Date(imp.timestamp).toLocaleString();
          return `  [${time}] ${imp.type}: ${imp.description}\n    Applied: ${imp.applied} | Result: ${imp.result || "—"}`;
        }).join("\n\n");
      }

      case "evolve_add_rule": {
        const name = args.name as string;
        const pattern = args.event as string;
        const action = args.action as string;

        let handler: (evt: any) => void;
        switch (action) {
          case "log":
            handler = (evt) => log.info(`[Rule:${name}] ${evt.type} from ${evt.source}: ${JSON.stringify(evt.data).slice(0, 100)}`);
            break;
          case "alert":
            handler = (evt) => {
              log.warn(`⚠ [Rule:${name}] ALERT: ${evt.type} from ${evt.source}`);
              const { addActivity } = require("../skills/scheduler.js");
              addActivity({ type: "error", source: `rule:${name}`, message: `Alert: ${evt.type}` });
            };
            break;
          case "heal":
            handler = (evt) => {
              log.info(`[Rule:${name}] Auto-heal triggered by ${evt.type}`);
              trackError(evt.source, String(evt.data.error || evt.type));
            };
            break;
          default:
            // Shell command
            handler = (evt) => {
              const { exec } = require("node:child_process");
              exec(action, { timeout: 30000 }, (err: any, stdout: string) => {
                if (err) log.error(`Rule "${name}" command failed: ${err.message}`);
                else log.info(`Rule "${name}" output: ${stdout.slice(0, 100)}`);
              });
            };
        }

        const id = eventBus.addRule(name, pattern, handler);
        return `Rule created: "${name}"\n  Pattern: ${pattern}\n  Action: ${action}\n  ID: ${id}`;
      }

      case "evolve_rules": {
        const rules = eventBus.getRules();
        if (rules.length === 0) return "No event rules active.";
        return rules.map(r =>
          `  [${r.id}] ${r.name}\n    Pattern: ${r.pattern} | Enabled: ${r.enabled} | Triggers: ${r.triggerCount}`
        ).join("\n\n");
      }

      case "evolve_event_history": {
        const limit = (args.limit as number) || 30;
        let history = eventBus.getHistory(limit);
        if (args.filter) {
          const f = args.filter as string;
          history = history.filter(e => e.type.includes(f));
        }
        if (history.length === 0) return "No events in history.";
        return history.map(e => {
          const t = new Date(e.timestamp).toLocaleTimeString();
          return `  [${t}] ${e.type} from ${e.source}: ${JSON.stringify(e.data).slice(0, 80)}`;
        }).join("\n");
      }

      case "evolve_fire_event": {
        let data: Record<string, unknown> = {};
        if (args.data) try { data = JSON.parse(args.data as string); } catch {}
        const evt = eventBus.fire(args.type as string, "manual", data);
        return `Event fired: ${evt.id}\n  Type: ${evt.type}\n  Matched rules: ${eventBus.getRules().filter(r => r.enabled).length}`;
      }

      case "evolve_stats": {
        const bs = eventBus.getStats();
        return [
          "Evolution Engine Stats",
          `  Error patterns tracked: ${errorPatterns.length}`,
          `  Improvements applied: ${improvements.length}`,
          `  Event bus: ${bs.emitted} emitted, ${bs.handled} handled, ${bs.errors} errors`,
          `  Active rules: ${bs.rules}`,
          `  Event history: ${bs.history}`,
        ].join("\n");
      }

      case "evolve_report": {
        const bs = eventBus.getStats();
        const recurring = errorPatterns.filter(p => p.count >= 3).sort((a, b) => b.count - a.count);
        const recentErrors = errorPatterns.filter(p => Date.now() - p.lastSeen < 3600000);
        const fixedCount = improvements.filter(i => i.applied).length;

        const report: string[] = [
          "═══ Kate Self-Assessment Report ═══\n",
          `Error Patterns: ${errorPatterns.length} tracked, ${recurring.length} recurring`,
          `Recent Errors (1hr): ${recentErrors.length}`,
          `Auto-Fixes Applied: ${fixedCount}`,
          `Event Bus: ${bs.emitted} events, ${bs.rules} rules`,
          "",
        ];

        if (recurring.length > 0) {
          report.push("Top Issues:");
          recurring.slice(0, 5).forEach(p => {
            report.push(`  ⚠ [${p.count}x] ${p.source}: ${p.pattern.slice(0, 60)}`);
          });
          report.push("");
        }

        // Recommendations
        report.push("Recommendations:");
        if (recurring.length > 5) report.push("  → High error rate. Run: evolve_review autofix=true");
        if (bs.rules < 3) report.push("  → Few event rules. Add monitoring with: evolve_add_rule");
        if (errorPatterns.some(p => p.pattern.includes("fetch failed"))) report.push("  → Ollama connection issues detected. Check server.");
        if (errorPatterns.some(p => p.pattern.includes("tools is not iterable"))) report.push("  → Broken skills found. Run: skill_fix_all");
        if (recurring.length === 0 && recentErrors.length === 0) report.push("  ✓ System is healthy. No action needed.");

        return report.join("\n");
      }

      default: return `Unknown: ${toolName}`;
    }
  },
};

export default evolution;

