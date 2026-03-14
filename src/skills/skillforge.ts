import type { Skill, SkillContext } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const log = createLogger("skillforge");
const SKILLS_DIR = path.join(os.homedir(), ".aegis", "skills");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── BULLETPROOF tools parser ───────────────────────────────────
// Handles every kind of garbage the LLM throws at us:
// - Valid JSON array ✓
// - Single object instead of array ✓  
// - String description instead of JSON ✓
// - Broken JSON ✓
// - Empty/null ✓
// - Nested weirdness ✓
// - Tools with missing fields ✓

interface ParsedTool {
  name: string;
  description: string;
  params: Array<{ name: string; type: string; description: string; required: boolean }>;
}

function parseToolsInput(raw: unknown, skillName: string): { tools: ParsedTool[]; warnings: string[] } {
  const warnings: string[] = [];
  const safeName = skillName.toLowerCase().replace(/[^a-z0-9]/g, "_");
  let tools: ParsedTool[] = [];

  // Handle null/undefined/empty
  if (!raw || raw === "[]" || raw === "{}" || raw === "null" || raw === "undefined") {
    warnings.push("Empty tools — created default tool");
    return {
      tools: [{ name: `${safeName}_run`, description: `Execute ${skillName} action`, params: [{ name: "input", type: "string", description: "Input for this tool", required: false }] }],
      warnings,
    };
  }

  const rawStr = String(raw).trim();

  // Try parsing as JSON
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawStr);
  } catch {
    // Try fixing common JSON issues
    try {
      // Remove trailing commas
      const fixed = rawStr.replace(/,\s*([}\]])/g, "$1");
      parsed = JSON.parse(fixed);
    } catch {
      // Try wrapping in array
      try {
        parsed = JSON.parse(`[${rawStr}]`);
      } catch {
        // Give up on JSON — treat as description text
        warnings.push("Could not parse tools JSON — created tool from description");
        return {
          tools: [{ name: `${safeName}_run`, description: rawStr.slice(0, 200), params: [{ name: "input", type: "string", description: "Input", required: false }] }],
          warnings,
        };
      }
    }
  }

  // Normalize parsed to array
  if (Array.isArray(parsed)) {
    // Good — it's an array
  } else if (parsed && typeof parsed === "object") {
    // Single tool object
    parsed = [parsed];
    warnings.push("Single tool object wrapped in array");
  } else {
    // Primitive — make default
    warnings.push("Unexpected type — created default tool");
    return {
      tools: [{ name: `${safeName}_run`, description: String(parsed).slice(0, 200), params: [] }],
      warnings,
    };
  }

  // Filter out non-objects
  parsed = parsed.filter((t: any) => t && typeof t === "object");

  if (parsed.length === 0) {
    warnings.push("No valid tool objects found — created default");
    return {
      tools: [{ name: `${safeName}_run`, description: `Default ${skillName} tool`, params: [] }],
      warnings,
    };
  }

  // Sanitize each tool
  for (let i = 0; i < parsed.length; i++) {
    const t = parsed[i];

    // Extract name — try many field names
    let name = t.name || t.tool_name || t.toolName || t.function || t.fn || `${safeName}_tool_${i + 1}`;
    name = String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 50);
    if (!name || name === "undefined" || name === "null") name = `${safeName}_tool_${i + 1}`;

    // Extract description
    let desc = t.description || t.desc || t.summary || t.help || `Tool ${i + 1} for ${skillName}`;
    desc = String(desc).replace(/"/g, "'").slice(0, 300);

    // Extract params — handle every format
    let params: Array<{ name: string; type: string; description: string; required: boolean }> = [];

    const rawParams = t.params || t.parameters || t.args || t.arguments || t.inputs || t.input_schema;

    if (Array.isArray(rawParams)) {
      params = rawParams.map((p: any, j: number) => {
        if (!p || typeof p !== "object") {
          return { name: `arg${j}`, type: "string", description: "", required: false };
        }
        return {
          name: String(p.name || p.param || p.arg || `arg${j}`).replace(/[^a-zA-Z0-9_]/g, "_"),
          type: ["string", "number", "boolean", "object", "array"].includes(p.type) ? p.type : "string",
          description: String(p.description || p.desc || "").replace(/"/g, "'").slice(0, 200),
          required: !!p.required,
        };
      });
    } else if (rawParams && typeof rawParams === "object") {
      // Object format: { paramName: { type, description } }
      params = Object.entries(rawParams).map(([key, val]: [string, any]) => ({
        name: key.replace(/[^a-zA-Z0-9_]/g, "_"),
        type: (val && val.type) || "string",
        description: String((val && val.description) || "").replace(/"/g, "'"),
        required: !!(val && val.required),
      }));
      warnings.push(`Converted object params to array for tool "${name}"`);
    }

    tools.push({ name, description: desc, params });
  }

  // Deduplicate names
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      tool.name = `${tool.name}_${seen.size}`;
      warnings.push(`Renamed duplicate tool: ${tool.name}`);
    }
    seen.add(tool.name);
  }

  return { tools, warnings };
}

// ── Generate clean skill code ──────────────────────────────────

function generateSkillCode(id: string, name: string, description: string, tools: ParsedTool[]): string {
  const toolDefs = tools.map(t => `    {
      name: "${t.name}",
      description: "${t.description}",
      parameters: [
${t.params.map(p => `        { name: "${p.name}", type: "${p.type}", description: "${p.description}", required: ${p.required} },`).join("\n")}
      ],
    }`).join(",\n");

  const cases = tools.map(t => {
    return `      case "${t.name}": {
        return "Executed ${t.name} with: " + JSON.stringify(args);
      }`;
  }).join("\n\n");

  return `// Kate Skill: ${name}
// Generated: ${new Date().toISOString()}

const skill = {
  id: "${id}",
  name: "${name}",
  description: "${description.replace(/"/g, "'")}",
  version: "1.0.0",
  tools: [
${toolDefs}
  ],

  async execute(toolName, args, ctx) {
    switch (toolName) {
${cases}

      default:
        return "Unknown tool: " + toolName;
    }
  },
};

export default skill;
`;
}

// ── Validator — check a skill file for problems ────────────────

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: { name?: string; tools?: number; hasExport?: boolean };
}

function validateSkillFile(filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: any = {};

  if (!fs.existsSync(filePath)) {
    return { valid: false, errors: ["File not found: " + filePath], warnings, info };
  }

  const code = fs.readFileSync(filePath, "utf-8");

  // Critical checks
  if (code.includes("module.exports")) {
    errors.push("Uses module.exports — MUST use 'export default skill' instead");
  }

  if (!code.includes("export default")) {
    errors.push("Missing 'export default' — skill won't load");
  }
  info.hasExport = code.includes("export default");

  if (!code.includes("tools:") && !code.includes("tools :")) {
    errors.push("Missing 'tools' property");
  }

  if (!code.includes("execute")) {
    errors.push("Missing 'execute' function");
  }

  // Check for tools array (not object, not missing)
  if (code.includes("tools:") && !code.includes("tools: [") && !code.includes("tools:[")) {
    const toolsMatch = code.match(/tools:\s*(\S)/);
    if (toolsMatch && toolsMatch[1] !== "[") {
      errors.push(`'tools' must be an array (found 'tools: ${toolsMatch[1]}...')`);
    }
  }

  // Extract info
  const nameMatch = code.match(/name:\s*["']([^"']+)["']/);
  if (nameMatch) info.name = nameMatch[1];

  const toolCount = (code.match(/name:\s*["'][^"']+["'],\s*\n\s*description:/g) || []).length;
  info.tools = toolCount;

  // Warnings
  if (!code.includes("id:")) warnings.push("Missing 'id' property (optional but recommended)");
  if (!code.includes("version:")) warnings.push("Missing 'version' property");
  if (code.length < 50) warnings.push("File seems too short — may be incomplete");
  if (code.length > 50000) warnings.push("File is very large — consider splitting");

  return { valid: errors.length === 0, errors, warnings, info };
}

// ── Auto-fixer — repairs common issues ─────────────────────────

function autoFixSkill(filePath: string): { fixed: boolean; changes: string[] } {
  if (!fs.existsSync(filePath)) return { fixed: false, changes: ["File not found"] };

  let code = fs.readFileSync(filePath, "utf-8");
  const changes: string[] = [];

  // Backup first
  const backupDir = path.join(path.dirname(filePath), ".backups");
  ensureDir(backupDir);
  fs.copyFileSync(filePath, path.join(backupDir, `index.${Date.now()}.js`));

  // Fix module.exports → export default
  if (code.includes("module.exports")) {
    code = code.replace(/module\.exports\s*=\s*/g, "export default ");
    changes.push("Replaced module.exports with export default");
  }

  // Fix missing export default
  if (!code.includes("export default")) {
    const objMatch = code.match(/(?:const|let|var)\s+(\w+)\s*=\s*\{/);
    if (objMatch) {
      code += `\nexport default ${objMatch[1]};\n`;
      changes.push(`Added export default ${objMatch[1]}`);
    }
  }

  // Fix CommonJS require
  if (code.includes("require(")) {
    code = `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n` + code;
    changes.push("Added createRequire for CommonJS compatibility");
  }

  if (changes.length > 0) {
    fs.writeFileSync(filePath, code);
  }

  return { fixed: changes.length > 0, changes };
}

// ── The Skill Forge skill itself ───────────────────────────────

const skillForge: Skill = {
  id: "builtin.skillforge",
  name: "Skill Forge",
  description: "Create, validate, fix, and manage custom skills. Handles ANY format of tool definitions — JSON arrays, objects, even plain text descriptions. Auto-fixes broken skills.",
  version: "3.0.0",
  tools: [
    {
      name: "skill_create",
      description: "Create a new skill. Tools param accepts JSON array, single JSON object, or plain text description. Handles bad formatting automatically.",
      parameters: [
        { name: "name", type: "string", description: "Skill name", required: true },
        { name: "description", type: "string", description: "What the skill does", required: true },
        { name: "tools", type: "string", description: "Tools definition — JSON array [{name,description,params}], or plain text. Will be auto-fixed if malformed.", required: true },
      ],
    },
    {
      name: "skill_create_with_code",
      description: "Create a skill with custom implementation code per tool",
      parameters: [
        { name: "name", type: "string", description: "Skill name", required: true },
        { name: "description", type: "string", description: "What the skill does", required: true },
        { name: "tools", type: "string", description: "JSON array of tool definitions", required: true },
        { name: "implementations", type: "string", description: "JSON object {toolName: 'js code string'}", required: true },
      ],
    },
    {
      name: "skill_validate",
      description: "Validate a custom skill file — checks for common errors, missing fields, bad exports",
      parameters: [
        { name: "name", type: "string", description: "Skill name to validate", required: true },
      ],
    },
    {
      name: "skill_fix",
      description: "Auto-fix a broken skill — repairs module.exports, missing exports, CommonJS issues",
      parameters: [
        { name: "name", type: "string", description: "Skill name to fix", required: true },
      ],
    },
    {
      name: "skill_fix_all",
      description: "Scan ALL custom skills, validate each one, auto-fix fixable issues, quarantine unfixable ones",
      parameters: [],
    },
    {
      name: "skill_read",
      description: "Read source code of a custom skill",
      parameters: [
        { name: "name", type: "string", description: "Skill name", required: true },
      ],
    },
    {
      name: "skill_edit",
      description: "Replace a tool's implementation code in a skill",
      parameters: [
        { name: "skill", type: "string", description: "Skill name", required: true },
        { name: "toolName", type: "string", description: "Tool to update", required: true },
        { name: "code", type: "string", description: "New JS code for this tool's case block", required: true },
      ],
    },
    {
      name: "skill_list_custom",
      description: "List all custom skills with validation status",
      parameters: [],
    },
    {
      name: "skill_delete",
      description: "Delete a custom skill",
      parameters: [
        { name: "name", type: "string", description: "Skill name", required: true },
        { name: "confirm", type: "boolean", description: "Must be true", required: true },
      ],
    },
    {
      name: "skill_add_tool",
      description: "Add a new tool to an existing skill",
      parameters: [
        { name: "skill", type: "string", description: "Skill name", required: true },
        { name: "toolName", type: "string", description: "New tool name", required: true },
        { name: "toolDescription", type: "string", description: "What the tool does", required: true },
        { name: "params", type: "string", description: "JSON array [{name,type,description,required}]", required: false },
        { name: "implementation", type: "string", description: "JS code for the tool", required: false },
      ],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    ensureDir(SKILLS_DIR);

    switch (toolName) {
      case "skill_create": {
        const name = args.name as string;
        const description = args.description as string;
        const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const skillDir = path.join(SKILLS_DIR, safeName);
        const skillFile = path.join(skillDir, "index.js");

        // Parse tools with bulletproof parser
        const { tools, warnings } = parseToolsInput(args.tools, name);

        ensureDir(skillDir);

        const code = generateSkillCode(`custom.${safeName}`, name, description, tools);
        fs.writeFileSync(skillFile, code, "utf-8");

        // Validate what we just wrote
        const validation = validateSkillFile(skillFile);

        // Save metadata
        fs.writeFileSync(path.join(skillDir, "meta.json"), JSON.stringify({
          name, description, tools: tools.length, createdAt: Date.now(), createdBy: ctx.userId,
        }, null, 2));

        const output = [
          `✓ Skill created: ${name}`,
          `  Location: ${skillDir}`,
          `  Tools: ${tools.map(t => t.name).join(", ")}`,
          `  Validation: ${validation.valid ? "✓ passed" : "✗ " + validation.errors.join(", ")}`,
        ];

        if (warnings.length > 0) {
          output.push(`  Warnings: ${warnings.join("; ")}`);
        }

        output.push("", "  Restart to load, or edit implementations with skill_edit.");
        return output.join("\n");
      }

      case "skill_create_with_code": {
        const name = args.name as string;
        const description = args.description as string;
        const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const skillDir = path.join(SKILLS_DIR, safeName);
        const skillFile = path.join(skillDir, "index.js");

        const { tools, warnings } = parseToolsInput(args.tools, name);

        let implementations: Record<string, string> = {};
        try {
          implementations = JSON.parse(args.implementations as string);
        } catch {
          // If implementations JSON fails, use defaults
          warnings.push("Could not parse implementations JSON — using defaults");
        }

        ensureDir(skillDir);

        // Build code with custom implementations
        const toolDefs = tools.map(t => `    {
      name: "${t.name}",
      description: "${t.description}",
      parameters: [
${t.params.map(p => `        { name: "${p.name}", type: "${p.type}", description: "${p.description}", required: ${p.required} },`).join("\n")}
      ],
    }`).join(",\n");

        const cases = tools.map(t => {
          const impl = implementations[t.name] || `return "Executed ${t.name}: " + JSON.stringify(args);`;
          return `      case "${t.name}": {\n${impl.split("\n").map((l: string) => "        " + l).join("\n")}\n      }`;
        }).join("\n\n");

        const code = `// Kate Skill: ${name}
// Generated: ${new Date().toISOString()}

const skill = {
  id: "custom.${safeName}",
  name: "${name}",
  description: "${description.replace(/"/g, "'")}",
  version: "1.0.0",
  tools: [
${toolDefs}
  ],

  async execute(toolName, args, ctx) {
    switch (toolName) {
${cases}

      default:
        return "Unknown tool: " + toolName;
    }
  },
};

export default skill;
`;

        fs.writeFileSync(skillFile, code, "utf-8");
        const validation = validateSkillFile(skillFile);

        fs.writeFileSync(path.join(skillDir, "meta.json"), JSON.stringify({
          name, description, tools: tools.length, createdAt: Date.now(), createdBy: ctx.userId,
        }, null, 2));

        return [
          `✓ Skill created: ${name} (with custom code)`,
          `  Tools: ${tools.map(t => t.name).join(", ")}`,
          `  Validation: ${validation.valid ? "✓ passed" : "✗ " + validation.errors.join(", ")}`,
          warnings.length > 0 ? `  Warnings: ${warnings.join("; ")}` : "",
        ].filter(Boolean).join("\n");
      }

      case "skill_validate": {
        const safeName = (args.name as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const skillFile = path.join(SKILLS_DIR, safeName, "index.js");
        const result = validateSkillFile(skillFile);

        const output = [`Validation: ${safeName}`];
        if (result.valid) {
          output.push("  ✓ All checks passed");
        } else {
          output.push("  Errors:");
          result.errors.forEach(e => output.push(`    ✗ ${e}`));
        }
        if (result.warnings.length > 0) {
          output.push("  Warnings:");
          result.warnings.forEach(w => output.push(`    ⚠ ${w}`));
        }
        output.push(`  Info: name=${result.info.name || "?"}, tools=~${result.info.tools || 0}, export=${result.info.hasExport}`);

        return output.join("\n");
      }

      case "skill_fix": {
        const safeName = (args.name as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const skillFile = path.join(SKILLS_DIR, safeName, "index.js");

        if (!fs.existsSync(skillFile)) return `Skill not found: ${safeName}`;

        const before = validateSkillFile(skillFile);
        const { fixed, changes } = autoFixSkill(skillFile);
        const after = validateSkillFile(skillFile);

        const output = [`Fix: ${safeName}`];
        if (changes.length > 0) {
          output.push("  Applied fixes:");
          changes.forEach(c => output.push(`    ✓ ${c}`));
        } else {
          output.push("  No auto-fixable issues found");
        }
        output.push(`  Before: ${before.valid ? "✓ valid" : `✗ ${before.errors.length} errors`}`);
        output.push(`  After:  ${after.valid ? "✓ valid" : `✗ ${after.errors.join(", ")}`}`);

        return output.join("\n");
      }

      case "skill_fix_all": {
        ensureDir(SKILLS_DIR);
        const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith("."));

        if (dirs.length === 0) return "No custom skills to check.";

        const results: string[] = [`Scanning ${dirs.length} custom skills:\n`];
        let fixed = 0, valid = 0, broken = 0, quarantined = 0;

        for (const dir of dirs) {
          const skillFile = path.join(SKILLS_DIR, dir.name, "index.js");

          if (!fs.existsSync(skillFile)) {
            // No index.js — quarantine
            const q = path.join(SKILLS_DIR, ".quarantine");
            ensureDir(q);
            try {
              fs.renameSync(path.join(SKILLS_DIR, dir.name), path.join(q, dir.name));
              results.push(`  ☠ ${dir.name} — quarantined (no index.js)`);
              quarantined++;
            } catch {
              results.push(`  ✗ ${dir.name} — no index.js, couldn't quarantine`);
              broken++;
            }
            continue;
          }

          // Validate
          const v = validateSkillFile(skillFile);
          if (v.valid) {
            results.push(`  ✓ ${dir.name} — OK`);
            valid++;
            continue;
          }

          // Try to fix
          const { changes } = autoFixSkill(skillFile);
          const after = validateSkillFile(skillFile);

          if (after.valid) {
            results.push(`  🔧 ${dir.name} — FIXED (${changes.join(", ")})`);
            fixed++;
          } else {
            // Still broken — quarantine
            const q = path.join(SKILLS_DIR, ".quarantine");
            ensureDir(q);
            try {
              fs.renameSync(path.join(SKILLS_DIR, dir.name), path.join(q, dir.name));
              results.push(`  ☠ ${dir.name} — quarantined (unfixable: ${after.errors[0]})`);
              quarantined++;
            } catch {
              results.push(`  ✗ ${dir.name} — broken: ${after.errors[0]}`);
              broken++;
            }
          }
        }

        results.push(`\nSummary: ${valid} valid, ${fixed} fixed, ${quarantined} quarantined, ${broken} broken`);
        return results.join("\n");
      }

      case "skill_read": {
        const safeName = (args.name as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const skillFile = path.join(SKILLS_DIR, safeName, "index.js");
        if (!fs.existsSync(skillFile)) return `Skill not found: ${safeName}`;
        return fs.readFileSync(skillFile, "utf-8");
      }

      case "skill_edit": {
        const safeName = (args.skill as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const tName = args.toolName as string;
        const newCode = args.code as string;
        const skillFile = path.join(SKILLS_DIR, safeName, "index.js");

        if (!fs.existsSync(skillFile)) return `Skill not found: ${safeName}`;

        let content = fs.readFileSync(skillFile, "utf-8");

        // Backup
        const backupDir = path.join(SKILLS_DIR, safeName, ".backups");
        ensureDir(backupDir);
        fs.copyFileSync(skillFile, path.join(backupDir, `index.${Date.now()}.js`));

        const caseRegex = new RegExp(`case "${tName}":\\s*\\{[\\s\\S]*?\\}`, "m");
        if (caseRegex.test(content)) {
          const newCase = `case "${tName}": {\n${newCode.split("\n").map((l: string) => "        " + l).join("\n")}\n      }`;
          content = content.replace(caseRegex, newCase);
          fs.writeFileSync(skillFile, content, "utf-8");
          const v = validateSkillFile(skillFile);
          return `Updated "${tName}" in "${safeName}". Validation: ${v.valid ? "✓" : "✗ " + v.errors.join(", ")}`;
        }
        return `Tool "${tName}" not found in "${safeName}".`;
      }

      case "skill_list_custom": {
        ensureDir(SKILLS_DIR);
        const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith("."));

        if (dirs.length === 0) return "No custom skills. Use skill_create to make one.";

        return dirs.map(d => {
          const skillFile = path.join(SKILLS_DIR, d.name, "index.js");
          if (!fs.existsSync(skillFile)) return `  ✗ ${d.name} (no index.js)`;
          const v = validateSkillFile(skillFile);
          const meta = (() => {
            try {
              const m = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, d.name, "meta.json"), "utf-8"));
              return m.description || "";
            } catch { return ""; }
          })();
          return `  ${v.valid ? "✓" : "✗"} ${d.name}${v.valid ? "" : ` (${v.errors[0]})`}${meta ? ` — ${meta.slice(0, 50)}` : ""}`;
        }).join("\n");
      }

      case "skill_delete": {
        const safeName = (args.name as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        if (!(args.confirm as boolean)) return "Set confirm=true to delete.";
        const dir = path.join(SKILLS_DIR, safeName);
        if (!fs.existsSync(dir)) return `Skill not found: ${safeName}`;
        fs.rmSync(dir, { recursive: true, force: true });
        return `Deleted: ${safeName}`;
      }

      case "skill_add_tool": {
        const safeName = (args.skill as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const tName = args.toolName as string;
        const tDesc = (args.toolDescription as string || "").replace(/"/g, "'");
        const impl = (args.implementation as string) || `return "Executed ${tName}: " + JSON.stringify(args);`;
        const skillFile = path.join(SKILLS_DIR, safeName, "index.js");

        if (!fs.existsSync(skillFile)) return `Skill not found: ${safeName}`;

        // Parse params
        const { tools: parsedParams } = parseToolsInput(
          args.params ? `[{"name":"${tName}","description":"${tDesc}","params":${args.params}}]` : `[{"name":"${tName}","description":"${tDesc}","params":[]}]`,
          safeName,
        );
        const params = parsedParams[0]?.params || [];

        let code = fs.readFileSync(skillFile, "utf-8");

        // Backup
        const backupDir = path.join(SKILLS_DIR, safeName, ".backups");
        ensureDir(backupDir);
        fs.copyFileSync(skillFile, path.join(backupDir, `index.${Date.now()}.js`));

        // Add tool definition
        const toolDef = `    {\n      name: "${tName}",\n      description: "${tDesc}",\n      parameters: [\n${params.map(p => `        { name: "${p.name}", type: "${p.type}", description: "${p.description}", required: ${p.required} },`).join("\n")}\n      ],\n    },`;

        // Insert before last ] in tools array
        code = code.replace(/(  \],\n\n\s*async execute)/, `,\n${toolDef}\n  ],\n\n  async execute`);

        // Add case before default
        const caseBlock = `      case "${tName}": {\n${impl.split("\n").map((l: string) => "        " + l).join("\n")}\n      }\n\n`;
        code = code.replace(/(      default:)/, `${caseBlock}      default:`);

        fs.writeFileSync(skillFile, code);
        const v = validateSkillFile(skillFile);
        return `Added "${tName}" to "${safeName}". Validation: ${v.valid ? "✓" : "✗ " + v.errors.join(", ")}`;
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },
};

export default skillForge;

