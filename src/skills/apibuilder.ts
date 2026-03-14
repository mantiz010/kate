import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const API_DIR = path.join(os.homedir(), ".aegis", "apis");

function ensureDir(dir: string) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function generateExpressAPI(name: string, endpoints: Array<{ method: string; path: string; description: string; response?: string }>): string {
  const routes = endpoints.map(e => {
    const handler = e.response || `{ message: "${e.description}" }`;
    return `app.${e.method.toLowerCase()}('${e.path}', (req, res) => {
  // ${e.description}
  res.json(${handler});
});`;
  }).join("\n\n");

  return `import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3300;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

${routes}

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(\`API running on http://localhost:\${PORT}\`));

export default app;
`;
}

function generatePackageJson(name: string): string {
  return JSON.stringify({
    name: name.toLowerCase().replace(/\s+/g, "-"),
    version: "1.0.0",
    type: "module",
    scripts: { start: "node index.js", dev: "node --watch index.js" },
    dependencies: { express: "^4.21.0", cors: "^2.8.5" },
  }, null, 2);
}

function generateOpenAPISpec(name: string, endpoints: Array<{ method: string; path: string; description: string }>): string {
  const paths: Record<string, any> = {};
  for (const e of endpoints) {
    if (!paths[e.path]) paths[e.path] = {};
    paths[e.path][e.method.toLowerCase()] = {
      summary: e.description,
      responses: { "200": { description: "Success" } },
    };
  }
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: name, version: "1.0.0" },
    paths,
  }, null, 2);
}

const apiBuilder: Skill = {
  id: "builtin.apibuilder",
  name: "API Builder",
  description: "Generate, scaffold, and run REST APIs from endpoint specs. Creates Express.js servers with CORS, error handling, and OpenAPI docs.",
  version: "1.0.0",
  tools: [
    { name: "api_create", description: "Create a new API project with endpoint definitions", parameters: [
      { name: "name", type: "string", description: "API project name", required: true },
      { name: "endpoints", type: "string", description: "JSON array: [{method:'GET',path:'/users',description:'List users'}]", required: true },
      { name: "port", type: "number", description: "Port number (default: 3300)", required: false },
    ]},
    { name: "api_add_endpoint", description: "Add a new endpoint to an existing API", parameters: [
      { name: "project", type: "string", description: "API project name", required: true },
      { name: "method", type: "string", description: "HTTP method: GET, POST, PUT, DELETE, PATCH", required: true },
      { name: "path", type: "string", description: "Endpoint path (e.g. /users/:id)", required: true },
      { name: "description", type: "string", description: "What the endpoint does", required: true },
      { name: "code", type: "string", description: "Handler code (JS expression for res.json())", required: false },
    ]},
    { name: "api_start", description: "Install dependencies and start an API server", parameters: [
      { name: "project", type: "string", description: "API project name", required: true },
    ]},
    { name: "api_test", description: "Test an API endpoint with curl", parameters: [
      { name: "url", type: "string", description: "Full URL to test", required: true },
      { name: "method", type: "string", description: "HTTP method (default: GET)", required: false },
      { name: "body", type: "string", description: "JSON body for POST/PUT", required: false },
    ]},
    { name: "api_list", description: "List all API projects", parameters: [] },
    { name: "api_docs", description: "Generate OpenAPI spec for a project", parameters: [
      { name: "project", type: "string", description: "API project name", required: true },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    ensureDir(API_DIR);

    switch (toolName) {
      case "api_create": {
        const name = args.name as string;
        const port = (args.port as number) || 3300;
        let endpoints: any[];
        try { endpoints = JSON.parse(args.endpoints as string); } catch (e: any) { return "Invalid endpoints JSON: " + e.message; }

        const projDir = path.join(API_DIR, name.toLowerCase().replace(/\s+/g, "-"));
        ensureDir(projDir);

        const code = generateExpressAPI(name, endpoints).replace("3300", String(port));
        fs.writeFileSync(path.join(projDir, "index.js"), code);
        fs.writeFileSync(path.join(projDir, "package.json"), generatePackageJson(name));
        fs.writeFileSync(path.join(projDir, "openapi.json"), generateOpenAPISpec(name, endpoints));

        return [
          `API created: ${name}`,
          `Location: ${projDir}`,
          `Port: ${port}`,
          `Endpoints: ${endpoints.map(e => `${e.method} ${e.path}`).join(", ")}`,
          "",
          `Start: api_start project="${name.toLowerCase().replace(/\s+/g, "-")}"`,
        ].join("\n");
      }

      case "api_add_endpoint": {
        const projDir = path.join(API_DIR, (args.project as string).toLowerCase());
        const indexPath = path.join(projDir, "index.js");
        if (!fs.existsSync(indexPath)) return `API not found: ${args.project}`;

        let code = fs.readFileSync(indexPath, "utf-8");
        const method = (args.method as string).toLowerCase();
        const ePath = args.path as string;
        const desc = args.description as string;
        const handler = (args.code as string) || `{ message: "${desc}" }`;

        const newRoute = `\napp.${method}('${ePath}', (req, res) => {\n  // ${desc}\n  res.json(${handler});\n});\n`;
        code = code.replace("// 404 handler", newRoute + "\n// 404 handler");
        fs.writeFileSync(indexPath, code);

        return `Added: ${method.toUpperCase()} ${ePath} — ${desc}`;
      }

      case "api_start": {
        const projDir = path.join(API_DIR, (args.project as string).toLowerCase());
        if (!fs.existsSync(projDir)) return `API not found: ${args.project}`;

        try {
          await execAsync("npm install", { cwd: projDir, timeout: 60000 });
          const child = execAsync("node index.js &", { cwd: projDir, timeout: 5000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 2000));
          const pkg = JSON.parse(fs.readFileSync(path.join(projDir, "package.json"), "utf-8"));
          return `API "${args.project}" starting...\nCheck: curl http://localhost:3300/health`;
        } catch (err: any) {
          return `Start failed: ${err.message}`;
        }
      }

      case "api_test": {
        const url = args.url as string;
        const method = (args.method as string) || "GET";
        const body = args.body as string;
        let cmd = `curl -s -w "\\n---\\nStatus: %{http_code}\\nTime: %{time_total}s" -X ${method}`;
        if (body) cmd += ` -H "Content-Type: application/json" -d '${body}'`;
        cmd += ` "${url}"`;
        try {
          const { stdout } = await execAsync(cmd, { timeout: 15000 });
          return stdout;
        } catch (err: any) {
          return `Test failed: ${err.message}`;
        }
      }

      case "api_list": {
        if (!fs.existsSync(API_DIR)) return "No APIs yet.";
        const dirs = fs.readdirSync(API_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        return dirs.map(d => `• ${d.name}`).join("\n") || "No APIs yet.";
      }

      case "api_docs": {
        const specPath = path.join(API_DIR, (args.project as string).toLowerCase(), "openapi.json");
        if (!fs.existsSync(specPath)) return `No OpenAPI spec found for: ${args.project}`;
        return fs.readFileSync(specPath, "utf-8");
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export default apiBuilder;

