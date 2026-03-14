import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

const codegen: Skill = {
  id: "builtin.codegen",
  name: "Code Generator",
  description: "Generate boilerplate code, project scaffolds, configs, docker files, nginx configs, systemd units, cron entries, and more.",
  version: "1.0.0",
  tools: [
    { name: "gen_project", description: "Scaffold a new project (Node.js, Python, or static)", parameters: [
      { name: "name", type: "string", description: "Project name", required: true },
      { name: "type", type: "string", description: "node, python, static, api, cli", required: true },
      { name: "path", type: "string", description: "Parent directory (default: ~/)", required: false },
    ]},
    { name: "gen_dockerfile", description: "Generate Dockerfile for a project", parameters: [
      { name: "type", type: "string", description: "node, python, static, go", required: true },
      { name: "path", type: "string", description: "Output directory", required: true },
    ]},
    { name: "gen_nginx", description: "Generate nginx config (reverse proxy, static, SSL)", parameters: [
      { name: "domain", type: "string", description: "Domain name", required: true },
      { name: "upstream", type: "string", description: "Upstream address (e.g. localhost:3200)", required: true },
      { name: "ssl", type: "boolean", description: "Include SSL/certbot config", required: false },
      { name: "path", type: "string", description: "Output path (default: stdout)", required: false },
    ]},
    { name: "gen_env", description: "Generate a .env file from a template", parameters: [
      { name: "vars", type: "string", description: "Comma-separated KEY=value or KEY=placeholder pairs", required: true },
      { name: "path", type: "string", description: "Output path", required: true },
    ]},
    { name: "gen_readme", description: "Generate a README.md for a project", parameters: [
      { name: "name", type: "string", description: "Project name", required: true },
      { name: "description", type: "string", description: "Project description", required: true },
      { name: "type", type: "string", description: "Project type (node, python, etc)", required: false },
      { name: "path", type: "string", description: "Output directory", required: true },
    ]},
    { name: "gen_gitignore", description: "Generate .gitignore for a project type", parameters: [
      { name: "type", type: "string", description: "node, python, go, rust, c, java, general", required: true },
      { name: "path", type: "string", description: "Output directory", required: true },
    ]},
    { name: "gen_makefile", description: "Generate a Makefile with common targets", parameters: [
      { name: "type", type: "string", description: "node, python, go, c", required: true },
      { name: "path", type: "string", description: "Output directory", required: true },
    ]},
    { name: "gen_systemd", description: "Generate a systemd service file", parameters: [
      { name: "name", type: "string", description: "Service name", required: true },
      { name: "command", type: "string", description: "Command to run", required: true },
      { name: "workdir", type: "string", description: "Working directory", required: false },
      { name: "user", type: "string", description: "Run as user", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "gen_project": {
        const name = args.name as string;
        const type = args.type as string;
        const base = ((args.path as string) || os.homedir()).replace("~", os.homedir());
        const dir = path.join(base, name);
        ensureDir(dir);

        switch (type) {
          case "node": case "api": case "cli": {
            fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
              name, version: "1.0.0", type: "module", main: "index.js",
              scripts: { start: "node index.js", dev: "node --watch index.js", test: "echo 'No tests'" },
            }, null, 2));
            fs.writeFileSync(path.join(dir, "index.js"), `console.log("Hello from ${name}");\n`);
            fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.env\ndist/\n");
            break;
          }
          case "python": {
            fs.writeFileSync(path.join(dir, "main.py"), `#!/usr/bin/env python3\n"""${name}"""\n\ndef main():\n    print("Hello from ${name}")\n\nif __name__ == "__main__":\n    main()\n`);
            fs.writeFileSync(path.join(dir, "requirements.txt"), "# Add dependencies here\n");
            fs.writeFileSync(path.join(dir, ".gitignore"), "__pycache__/\n*.pyc\n.env\nvenv/\n");
            break;
          }
          case "static": {
            fs.writeFileSync(path.join(dir, "index.html"), `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><title>${name}</title></head>\n<body><h1>${name}</h1></body>\n</html>\n`);
            break;
          }
        }
        return `✓ Project scaffolded: ${dir}\n  Type: ${type}`;
      }

      case "gen_dockerfile": {
        const type = args.type as string;
        const dir = (args.path as string).replace("~", os.homedir());
        let df: string;
        switch (type) {
          case "node": df = `FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --production\nCOPY . .\nEXPOSE 3000\nCMD ["node", "index.js"]\n`; break;
          case "python": df = `FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE 8000\nCMD ["python", "main.py"]\n`; break;
          case "static": df = `FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n`; break;
          case "go": df = `FROM golang:1.22-alpine AS build\nWORKDIR /app\nCOPY go.* ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 go build -o app .\n\nFROM alpine:3.19\nCOPY --from=build /app/app /app\nEXPOSE 8080\nCMD ["/app"]\n`; break;
          default: df = `FROM ubuntu:22.04\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates\nWORKDIR /app\nCOPY . .\nCMD ["bash"]\n`;
        }
        ensureDir(dir);
        fs.writeFileSync(path.join(dir, "Dockerfile"), df);
        fs.writeFileSync(path.join(dir, ".dockerignore"), "node_modules\n.git\n*.md\n.env\n");
        return `✓ Dockerfile (${type}) created in ${dir}`;
      }

      case "gen_nginx": {
        const domain = args.domain as string;
        const upstream = args.upstream as string;
        const ssl = args.ssl as boolean;
        let config = `server {\n    listen 80;\n    server_name ${domain};\n\n    location / {\n        proxy_pass http://${upstream};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n}\n`;
        if (ssl) {
          config += `\n# After running: sudo certbot --nginx -d ${domain}\n# SSL config will be auto-added\n`;
        }
        if (args.path) {
          const p = (args.path as string).replace("~", os.homedir());
          ensureDir(path.dirname(p));
          fs.writeFileSync(p, config);
          return `✓ Nginx config saved: ${p}`;
        }
        return config;
      }

      case "gen_env": {
        const vars = (args.vars as string).split(",").map(v => v.trim());
        const content = vars.map(v => v.includes("=") ? v : `${v}=`).join("\n") + "\n";
        const p = (args.path as string).replace("~", os.homedir());
        ensureDir(path.dirname(p));
        fs.writeFileSync(p, content);
        return `✓ .env created: ${p} (${vars.length} variables)`;
      }

      case "gen_readme": {
        const p = (args.path as string).replace("~", os.homedir());
        const readme = `# ${args.name}\n\n${args.description}\n\n## Getting Started\n\n\`\`\`bash\n# Clone\ngit clone <url>\ncd ${args.name}\n\n# Install\nnpm install\n\n# Run\nnpm start\n\`\`\`\n\n## License\n\nMIT\n`;
        ensureDir(p);
        fs.writeFileSync(path.join(p, "README.md"), readme);
        return `✓ README.md created in ${p}`;
      }

      case "gen_gitignore": {
        const type = args.type as string;
        const ignores: Record<string, string> = {
          node: "node_modules/\ndist/\n.env\n*.log\n.cache/\n",
          python: "__pycache__/\n*.pyc\n.env\nvenv/\n*.egg-info/\ndist/\nbuild/\n",
          go: "bin/\n*.exe\n.env\nvendor/\n",
          rust: "target/\n.env\nCargo.lock\n",
          c: "*.o\n*.so\n*.a\nbuild/\n*.out\n",
          java: "*.class\ntarget/\n.settings/\n*.jar\n.gradle/\nbuild/\n",
          general: ".env\n*.log\n.cache/\n.DS_Store\nthumbs.db\n*.swp\n*~\n",
        };
        const content = ignores[type] || ignores.general;
        const p = (args.path as string).replace("~", os.homedir());
        fs.writeFileSync(path.join(p, ".gitignore"), content);
        return `✓ .gitignore (${type}) created`;
      }

      case "gen_makefile": {
        const type = args.type as string;
        const makes: Record<string, string> = {
          node: `.PHONY: dev build test clean\ndev:\n\tnpm run dev\nbuild:\n\tnpm run build\ntest:\n\tnpm test\nclean:\n\trm -rf dist node_modules\ninstall:\n\tnpm install\n`,
          python: `.PHONY: run test clean venv\nrun:\n\tpython3 main.py\ntest:\n\tpython3 -m pytest\nvenv:\n\tpython3 -m venv venv\nclean:\n\trm -rf __pycache__ *.pyc .pytest_cache\ninstall:\n\tpip install -r requirements.txt\n`,
          go: `.PHONY: build run test clean\nbuild:\n\tgo build -o bin/app .\nrun:\n\tgo run .\ntest:\n\tgo test ./...\nclean:\n\trm -rf bin/\n`,
          c: `CC=gcc\nCFLAGS=-Wall -O2\nTARGET=app\nSRC=$(wildcard *.c)\n\n$(TARGET): $(SRC)\n\t$(CC) $(CFLAGS) -o $@ $^\n\nclean:\n\trm -f $(TARGET)\n`,
        };
        const content = makes[type] || makes.node;
        const p = (args.path as string).replace("~", os.homedir());
        fs.writeFileSync(path.join(p, "Makefile"), content);
        return `✓ Makefile (${type}) created`;
      }

      case "gen_systemd": {
        const unit = `[Unit]\nDescription=${args.name}\nAfter=network.target\n\n[Service]\nType=simple\nUser=${(args.user as string) || os.userInfo().username}\nWorkingDirectory=${(args.workdir as string) || os.homedir()}\nExecStart=${args.command}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`;
        return `Systemd unit for "${args.name}":\n\n${unit}\nSave to: /etc/systemd/system/${args.name}.service\nThen: sudo systemctl daemon-reload && sudo systemctl enable --now ${args.name}`;
      }

      default: return `Unknown: ${toolName}`;
    }
  },
};
export default codegen;

