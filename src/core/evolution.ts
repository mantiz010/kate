import { createLogger } from "./logger.js";
import { eventBus, Events } from "./eventbus.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const log = createLogger("evolution");
const EVOLVE_DIR = path.join(os.homedir(), ".kate", "evolution");
const EVOLVE_LOG = path.join(EVOLVE_DIR, "history.json");

interface ErrorPattern {
  pattern: string;
  count: number;
  lastSeen: number;
  sources: string[];
  resolution?: string;
  autoFixed: boolean;
}

interface EvolutionEntry {
  timestamp: number;
  type: "fix" | "improve" | "learn";
  source: string;
  problem: string;
  solution: string;
  applied: boolean;
}

let errorPatterns: Record<string, ErrorPattern> = {};
let evolutionLog: EvolutionEntry[] = [];

function ensureDir() { if (!fs.existsSync(EVOLVE_DIR)) fs.mkdirSync(EVOLVE_DIR, { recursive: true }); }
function loadState() {
  ensureDir();
  try { if (fs.existsSync(EVOLVE_LOG)) evolutionLog = JSON.parse(fs.readFileSync(EVOLVE_LOG, "utf-8")); } catch {}
  try {
    const pf = path.join(EVOLVE_DIR, "patterns.json");
    if (fs.existsSync(pf)) errorPatterns = JSON.parse(fs.readFileSync(pf, "utf-8"));
  } catch {}
}
function saveState() {
  ensureDir();
  fs.writeFileSync(EVOLVE_LOG, JSON.stringify(evolutionLog.slice(-200), null, 2));
  fs.writeFileSync(path.join(EVOLVE_DIR, "patterns.json"), JSON.stringify(errorPatterns, null, 2));
}

// ── Known auto-fixes ───────────────────────────────────────
const AUTO_FIXES: Array<{
  match: RegExp;
  category: string;
  fix: () => Promise<string>;
}> = [
  {
    match: /tools is not iterable/,
    category: "skill_format",
    fix: async () => {
      const skillsDir = path.join(os.homedir(), ".kate", "skills");
      if (!fs.existsSync(skillsDir)) return "No skills dir";
      let fixed = 0;
      for (const dir of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
        const idx = path.join(skillsDir, dir.name, "index.js");
        if (!fs.existsSync(idx)) continue;
        const code = fs.readFileSync(idx, "utf-8");
        if (!code.includes("tools: [") && !code.includes("tools:[")) {
          const q = path.join(skillsDir, ".quarantine");
          if (!fs.existsSync(q)) fs.mkdirSync(q, { recursive: true });
          fs.renameSync(path.join(skillsDir, dir.name), path.join(q, dir.name));
          fixed++;
        }
      }
      return `Quarantined ${fixed} broken skill(s)`;
    },
  },
  {
    match: /Cannot read properties of undefined \(reading 'map'\)/,
    category: "null_data",
    fix: async () => "Likely bad tool args from LLM. Pattern logged for prompt improvement.",
  },
  {
    match: /module\.exports/,
    category: "commonjs_skill",
    fix: async () => {
      const skillsDir = path.join(os.homedir(), ".kate", "skills");
      if (!fs.existsSync(skillsDir)) return "No skills";
      let fixed = 0;
      for (const dir of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
        const idx = path.join(skillsDir, dir.name, "index.js");
        if (!fs.existsSync(idx)) continue;
        let code = fs.readFileSync(idx, "utf-8");
        if (code.includes("module.exports")) {
          code = code.replace(/module\.exports\s*=\s*/g, "export default ");
          fs.writeFileSync(idx, code);
          fixed++;
        }
      }
      return `Fixed module.exports in ${fixed} skill(s)`;
    },
  },
  {
    match: /ECONNREFUSED.*11434/,
    category: "ollama_down",
    fix: async () => "Ollama connection refused. It may have crashed or the host is unreachable.",
  },
  {
    match: /fetch failed/,
    category: "network_error",
    fix: async () => "Network request failed. Check Ollama host connectivity or internet connection.",
  },
  {
    match: /ENOSPC/,
    category: "disk_full",
    fix: async () => {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(exec);
      await run("npm cache clean --force 2>/dev/null; rm -rf /tmp/kate-* 2>/dev/null").catch(() => {});
      return "Cleaned caches. Check disk space with df -h.";
    },
  },
];

// ── Core evolution engine ──────────────────────────────────

export class EvolutionEngine {
  private running = false;

  start() {
    if (this.running) return;
    this.running = true;
    loadState();

    // Listen to all tool failures
    eventBus.addRule({
      id: "evolve-tool-fail",
      name: "Self-Evolution: Tool Failure Tracker",
      trigger: Events.TOOL_FAIL,
      enabled: true,
      action: async (event) => {
        const error = (event.data.error as string) || "";
        const source = event.data.toolName as string || event.source;
        await this.processError(error, source);
      },
    });

    // Listen to skill errors
    eventBus.addRule({
      id: "evolve-skill-error",
      name: "Self-Evolution: Skill Error Tracker",
      trigger: Events.SKILL_ERROR,
      enabled: true,
      action: async (event) => {
        const error = (event.data.error as string) || "";
        await this.processError(error, event.source);
      },
    });

    // Periodic self-review (every 30 minutes)
    setInterval(() => this.selfReview(), 30 * 60 * 1000);

    log.info("Evolution engine started — watching for errors to learn from");
    eventBus.fire(Events.EVOLVE_START, "evolution", { message: "Self-evolution active" });
  }

  async processError(error: string, source: string) {
    const key = this.categorizeError(error);

    if (!errorPatterns[key]) {
      errorPatterns[key] = { pattern: error.slice(0, 200), count: 0, lastSeen: 0, sources: [], autoFixed: false };
    }

    const p = errorPatterns[key];
    p.count++;
    p.lastSeen = Date.now();
    if (!p.sources.includes(source)) p.sources.push(source);

    log.info(`Error pattern "${key}": count=${p.count}, source=${source}`);

    // Auto-fix if we've seen this 2+ times
    if (p.count >= 2 && !p.autoFixed) {
      const fix = AUTO_FIXES.find(f => f.match.test(error));
      if (fix) {
        log.info(`Auto-fixing: ${fix.category}`);
        const result = await fix.fix();
        p.autoFixed = true;
        p.resolution = result;

        evolutionLog.push({
          timestamp: Date.now(), type: "fix", source,
          problem: error.slice(0, 200), solution: result, applied: true,
        });

        eventBus.fire(Events.EVOLVE_FIX, "evolution", {
          category: fix.category, error: error.slice(0, 100), fix: result,
        });

        log.info(`Self-fix applied: ${result}`);
      } else {
        // Log for manual review
        evolutionLog.push({
          timestamp: Date.now(), type: "learn", source,
          problem: error.slice(0, 200), solution: "No auto-fix available. Pattern logged.", applied: false,
        });
      }
    }

    saveState();
  }

  async selfReview() {
    log.info("Running self-review...");
    loadState();

    const now = Date.now();
    const recentErrors = Object.entries(errorPatterns)
      .filter(([_, p]) => now - p.lastSeen < 3600000) // last hour
      .sort((a, b) => b[1].count - a[1].count);

    if (recentErrors.length === 0) {
      log.info("Self-review: No recent errors. System healthy.");
      eventBus.fire(Events.HEALTH_OK, "evolution", { message: "Self-review passed" });
      return;
    }

    // Check for recurring unfixed errors
    const unfixed = recentErrors.filter(([_, p]) => !p.autoFixed && p.count >= 3);
    if (unfixed.length > 0) {
      log.warn(`Self-review: ${unfixed.length} recurring unfixed error pattern(s)`);
      for (const [key, p] of unfixed) {
        log.warn(`  "${key}": ${p.count}x from ${p.sources.join(", ")}`);
      }
      eventBus.fire(Events.HEALTH_WARN, "evolution", {
        message: `${unfixed.length} recurring error patterns`,
        patterns: unfixed.map(([k, p]) => ({ key: k, count: p.count })),
      });
    }

    // Check skills health
    const skillsDir = path.join(os.homedir(), ".kate", "skills");
    if (fs.existsSync(skillsDir)) {
      const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith("."));
      let broken = 0;
      for (const dir of dirs) {
        const idx = path.join(skillsDir, dir.name, "index.js");
        if (!fs.existsSync(idx)) { broken++; continue; }
        const code = fs.readFileSync(idx, "utf-8");
        if (!code.includes("export default") || !code.includes("tools:")) broken++;
      }
      if (broken > 0) {
        log.warn(`Self-review: ${broken} broken custom skill(s) found`);
        // Auto-quarantine
        eventBus.fire(Events.SKILL_ERROR, "evolution", { error: `${broken} broken skills`, count: broken });
      }
    }
  }

  private categorizeError(error: string): string {
    for (const fix of AUTO_FIXES) {
      if (fix.match.test(error)) return fix.category;
    }
    // Generic categorization
    if (error.includes("ECONNREFUSED")) return "connection_refused";
    if (error.includes("ETIMEOUT") || error.includes("timeout")) return "timeout";
    if (error.includes("ENOENT")) return "file_not_found";
    if (error.includes("EACCES")) return "permission_denied";
    if (error.includes("SyntaxError")) return "syntax_error";
    return "unknown:" + error.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "_");
  }

  getPatterns(): Record<string, ErrorPattern> { return { ...errorPatterns }; }
  getLog(limit = 30): EvolutionEntry[] { return evolutionLog.slice(-limit); }
  getStats() {
    return {
      totalPatterns: Object.keys(errorPatterns).length,
      totalFixes: evolutionLog.filter(e => e.type === "fix" && e.applied).length,
      totalLearned: evolutionLog.filter(e => e.type === "learn").length,
      recentErrors: Object.values(errorPatterns).filter(p => Date.now() - p.lastSeen < 3600000).length,
    };
  }
}

export const evolution = new EvolutionEngine();

