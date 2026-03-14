import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const run = async (cmd: string, timeout = 120000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 10 });
    return (stdout || stderr || "(no output)").slice(0, 15000);
  } catch (err: any) { return `Error: ${err.stderr || err.stdout || err.message}`.slice(0, 5000); }
};

const PROJECTS_DIR = path.join(os.homedir(), "projects");

const installer: Skill = {
  id: "builtin.installer",
  name: "Project Installer",
  description: "Clone repos from GitHub, auto-detect project type, install dependencies, read READMEs, and integrate. Checks the user's own repos first.",
  version: "1.0.0",
  tools: [
    { name: "install_from_github", description: "Clone a GitHub repo, auto-detect type, install deps, and report structure. Uses owner/repo format or full URL.", parameters: [
      { name: "repo", type: "string", description: "GitHub repo: owner/repo or full URL", required: true },
      { name: "dest", type: "string", description: "Destination (default: ~/projects/reponame)", required: false },
      { name: "branch", type: "string", description: "Branch (default: main)", required: false },
    ]},
    { name: "install_find_user_repo", description: "Search a user's own GitHub repos by name. ALWAYS try this first when user mentions a project name.", parameters: [
      { name: "username", type: "string", description: "GitHub username to search", required: true },
      { name: "query", type: "string", description: "Repo name or keyword to find", required: true },
    ]},
    { name: "install_analyze", description: "Analyze a cloned project — detect type, read README, list files, find config", parameters: [
      { name: "path", type: "string", description: "Project directory path", required: true },
    ]},
    { name: "install_deps", description: "Auto-install dependencies for a project (npm, pip, go, cargo, etc.)", parameters: [
      { name: "path", type: "string", description: "Project directory", required: true },
    ]},
    { name: "install_list_projects", description: "List cloned/installed projects", parameters: [] },
    { name: "install_run", description: "Detect and run a project's start command", parameters: [
      { name: "path", type: "string", description: "Project directory", required: true },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

    switch (toolName) {
      case "install_from_github": {
        let repo = args.repo as string;
        
        // Normalize URL to owner/repo
        if (repo.startsWith("http")) {
          const m = repo.match(/github\.com\/([^\/]+\/[^\/]+)/);
          if (m) repo = m[1].replace(/\.git$/, "");
        }

        const repoName = repo.split("/").pop() || "project";
        const dest = ((args.dest as string) || path.join(PROJECTS_DIR, repoName)).replace("~", os.homedir());
        const branch = args.branch ? `--branch ${args.branch}` : "";

        ctx.log.info(`Cloning: ${repo} → ${dest}`);
        
        // Clone
        if (fs.existsSync(dest)) {
          const pullResult = await run(`cd "${dest}" && git pull 2>&1`);
          ctx.log.info(`Pulled existing: ${pullResult.slice(0, 100)}`);
        } else {
          const cloneResult = await run(`git clone --depth 1 ${branch} "https://github.com/${repo}.git" "${dest}" 2>&1`);
          if (cloneResult.includes("Error") && cloneResult.includes("not found")) {
            return `Repository not found: ${repo}\nCheck the URL or make sure it's public.`;
          }
        }

        if (!fs.existsSync(dest)) return `Clone failed for ${repo}`;

        // Analyze project
        const analysis = await analyzeProject(dest);

        // Auto-install deps
        if (analysis.type !== "unknown") {
          ctx.log.info(`Installing deps for ${analysis.type} project...`);
          await installDeps(dest, analysis.type);
        }

        // Read README
        let readme = "";
        for (const f of ["README.md", "readme.md", "README.rst", "README"]) {
          const rp = path.join(dest, f);
          if (fs.existsSync(rp)) {
            readme = fs.readFileSync(rp, "utf-8").slice(0, 3000);
            break;
          }
        }

        return [
          `✓ Cloned: ${repo}`,
          `  Location: ${dest}`,
          `  Type: ${analysis.type}`,
          `  Files: ${analysis.fileCount}`,
          `  Languages: ${analysis.languages.join(", ")}`,
          analysis.entryPoint ? `  Entry: ${analysis.entryPoint}` : "",
          analysis.hasDeps ? `  Dependencies: installed` : "",
          "",
          readme ? `README (preview):\n${readme.slice(0, 1500)}` : "(no README)",
        ].filter(Boolean).join("\n");
      }

      case "install_find_user_repo": {
        const username = args.username as string;
        const query = (args.query as string).toLowerCase();

        try {
          const res = await fetch(`https://api.github.com/users/${username}/repos?per_page=100&sort=updated`, {
            headers: { "User-Agent": "Kate/1.0" },
            signal: AbortSignal.timeout(10000),
          });
          const repos = await res.json() as any[];

          if (!Array.isArray(repos)) return `Could not fetch repos for ${username}`;

          // Search by name, description, topics
          const matches = repos.filter((r: any) => {
            const name = (r.name || "").toLowerCase();
            const desc = (r.description || "").toLowerCase();
            const topics = (r.topics || []).join(" ").toLowerCase();
            return name.includes(query) || desc.includes(query) || topics.includes(query) 
              || query.includes(name) || name.replace(/-/g, "").includes(query.replace(/-/g, ""));
          });

          if (matches.length === 0) {
            // Show all repos as fallback
            return `No repos matching "${query}" for ${username}.\n\nAll repos:\n${repos.slice(0, 20).map((r: any) =>
              `  • ${r.name} — ${r.description || "(no desc)"} [${r.language || "?"}]`
            ).join("\n")}`;
          }

          return matches.map((r: any) =>
            `✓ ${r.full_name}\n  ${r.description || "(no description)"}\n  Language: ${r.language || "?"} | Stars: ${r.stargazers_count} | Updated: ${r.updated_at?.slice(0, 10)}\n  Clone: install_from_github repo="${r.full_name}"`
          ).join("\n\n");
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      }

      case "install_analyze": {
        const p = (args.path as string).replace("~", os.homedir());
        if (!fs.existsSync(p)) return `Not found: ${p}`;
        const analysis = await analyzeProject(p);
        return [
          `Project: ${path.basename(p)}`,
          `  Type: ${analysis.type}`,
          `  Languages: ${analysis.languages.join(", ")}`,
          `  Files: ${analysis.fileCount}`,
          analysis.entryPoint ? `  Entry: ${analysis.entryPoint}` : "",
          `  Has deps: ${analysis.hasDeps}`,
          "",
          `  Structure:`,
          analysis.structure,
        ].filter(Boolean).join("\n");
      }

      case "install_deps": {
        const p = (args.path as string).replace("~", os.homedir());
        const analysis = await analyzeProject(p);
        const result = await installDeps(p, analysis.type);
        return result;
      }

      case "install_list_projects": {
        if (!fs.existsSync(PROJECTS_DIR)) return "No projects yet.";
        const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        if (dirs.length === 0) return "No projects yet.";
        const results: string[] = [];
        for (const d of dirs) {
          const full = path.join(PROJECTS_DIR, d.name);
          const a = await analyzeProject(full);
          results.push(`  ${d.name} — ${a.type} (${a.languages.join(", ")})`);
        }
        return `Projects in ${PROJECTS_DIR}:\n${results.join("\n")}`;
      }

      case "install_run": {
        const p = (args.path as string).replace("~", os.homedir());
        const analysis = await analyzeProject(p);
        let cmd: string;
        switch (analysis.type) {
          case "node": cmd = `cd "${p}" && npm start`; break;
          case "python": cmd = `cd "${p}" && python3 ${analysis.entryPoint || "main.py"}`; break;
          case "go": cmd = `cd "${p}" && go run .`; break;
          case "rust": cmd = `cd "${p}" && cargo run`; break;
          case "arduino": cmd = `cd "${p}" && arduino-cli compile .`; break;
          default: return `Can't auto-run ${analysis.type} project. Run manually.`;
        }
        return run(cmd, 30000);
      }

      default: return `Unknown: ${toolName}`;
    }
  },
};

interface ProjectAnalysis {
  type: string;
  languages: string[];
  fileCount: number;
  entryPoint: string;
  hasDeps: boolean;
  structure: string;
}

async function analyzeProject(dir: string): Promise<ProjectAnalysis> {
  const files = fs.readdirSync(dir).filter(f => !f.startsWith(".") && f !== "node_modules");
  const langs: Set<string> = new Set();
  let type = "unknown";
  let entry = "";
  let hasDeps = false;

  if (files.includes("package.json")) { type = "node"; hasDeps = files.includes("node_modules"); }
  else if (files.includes("requirements.txt") || files.includes("setup.py") || files.includes("pyproject.toml")) { type = "python"; }
  else if (files.includes("go.mod")) { type = "go"; }
  else if (files.includes("Cargo.toml")) { type = "rust"; }
  else if (files.includes("platformio.ini") || files.some(f => f.endsWith(".ino"))) { type = "arduino"; }
  else if (files.includes("manifest.json") && files.includes("__init__.py")) { type = "ha-integration"; }

  // Detect entry point
  for (const f of ["index.js", "index.ts", "main.py", "app.py", "__init__.py", "main.go", "main.rs"]) {
    if (files.includes(f)) { entry = f; break; }
  }

  // Detect languages
  const extMap: Record<string, string> = { ".py": "Python", ".js": "JavaScript", ".ts": "TypeScript", ".go": "Go", ".rs": "Rust", ".cpp": "C++", ".c": "C", ".h": "C/C++", ".ino": "Arduino", ".html": "HTML", ".css": "CSS", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML" };
  for (const f of files) {
    const ext = path.extname(f);
    if (extMap[ext]) langs.add(extMap[ext]);
  }

  // Count files recursively (rough)
  let fileCount = 0;
  try {
    const { stdout } = await execAsync(`find "${dir}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | wc -l`, { timeout: 5000 });
    fileCount = parseInt(stdout.trim()) || files.length;
  } catch { fileCount = files.length; }

  // Structure
  const structure = files.slice(0, 20).map(f => {
    const stat = fs.statSync(path.join(dir, f));
    return `    ${stat.isDirectory() ? "📁" : "📄"} ${f}`;
  }).join("\n");

  return { type, languages: [...langs], fileCount, entryPoint: entry, hasDeps, structure };
}

async function installDeps(dir: string, type: string): Promise<string> {
  switch (type) {
    case "node": return run(`cd "${dir}" && npm install 2>&1`, 120000);
    case "python": {
      if (fs.existsSync(path.join(dir, "requirements.txt"))) {
        return run(`cd "${dir}" && pip install -r requirements.txt --break-system-packages 2>&1`, 120000);
      }
      return "No requirements.txt found";
    }
    case "go": return run(`cd "${dir}" && go mod download 2>&1`);
    case "rust": return run(`cd "${dir}" && cargo fetch 2>&1`);
    default: return "No auto-install for this project type";
  }
}

export default installer;

