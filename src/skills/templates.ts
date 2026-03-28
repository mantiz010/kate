import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEMPLATE_DIR = path.join(os.homedir(), ".kate", "templates");

interface TemplateMeta {
  name: string;
  description: string;
  board: string;
  tags: string[];
  files: string[];
  created: string;
  compile_success: boolean;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadMeta(p: string): TemplateMeta | null {
  try { return JSON.parse(fs.readFileSync(path.join(p, "meta.json"), "utf-8")); }
  catch { return null; }
}

function scoreMatch(meta: TemplateMeta, query: string): number {
  const words = query.toLowerCase().split(/\s+/);
  let score = 0;
  for (const word of words) {
    if (meta.name.toLowerCase().includes(word)) score += 3;
    if (meta.description.toLowerCase().includes(word)) score += 2;
    if (meta.tags.some(t => t.toLowerCase().includes(word))) score += 2;
    if (meta.board.toLowerCase().includes(word)) score += 1;
  }
  return score;
}

const templateSkill: Skill = {
  id: "templates",
  version: "1.0.0",
  name: "templates",
  description: "Save and load working ESP32/Arduino code templates so Kate reuses proven code instead of starting from scratch",
  tools: [
    { name: "template_save", description: "Save a working ESP32/Arduino project as a reusable template. Call this after a successful compile.", parameters: [
      { name: "name", type: "string", description: "Short unique name e.g. 'zigbee-16ch-relay'", required: true },
      { name: "description", type: "string", description: "What it does, what hardware, what protocol", required: true },
      { name: "source_dir", type: "string", description: "Full path to the Arduino project directory", required: true },
      { name: "board", type: "string", description: "Board used to compile e.g. 'esp32c6-zigbee'", required: true },
      { name: "tags", type: "string", description: "Comma-separated tags e.g. 'zigbee,relay,esp32c6'", required: true },
    ]},
    { name: "template_list", description: "List all saved ESP32/Arduino templates. Optionally filter by tag.", parameters: [
      { name: "tag", type: "string", description: "Optional tag to filter by e.g. 'zigbee'", required: false },
    ]},
    { name: "template_load", description: "Load a template by name. Returns full source code as a starting point.", parameters: [
      { name: "name", type: "string", description: "Template name to load", required: true },
    ]},
    { name: "template_search", description: "Search for the best matching template. ALWAYS call this before writing new ESP32/Arduino code.", parameters: [
      { name: "query", type: "string", description: "Describe what you want to build e.g. 'Zigbee relay ESP32-C6'", required: true },
      { name: "top_n", type: "number", description: "How many results to return (default 3)", required: false },
    ]},
    { name: "template_delete", description: "Delete a saved template by name.", parameters: [
      { name: "name", type: "string", description: "Template name to delete", required: true },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {

      case "template_save": {
        const { name, description, source_dir, board } = args as any;
        const tags = (args.tags as string).split(",").map((t: string) => t.trim());
        ensureDir(TEMPLATE_DIR);
        const srcDir = (source_dir as string).replace("~", os.homedir());
        if (!fs.existsSync(srcDir)) return JSON.stringify({ error: `Source directory not found: ${srcDir}` });
        const destDir = path.join(TEMPLATE_DIR, name as string);
        ensureDir(destDir);
        const extensions = [".ino", ".cpp", ".c", ".h", ".json", ".yaml", ".yml", ".txt"];
        const files = fs.readdirSync(srcDir).filter(f => extensions.some(ext => f.endsWith(ext)));
        if (files.length === 0) return JSON.stringify({ error: `No code files found in ${srcDir}` });
        for (const file of files) fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        const meta: TemplateMeta = { name: name as string, description: description as string, board: board as string, tags, files, created: new Date().toISOString().split("T")[0], compile_success: true };
        fs.writeFileSync(path.join(destDir, "meta.json"), JSON.stringify(meta, null, 2));
        return JSON.stringify({ success: true, message: `Template '${name}' saved with ${files.length} files`, files });
      }

      case "template_list": {
        ensureDir(TEMPLATE_DIR);
        const dirs = fs.readdirSync(TEMPLATE_DIR).filter(d => fs.statSync(path.join(TEMPLATE_DIR, d)).isDirectory());
        const templates = dirs.map(d => loadMeta(path.join(TEMPLATE_DIR, d))).filter((m): m is TemplateMeta => m !== null);
        const tag = args.tag as string | undefined;
        const filtered = tag ? templates.filter(m => m.tags.some(t => t.includes(tag.toLowerCase()))) : templates;
        if (filtered.length === 0) return JSON.stringify({ templates: [], message: "No templates found" });
        return JSON.stringify({ templates: filtered.map(m => ({ name: m.name, description: m.description, board: m.board, tags: m.tags, created: m.created })) });
      }

      case "template_load": {
        const templatePath = path.join(TEMPLATE_DIR, args.name as string);
        if (!fs.existsSync(templatePath)) return JSON.stringify({ error: `Template '${args.name}' not found. Use template_list to see available templates.` });
        const meta = loadMeta(templatePath);
        if (!meta) return JSON.stringify({ error: `Metadata missing for '${args.name}'` });
        const sources: Record<string, string> = {};
        for (const file of meta.files) {
          try { sources[file] = fs.readFileSync(path.join(templatePath, file), "utf-8"); }
          catch { sources[file] = "[could not read]"; }
        }
        return JSON.stringify({ name: meta.name, description: meta.description, board: meta.board, tags: meta.tags, sources });
      }

      case "template_search": {
        ensureDir(TEMPLATE_DIR);
        const dirs = fs.readdirSync(TEMPLATE_DIR).filter(d => fs.statSync(path.join(TEMPLATE_DIR, d)).isDirectory());
        const templates = dirs.map(d => loadMeta(path.join(TEMPLATE_DIR, d))).filter((m): m is TemplateMeta => m !== null);
        if (templates.length === 0) return JSON.stringify({ matches: [], message: "No templates saved yet. Compile a project then use template_save." });
        const scored = templates
          .map(m => ({ meta: m, score: scoreMatch(m, args.query as string) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, (args.top_n as number) || 3);
        if (scored.length === 0) return JSON.stringify({ matches: [], message: "No matching templates found. Write from scratch." });
        return JSON.stringify({
          matches: scored.map(x => ({ name: x.meta.name, description: x.meta.description, board: x.meta.board, tags: x.meta.tags, score: x.score })),
          suggestion: `Best match: '${scored[0].meta.name}' — use template_load to retrieve it`
        });
      }

      case "template_delete": {
        const templatePath = path.join(TEMPLATE_DIR, args.name as string);
        if (!fs.existsSync(templatePath)) return JSON.stringify({ error: `Template '${args.name}' not found` });
        fs.rmSync(templatePath, { recursive: true });
        return JSON.stringify({ success: true, message: `Template '${args.name}' deleted` });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  }
};

export default templateSkill;
