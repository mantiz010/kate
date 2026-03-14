import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execAsync = promisify(exec);
const run = async (cmd: string, cwd?: string, timeout = 60000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, timeout, maxBuffer: 1024 * 1024 * 10 });
    return (stdout || stderr || "(no output)").slice(0, 15000);
  } catch (err: any) {
    return `${err.stdout || ""}${err.stderr || err.message}`.slice(0, 10000);
  }
};

const codeAnalysis: Skill = {
  id: "builtin.codeanalysis",
  name: "Code Analysis",
  description: "Lint, security scan, dependency audit, code complexity, and quality checks for JS/TS/Python projects",
  version: "1.0.0",
  tools: [
    { name: "lint", description: "Run ESLint, Pylint, or auto-detect linter for a project", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
      { name: "fix", type: "boolean", description: "Auto-fix issues", required: false },
    ]},
    { name: "security_scan", description: "Scan for known security vulnerabilities in dependencies", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
    ]},
    { name: "dependency_audit", description: "Audit all dependencies for outdated, deprecated, or vulnerable packages", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
    ]},
    { name: "code_stats", description: "Count lines of code, files, languages in a project", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
    ]},
    { name: "find_todos", description: "Find all TODO, FIXME, HACK, XXX comments in codebase", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
    ]},
    { name: "find_duplicates", description: "Find duplicate or very similar code blocks", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
      { name: "ext", type: "string", description: "File extension to check (e.g. ts, py, js)", required: false },
    ]},
    { name: "check_secrets", description: "Scan for accidentally committed secrets, API keys, passwords", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
    ]},
    { name: "complexity_report", description: "Analyze code complexity — long functions, deep nesting, large files", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
    ]},
    { name: "license_check", description: "Check licenses of all dependencies for compatibility", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const cwd = args.path as string;

    switch (toolName) {
      case "lint": {
        const fix = args.fix ? "--fix" : "";
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
          if (pkg.devDependencies?.eslint || pkg.dependencies?.eslint) {
            return run(`npx eslint . ${fix} --no-error-on-unmatched-pattern 2>&1`, cwd);
          }
          return run(`npx eslint . ${fix} --no-error-on-unmatched-pattern 2>&1 || echo "ESLint not configured. Install: npm i -D eslint"`, cwd);
        }
        if (fs.existsSync(path.join(cwd, "requirements.txt")) || fs.existsSync(path.join(cwd, "setup.py"))) {
          return run(`python3 -m pylint --recursive=y ${cwd} 2>&1 || python3 -m flake8 ${cwd} 2>&1 || echo "Install: pip install pylint or flake8"`, cwd);
        }
        return "Could not detect project type. Supported: Node.js (ESLint), Python (pylint/flake8)";
      }

      case "security_scan": {
        const results: string[] = [];
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          results.push("=== npm audit ===");
          results.push(await run("npm audit --json 2>&1 | head -100", cwd));
        }
        if (fs.existsSync(path.join(cwd, "requirements.txt"))) {
          results.push("=== pip-audit ===");
          results.push(await run("pip-audit -r requirements.txt 2>&1 || echo 'Install: pip install pip-audit'", cwd));
        }
        if (results.length === 0) results.push("No package files found.");
        return results.join("\n\n");
      }

      case "dependency_audit": {
        const results: string[] = [];
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          results.push("=== Outdated packages ===");
          results.push(await run("npm outdated 2>&1 || true", cwd));
          results.push("\n=== Audit ===");
          results.push(await run("npm audit 2>&1 || true", cwd));
        }
        if (fs.existsSync(path.join(cwd, "requirements.txt"))) {
          results.push("=== Python dependencies ===");
          results.push(await run("pip list --outdated 2>&1 || true", cwd));
        }
        return results.join("\n") || "No dependency files found.";
      }

      case "code_stats": {
        const stats = await run(`find ${cwd} -type f \\( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.c' -o -name '*.cpp' -o -name '*.h' -o -name '*.java' -o -name '*.html' -o -name '*.css' \\) -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -500`);
        const files = stats.trim().split("\n").filter(Boolean);

        const byExt: Record<string, { files: number; lines: number }> = {};
        let totalLines = 0;

        for (const file of files.slice(0, 200)) {
          const ext = path.extname(file) || "other";
          if (!byExt[ext]) byExt[ext] = { files: 0, lines: 0 };
          byExt[ext].files++;
          try {
            const content = fs.readFileSync(file, "utf-8");
            const lines = content.split("\n").length;
            byExt[ext].lines += lines;
            totalLines += lines;
          } catch {}
        }

        const sorted = Object.entries(byExt).sort((a, b) => b[1].lines - a[1].lines);
        return [
          `Code Statistics for: ${cwd}`,
          `Total files: ${files.length}`,
          `Total lines: ${totalLines.toLocaleString()}`,
          "",
          "By language:",
          ...sorted.map(([ext, s]) => `  ${ext.padEnd(8)} ${s.files} files, ${s.lines.toLocaleString()} lines`),
        ].join("\n");
      }

      case "find_todos": {
        return run(`grep -rn --include='*.ts' --include='*.js' --include='*.py' --include='*.go' --include='*.rs' --include='*.c' --include='*.cpp' -E '(TODO|FIXME|HACK|XXX|BUG|WARN):?' ${cwd} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null | head -50`, cwd);
      }

      case "find_duplicates": {
        const ext = (args.ext as string) || "ts";
        return run(`find ${cwd} -name '*.${ext}' -not -path '*/node_modules/*' -not -path '*/.git/*' -exec md5sum {} \\; 2>/dev/null | sort | uniq -D -w 32 | head -30`, cwd);
      }

      case "check_secrets": {
        const patterns = [
          "(?i)(api[_-]?key|apikey)\\s*[:=]\\s*['\"][^'\"]{8,}",
          "(?i)(secret|password|passwd|token)\\s*[:=]\\s*['\"][^'\"]{8,}",
          "(?i)(aws|gcp|azure)[_-]?(access|secret|key)",
          "sk-[a-zA-Z0-9]{20,}",
          "ghp_[a-zA-Z0-9]{36}",
          "AKIA[A-Z0-9]{16}",
        ];
        const results: string[] = [];
        for (const pattern of patterns) {
          const found = await run(`grep -rn --include='*.ts' --include='*.js' --include='*.py' --include='*.env' --include='*.json' --include='*.yaml' --include='*.yml' -E '${pattern}' ${cwd} --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -10`);
          if (found && !found.includes("(no output)")) results.push(found);
        }
        return results.length > 0
          ? "⚠ Potential secrets found:\n" + results.join("\n")
          : "✓ No obvious secrets detected.";
      }

      case "complexity_report": {
        const bigFiles = await run(`find ${cwd} -type f \\( -name '*.ts' -o -name '*.js' -o -name '*.py' \\) -not -path '*/node_modules/*' -not -path '*/.git/*' -exec wc -l {} \\; 2>/dev/null | sort -rn | head -15`);
        const deepNesting = await run(`grep -rn --include='*.ts' --include='*.js' --include='*.py' -P '^\\s{32,}\\S' ${cwd} --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -10`);
        const longFunctions = await run(`grep -rn --include='*.ts' --include='*.js' -E '(function |=> \\{|async )' ${cwd} --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | wc -l`);

        return [
          "Complexity Report",
          "═════════════════",
          "",
          "Largest files:",
          bigFiles,
          "",
          "Deep nesting (8+ levels):",
          deepNesting || "  None found",
          "",
          `Total functions/methods: ~${longFunctions.trim()}`,
        ].join("\n");
      }

      case "license_check": {
        if (fs.existsSync(path.join(cwd, "package.json"))) {
          return run("npx license-checker --summary 2>&1 || echo 'Install: npm i -g license-checker'", cwd);
        }
        return "Only Node.js projects supported for license checking currently.";
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export default codeAnalysis;

