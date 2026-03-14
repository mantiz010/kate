import type { Skill, SkillContext } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const log = createLogger("marketplace");
const SKILLS_DIR = path.join(os.homedir(), ".aegis", "skills");
const REGISTRY_FILE = path.join(os.homedir(), ".aegis", "plugin-registry.json");
const run = async (cmd: string, timeout = 60000) => {
  try { return (await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 5 })).stdout.slice(0, 8000); }
  catch (err: any) { return `Error: ${err.stderr || err.message}`.slice(0, 3000); }
};

interface PluginEntry {
  name: string;
  source: string;        // URL or GitHub repo
  version: string;
  installedAt: number;
  description: string;
  tools: number;
}

let registry: PluginEntry[] = [];
function loadReg() { try { if (fs.existsSync(REGISTRY_FILE)) registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8")); } catch {} }
function saveReg() { const d = path.dirname(REGISTRY_FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2)); }

const marketplace: Skill = {
  id: "builtin.marketplace",
  name: "Plugin Marketplace",
  description: "Install, share, and manage community skills. Import from GitHub, URLs, or local files. Export your skills for others.",
  version: "1.0.0",
  tools: [
    { name: "plugin_install", description: "Install a skill from a GitHub repo or URL", parameters: [
      { name: "source", type: "string", description: "GitHub repo (user/repo) or URL to skill.js file", required: true },
      { name: "name", type: "string", description: "Local name for the skill (default: from source)", required: false },
    ]},
    { name: "plugin_install_gist", description: "Install a skill from a GitHub Gist", parameters: [
      { name: "gistId", type: "string", description: "Gist ID or URL", required: true },
      { name: "name", type: "string", description: "Local skill name", required: true },
    ]},
    { name: "plugin_list", description: "List installed plugins with source and status", parameters: [] },
    { name: "plugin_update", description: "Update an installed plugin from its source", parameters: [
      { name: "name", type: "string", description: "Plugin name to update", required: true },
    ]},
    { name: "plugin_remove", description: "Remove an installed plugin", parameters: [
      { name: "name", type: "string", description: "Plugin name", required: true },
    ]},
    { name: "plugin_export", description: "Export one of your skills as a shareable file", parameters: [
      { name: "name", type: "string", description: "Skill name to export", required: true },
      { name: "output", type: "string", description: "Output path (default: ~/)", required: false },
    ]},
    { name: "plugin_search", description: "Search GitHub for Kate-compatible skills", parameters: [
      { name: "query", type: "string", description: "Search query", required: true },
    ]},
    { name: "plugin_validate", description: "Validate a skill file before installing", parameters: [
      { name: "path", type: "string", description: "Path to skill JS file", required: true },
    ]},
  ],

  async onLoad() { loadReg(); },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
    loadReg();

    switch (toolName) {
      case "plugin_install": {
        const source = args.source as string;
        let name = (args.name as string) || source.split("/").pop()?.replace(".js", "").replace(".git", "") || "plugin";
        name = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const skillDir = path.join(SKILLS_DIR, name);

        if (fs.existsSync(skillDir)) return `Skill "${name}" already exists. Remove it first or use a different name.`;

        fs.mkdirSync(skillDir, { recursive: true });

        // GitHub repo
        if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(source)) {
          const result = await run(`git clone --depth 1 https://github.com/${source}.git "${skillDir}" 2>&1`);
          if (!fs.existsSync(path.join(skillDir, "index.js"))) {
            // Check if there's a src directory or different structure
            const jsFiles = await run(`find "${skillDir}" -name "index.js" -o -name "skill.js" | head -1`);
            if (jsFiles.trim()) {
              await run(`cp "${jsFiles.trim()}" "${skillDir}/index.js"`);
            } else {
              fs.rmSync(skillDir, { recursive: true, force: true });
              return `No index.js found in repo ${source}. Expected a skill file at root.`;
            }
          }
        }
        // Direct URL
        else if (source.startsWith("http")) {
          const result = await run(`curl -s -o "${path.join(skillDir, "index.js")}" "${source}" 2>&1`);
        }
        // Local file
        else if (fs.existsSync(source)) {
          fs.copyFileSync(source, path.join(skillDir, "index.js"));
        }
        else {
          fs.rmSync(skillDir, { recursive: true, force: true });
          return `Invalid source: ${source}. Use GitHub repo (user/repo), URL, or local path.`;
        }

        // Validate
        const idx = path.join(skillDir, "index.js");
        if (!fs.existsSync(idx)) {
          fs.rmSync(skillDir, { recursive: true, force: true });
          return "Installation failed — no index.js created.";
        }

        const code = fs.readFileSync(idx, "utf-8");
        if (!code.includes("export default")) {
          // Try to fix
          if (code.includes("module.exports")) {
            const fixed = code.replace(/module\.exports\s*=\s*/g, "export default ");
            fs.writeFileSync(idx, fixed);
          } else {
            fs.rmSync(skillDir, { recursive: true, force: true });
            return "Invalid skill: no 'export default' found.";
          }
        }

        // Count tools
        const toolCount = (code.match(/"name":\s*"/g) || []).length;

        // Register
        registry.push({ name, source, version: "1.0.0", installedAt: Date.now(), description: "", tools: toolCount });
        saveReg();

        return `✓ Plugin installed: ${name}\n  Source: ${source}\n  Tools: ~${toolCount}\n  Location: ${skillDir}\n  Restart to load.`;
      }

      case "plugin_install_gist": {
        let gistId = args.gistId as string;
        if (gistId.includes("gist.github.com")) gistId = gistId.split("/").pop() || gistId;
        const name = (args.name as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const skillDir = path.join(SKILLS_DIR, name);
        fs.mkdirSync(skillDir, { recursive: true });

        try {
          const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers: { "User-Agent": "Kate" } });
          const data = await res.json() as any;
          const files = data.files;
          const jsFile = Object.keys(files).find(f => f.endsWith(".js")) || Object.keys(files)[0];
          if (!jsFile) { fs.rmSync(skillDir, { recursive: true }); return "No JS file found in gist."; }

          fs.writeFileSync(path.join(skillDir, "index.js"), files[jsFile].content);
          registry.push({ name, source: `gist:${gistId}`, version: "1.0.0", installedAt: Date.now(), description: data.description || "", tools: 0 });
          saveReg();
          return `✓ Installed from gist: ${name}\n  Gist: ${gistId}\n  Restart to load.`;
        } catch (err: any) {
          fs.rmSync(skillDir, { recursive: true, force: true });
          return `Failed: ${err.message}`;
        }
      }

      case "plugin_list": {
        if (registry.length === 0) return "No plugins installed. Use plugin_install to add one.";
        return registry.map(p => {
          const time = new Date(p.installedAt).toLocaleDateString();
          return `  • ${p.name} (${p.version})\n    Source: ${p.source}\n    Installed: ${time} | Tools: ${p.tools}`;
        }).join("\n\n");
      }

      case "plugin_update": {
        const name = args.name as string;
        const entry = registry.find(p => p.name === name);
        if (!entry) return `Plugin not found: ${name}`;
        const skillDir = path.join(SKILLS_DIR, name);
        // Remove and reinstall
        fs.rmSync(skillDir, { recursive: true, force: true });
        registry = registry.filter(p => p.name !== name);
        saveReg();
        // Re-run install
        return await this.execute("plugin_install", { source: entry.source, name }, ctx);
      }

      case "plugin_remove": {
        const name = args.name as string;
        const skillDir = path.join(SKILLS_DIR, name);
        if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
        registry = registry.filter(p => p.name !== name);
        saveReg();
        return `Removed: ${name}`;
      }

      case "plugin_export": {
        const name = (args.name as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const skillDir = path.join(SKILLS_DIR, name);
        const idx = path.join(skillDir, "index.js");
        if (!fs.existsSync(idx)) return `Skill not found: ${name}`;

        const output = ((args.output as string) || os.homedir()).replace("~", os.homedir());
        const outFile = path.join(output, `kate-skill-${name}.js`);
        fs.copyFileSync(idx, outFile);
        return `Exported: ${outFile}\nShare this file or upload to a gist.`;
      }

      case "plugin_search": {
        const query = args.query as string;
        try {
          const res = await fetch(`https://api.github.com/search/repositories?q=kate+skill+${encodeURIComponent(query)}&sort=stars&per_page=10`, {
            headers: { "User-Agent": "Kate" },
          });
          const data = await res.json() as any;
          if (!data.items?.length) return "No Kate skills found. Try a different query.";
          return data.items.map((r: any) =>
            `  ⭐ ${r.stargazers_count} ${r.full_name}\n    ${r.description || "—"}\n    Install: plugin_install source="${r.full_name}"`
          ).join("\n\n");
        } catch (err: any) {
          return `Search failed: ${err.message}`;
        }
      }

      case "plugin_validate": {
        const p = (args.path as string).replace("~", os.homedir());
        if (!fs.existsSync(p)) return `File not found: ${p}`;
        const code = fs.readFileSync(p, "utf-8");
        const issues: string[] = [];
        const good: string[] = [];

        if (!code.includes("export default")) issues.push("Missing 'export default'");
        else good.push("Has export default");
        if (!code.includes("tools:") && !code.includes("tools :")) issues.push("Missing 'tools' property");
        else good.push("Has tools");
        if (!code.includes("execute")) issues.push("Missing 'execute' function");
        else good.push("Has execute function");
        if (code.includes("module.exports")) issues.push("Uses module.exports (should be export default)");
        if (code.includes("require(")) issues.push("Uses require() — may need createRequire wrapper");

        return [
          `Validation: ${path.basename(p)}`,
          issues.length === 0 ? "  ✓ Valid — ready to install" : `  ✗ ${issues.length} issue(s):`,
          ...issues.map(i => `    ✗ ${i}`),
          ...good.map(g => `    ✓ ${g}`),
        ].join("\n");
      }

      default: return `Unknown: ${toolName}`;
    }
  },
};
export default marketplace;

