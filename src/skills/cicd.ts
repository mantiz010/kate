import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const run = async (cmd: string, cwd?: string) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 30000 });
    return (stdout || stderr || "(no output)").slice(0, 8000);
  } catch (err: any) { return `Error: ${err.stderr || err.message}`.slice(0, 3000); }
};

const TEMPLATES: Record<string, (opts: any) => string> = {
  "node-ci": (opts) => `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [${opts.nodeVersions || '18, 20, 22'}]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build --if-present
`,
  "node-deploy": (opts) => `name: Deploy
on:
  push:
    branches: [${opts.branch || 'main'}]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: Deploy
        run: |
          ${opts.deployCmd || '# Add your deploy command here'}
        env:
          ${opts.envVars || 'DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}'}
`,
  "docker-build": (opts) => `name: Docker Build
on:
  push:
    branches: [${opts.branch || 'main'}]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${opts.registry || 'ghcr.io'}
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: ${opts.registry || 'ghcr.io'}/\${{ github.repository }}:latest
`,
  "python-ci": (opts) => `name: Python CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: [${opts.pythonVersions || '"3.10", "3.11", "3.12"'}]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: \${{ matrix.python-version }}
      - run: pip install -r requirements.txt
      - run: python -m pytest
`,
  "esp32-build": (opts) => `name: ESP32 Build
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: arduino/compile-sketches@v1
        with:
          fqbn: esp32:esp32:esp32
          platforms: |
            - name: esp32:esp32
              source-url: https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
          sketch-paths: ${opts.sketchPath || '.'}
`,
};

const cicd: Skill = {
  id: "builtin.cicd",
  name: "CI/CD",
  description: "Generate GitHub Actions workflows, Dockerfiles, deploy scripts. Templates for Node.js, Python, Docker, ESP32.",
  version: "1.0.0",
  tools: [
    { name: "cicd_generate", description: "Generate a GitHub Actions workflow from a template", parameters: [
      { name: "template", type: "string", description: "Template: node-ci, node-deploy, docker-build, python-ci, esp32-build", required: true },
      { name: "path", type: "string", description: "Project path to save workflow", required: true },
      { name: "options", type: "string", description: "JSON options for template (branch, nodeVersions, etc)", required: false },
    ]},
    { name: "cicd_list_templates", description: "List available CI/CD templates", parameters: [] },
    { name: "cicd_dockerfile", description: "Generate a Dockerfile for a project", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
      { name: "type", type: "string", description: "Project type: node, python, static", required: false },
    ]},
    { name: "cicd_compose", description: "Generate a docker-compose.yml with services", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
      { name: "services", type: "string", description: "JSON array: [{name, image, ports, env}]", required: true },
    ]},
    { name: "cicd_run_workflow", description: "Trigger a GitHub Actions workflow (requires gh CLI)", parameters: [
      { name: "workflow", type: "string", description: "Workflow filename", required: true },
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
    { name: "cicd_status", description: "Check status of recent GitHub Actions runs", parameters: [
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "cicd_generate": {
        const template = args.template as string;
        const projPath = args.path as string;
        const gen = TEMPLATES[template];
        if (!gen) return `Unknown template: ${template}. Available: ${Object.keys(TEMPLATES).join(", ")}`;

        let opts = {};
        if (args.options) { try { opts = JSON.parse(args.options as string); } catch {} }

        const yaml = gen(opts);
        const workflowDir = path.join(projPath, ".github", "workflows");
        if (!fs.existsSync(workflowDir)) fs.mkdirSync(workflowDir, { recursive: true });
        const fileName = `${template}.yml`;
        fs.writeFileSync(path.join(workflowDir, fileName), yaml);
        return `Generated: ${workflowDir}/${fileName}\n\n${yaml}`;
      }

      case "cicd_list_templates": {
        return Object.keys(TEMPLATES).map(t => `• ${t}`).join("\n");
      }

      case "cicd_dockerfile": {
        const projPath = args.path as string;
        let type = args.type as string;

        if (!type) {
          if (fs.existsSync(path.join(projPath, "package.json"))) type = "node";
          else if (fs.existsSync(path.join(projPath, "requirements.txt"))) type = "python";
          else type = "static";
        }

        let dockerfile: string;
        switch (type) {
          case "node":
            dockerfile = `FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
`;
            break;
          case "python":
            dockerfile = `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "main.py"]
`;
            break;
          default:
            dockerfile = `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;
        }

        fs.writeFileSync(path.join(projPath, "Dockerfile"), dockerfile);
        fs.writeFileSync(path.join(projPath, ".dockerignore"), "node_modules\n.git\n*.md\n.env\n");
        return `Generated Dockerfile (${type}):\n\n${dockerfile}`;
      }

      case "cicd_compose": {
        const projPath = args.path as string;
        let services: any[];
        try { services = JSON.parse(args.services as string); } catch (e: any) { return "Invalid services JSON: " + e.message; }

        const svcBlocks = services.map(s => {
          const ports = (s.ports || []).map((p: string) => `      - "${p}"`).join("\n");
          const env = Object.entries(s.env || {}).map(([k, v]) => `      ${k}: "${v}"`).join("\n");
          return `  ${s.name}:
    image: ${s.image}
${ports ? `    ports:\n${ports}` : ""}
${env ? `    environment:\n${env}` : ""}
    restart: unless-stopped`;
        }).join("\n\n");

        const compose = `version: '3.8'\nservices:\n${svcBlocks}\n`;
        fs.writeFileSync(path.join(projPath, "docker-compose.yml"), compose);
        return `Generated docker-compose.yml:\n\n${compose}`;
      }

      case "cicd_run_workflow": {
        const cwd = (args.path as string) || process.cwd();
        return run(`gh workflow run ${args.workflow}`, cwd);
      }

      case "cicd_status": {
        const cwd = (args.path as string) || process.cwd();
        return run("gh run list --limit 10", cwd);
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export default cicd;

