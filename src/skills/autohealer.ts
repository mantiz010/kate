import type { Skill, SkillContext } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const log = createLogger("autohealer");

interface ErrorRecord {
  timestamp: number;
  type: string;
  message: string;
  source: string;
  resolved: boolean;
  resolution?: string;
}

const ERROR_LOG = path.join(os.homedir(), ".aegis", "error-log.json");
let errorHistory: ErrorRecord[] = [];

function loadErrors() {
  try { if (fs.existsSync(ERROR_LOG)) errorHistory = JSON.parse(fs.readFileSync(ERROR_LOG, "utf-8")); } catch {}
}
function saveErrors() {
  const dir = path.dirname(ERROR_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ERROR_LOG, JSON.stringify(errorHistory.slice(-200), null, 2));
}

// Known error patterns and their fixes
const AUTO_FIXES: Array<{
  pattern: RegExp;
  type: string;
  fix: (match: RegExpMatchArray, ctx: SkillContext) => Promise<string>;
}> = [
  {
    pattern: /Cannot find module '([^']+)'/,
    type: "missing_module",
    fix: async (match) => {
      const mod = match[1];
      const pkg = mod.split("/")[0].replace(/^@/, "");
      try {
        await execAsync(`npm install ${pkg}`, { cwd: path.join(os.homedir(), "kate"), timeout: 60000 });
        return `Installed missing module: ${pkg}`;
      } catch (err: any) {
        return `Failed to install ${pkg}: ${err.message}`;
      }
    },
  },
  {
    pattern: /EACCES.*permission denied.*'([^']+)'/,
    type: "permission_denied",
    fix: async (match) => {
      const filePath = match[1];
      try {
        await execAsync(`chmod 755 "${filePath}"`);
        return `Fixed permissions on: ${filePath}`;
      } catch {
        return `Could not fix permissions on ${filePath} — may need sudo`;
      }
    },
  },
  {
    pattern: /ENOSPC/,
    type: "disk_full",
    fix: async () => {
      const cleaned = await execAsync("npm cache clean --force 2>&1 && rm -rf /tmp/kate-* 2>/dev/null; echo 'Cleaned caches'");
      return cleaned.stdout;
    },
  },
  {
    pattern: /ECONNREFUSED.*:11434/,
    type: "ollama_down",
    fix: async () => {
      try {
        await execAsync("ollama serve &", { timeout: 5000 });
        return "Attempted to start Ollama. Wait a few seconds and retry.";
      } catch {
        return "Ollama is not running and couldn't be started. Run: ollama serve";
      }
    },
  },
  {
    pattern: /module\.exports/,
    type: "bad_skill_format",
    fix: async (match, ctx) => {
      // Find and fix bad skills
      const skillsDir = path.join(os.homedir(), ".aegis", "skills");
      if (!fs.existsSync(skillsDir)) return "No custom skills directory.";

      const fixed: string[] = [];
      const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith("."));

      for (const dir of dirs) {
        const indexPath = path.join(skillsDir, dir.name, "index.js");
        if (!fs.existsSync(indexPath)) continue;
        let code = fs.readFileSync(indexPath, "utf-8");

        if (code.includes("module.exports")) {
          code = code.replace(/module\.exports\s*=\s*/g, "export default ");
          fs.writeFileSync(indexPath, code);
          fixed.push(dir.name);
        }
      }

      return fixed.length > 0
        ? `Fixed module.exports in skills: ${fixed.join(", ")}`
        : "No skills with module.exports found.";
    },
  },
  {
    pattern: /skill\.tools is not iterable/,
    type: "bad_skill_structure",
    fix: async () => {
      const skillsDir = path.join(os.homedir(), ".aegis", "skills");
      if (!fs.existsSync(skillsDir)) return "No custom skills.";

      const removed: string[] = [];
      const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith("."));

      for (const dir of dirs) {
        const indexPath = path.join(skillsDir, dir.name, "index.js");
        if (!fs.existsSync(indexPath)) continue;
        const code = fs.readFileSync(indexPath, "utf-8");

        if (!code.includes("tools:") || !code.includes("tools: [")) {
          // Move to quarantine
          const quarantine = path.join(skillsDir, ".quarantine", dir.name);
          if (!fs.existsSync(path.dirname(quarantine))) fs.mkdirSync(path.dirname(quarantine), { recursive: true });
          fs.renameSync(path.join(skillsDir, dir.name), quarantine);
          removed.push(dir.name);
        }
      }

      return removed.length > 0
        ? `Quarantined broken skills: ${removed.join(", ")}\nMoved to ~/.aegis/skills/.quarantine/`
        : "No structurally broken skills found.";
    },
  },
  {
    pattern: /ENOMEM|JavaScript heap out of memory/,
    type: "out_of_memory",
    fix: async () => {
      return "Out of memory detected. Suggestions:\n- Reduce worker count\n- Use a smaller model\n- Close other applications\n- Set NODE_OPTIONS=--max-old-space-size=4096";
    },
  },
];

const autohealer: Skill = {
  id: "builtin.autohealer",
  name: "Auto-Healer",
  description: "Automatically detects and fixes common errors — missing modules, broken skills, permission issues, connection failures. Maintains an error log and can self-diagnose.",
  version: "1.0.0",
  tools: [
    { name: "heal_diagnose", description: "Analyze an error message and suggest or apply a fix", parameters: [
      { name: "error", type: "string", description: "The error message to diagnose", required: true },
      { name: "autofix", type: "boolean", description: "Automatically apply the fix (default: true)", required: false },
    ]},
    { name: "heal_scan", description: "Scan the Kate installation for common problems and fix them", parameters: [] },
    { name: "heal_skills", description: "Scan all custom skills for format errors and fix or quarantine them", parameters: [] },
    { name: "heal_deps", description: "Check and fix missing npm dependencies", parameters: [] },
    { name: "heal_config", description: "Validate Kate config and fix common issues", parameters: [] },
    { name: "heal_history", description: "Show recent error history and what was fixed", parameters: [
      { name: "limit", type: "number", description: "Number of entries (default: 20)", required: false },
    ]},
    { name: "heal_clear", description: "Clear error history", parameters: [] },
  ],

  async onLoad() { loadErrors(); },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "heal_diagnose": {
        const error = args.error as string;
        const autofix = args.autofix !== false;
        const results: string[] = [];

        let matched = false;
        for (const fix of AUTO_FIXES) {
          const match = error.match(fix.pattern);
          if (match) {
            matched = true;
            results.push(`Detected: ${fix.type}`);

            if (autofix) {
              const resolution = await fix.fix(match, ctx);
              results.push(`Fix applied: ${resolution}`);
              errorHistory.push({
                timestamp: Date.now(), type: fix.type, message: error.slice(0, 200),
                source: "diagnose", resolved: true, resolution,
              });
            } else {
              results.push(`Fix available but autofix=false. Set autofix=true to apply.`);
              errorHistory.push({
                timestamp: Date.now(), type: fix.type, message: error.slice(0, 200),
                source: "diagnose", resolved: false,
              });
            }
          }
        }

        if (!matched) {
          results.push("No automatic fix available for this error.");
          results.push("Suggestions:");
          results.push("  - Check the error message for file paths or module names");
          results.push("  - Try: heal_scan for a full system check");
          results.push("  - Try: heal_skills to fix broken plugins");
          errorHistory.push({
            timestamp: Date.now(), type: "unknown", message: error.slice(0, 200),
            source: "diagnose", resolved: false,
          });
        }

        saveErrors();
        return results.join("\n");
      }

      case "heal_scan": {
        const results: string[] = ["=== Kate Health Scan ===", ""];
        const kateDir = path.join(os.homedir(), "kate");

        // Check node_modules
        if (!fs.existsSync(path.join(kateDir, "node_modules"))) {
          results.push("✗ node_modules missing — running npm install...");
          try {
            await execAsync("npm install", { cwd: kateDir, timeout: 120000 });
            results.push("  ✓ Fixed");
          } catch { results.push("  ✗ npm install failed"); }
        } else {
          results.push("✓ node_modules present");
        }

        // Check config
        const configPath = path.join(os.homedir(), ".aegis", "config.yaml");
        results.push(fs.existsSync(configPath) ? "✓ Config exists" : "✗ No config — run: npx tsx src/cli.ts onboard");

        // Check Ollama
        try {
          await fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(3000) });
          results.push("✓ Ollama running");
        } catch {
          results.push("✗ Ollama not reachable on localhost:11434");
        }

        // Check custom skills
        const skillsDir = path.join(os.homedir(), ".aegis", "skills");
        if (fs.existsSync(skillsDir)) {
          const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith("."));
          let broken = 0;
          for (const dir of dirs) {
            const idx = path.join(skillsDir, dir.name, "index.js");
            if (!fs.existsSync(idx)) { broken++; continue; }
            const code = fs.readFileSync(idx, "utf-8");
            if (code.includes("module.exports") || !code.includes("export default")) broken++;
          }
          results.push(`${broken === 0 ? "✓" : "✗"} Custom skills: ${dirs.length} total, ${broken} broken`);
          if (broken > 0) results.push("  Run: heal_skills to fix");
        }

        // Check disk space
        try {
          const { stdout } = await execAsync("df -h / | tail -1 | awk '{print $5}'");
          const pct = parseInt(stdout);
          results.push(pct > 90 ? `✗ Disk: ${pct}% (dangerously full)` : `✓ Disk: ${pct}% used`);
        } catch {}

        // Check memory
        const memPct = ((os.totalmem() - os.freemem()) / os.totalmem() * 100).toFixed(0);
        results.push(parseInt(memPct) > 90 ? `✗ Memory: ${memPct}%` : `✓ Memory: ${memPct}% used`);

        return results.join("\n");
      }

      case "heal_skills": {
        const skillsDir = path.join(os.homedir(), ".aegis", "skills");
        if (!fs.existsSync(skillsDir)) return "No custom skills directory.";

        const results: string[] = [];
        const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith("."));

        for (const dir of dirs) {
          const idx = path.join(skillsDir, dir.name, "index.js");
          if (!fs.existsSync(idx)) {
            results.push(`✗ ${dir.name}: no index.js — skipping`);
            continue;
          }

          let code = fs.readFileSync(idx, "utf-8");
          const issues: string[] = [];

          if (code.includes("module.exports")) {
            code = code.replace(/module\.exports\s*=\s*/g, "export default ");
            issues.push("fixed module.exports");
          }
          if (!code.includes("export default")) {
            const match = code.match(/(?:const|let|var)\s+(\w+)\s*=\s*\{/);
            if (match) { code += `\nexport default ${match[1]};\n`; issues.push("added export default"); }
          }
          if (!code.includes("tools: [") && !code.includes("tools:[")) {
            // Quarantine — too broken to fix
            const q = path.join(skillsDir, ".quarantine");
            if (!fs.existsSync(q)) fs.mkdirSync(q, { recursive: true });
            fs.renameSync(path.join(skillsDir, dir.name), path.join(q, dir.name));
            results.push(`✗ ${dir.name}: quarantined (no tools array)`);
            continue;
          }

          if (issues.length > 0) {
            fs.writeFileSync(idx, code);
            results.push(`✓ ${dir.name}: ${issues.join(", ")}`);
          } else {
            results.push(`✓ ${dir.name}: OK`);
          }
        }

        return results.length > 0 ? results.join("\n") : "No custom skills found.";
      }

      case "heal_deps": {
        const kateDir = path.join(os.homedir(), "kate");
        try {
          const { stdout } = await execAsync("npm ls --json 2>&1", { cwd: kateDir, timeout: 30000 });
          const data = JSON.parse(stdout);
          const problems = data.problems || [];
          if (problems.length === 0) return "✓ All dependencies OK.";

          await execAsync("npm install", { cwd: kateDir, timeout: 120000 });
          return `Fixed ${problems.length} dependency issues.`;
        } catch (err: any) {
          return `Dependency check: ${err.message}`;
        }
      }

      case "heal_config": {
        const configPath = path.join(os.homedir(), ".aegis", "config.yaml");
        if (!fs.existsSync(configPath)) return "No config file. Run: npx tsx src/cli.ts onboard";

        const content = fs.readFileSync(configPath, "utf-8");
        const issues: string[] = [];

        if (!content.includes("provider:")) issues.push("Missing provider section");
        if (!content.includes("agent:")) issues.push("Missing agent section");

        return issues.length === 0
          ? "✓ Config looks valid."
          : `Config issues:\n${issues.map(i => `  ✗ ${i}`).join("\n")}`;
      }

      case "heal_history": {
        loadErrors();
        const limit = (args.limit as number) || 20;
        if (errorHistory.length === 0) return "No errors recorded.";
        return errorHistory.slice(-limit).map(e => {
          const time = new Date(e.timestamp).toLocaleString();
          const status = e.resolved ? "✓ fixed" : "✗ unresolved";
          return `[${time}] ${e.type} — ${status}\n  ${e.message.slice(0, 100)}${e.resolution ? "\n  Fix: " + e.resolution : ""}`;
        }).join("\n\n");
      }

      case "heal_clear": {
        errorHistory = [];
        saveErrors();
        return "Error history cleared.";
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export default autohealer;

