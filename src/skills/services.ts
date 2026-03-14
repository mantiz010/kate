import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";

const execAsync = promisify(exec);
const run = async (cmd: string, timeout = 30000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 });
    return (stdout || stderr || "(no output)").slice(0, 10000);
  } catch (err: any) { return `Error: ${err.stderr || err.message}`.slice(0, 5000); }
};

const services: Skill = {
  id: "builtin.services",
  name: "Services",
  description: "Manage systemd services — create, start, stop, restart, enable, disable. Create Kate as a system service for auto-start on boot.",
  version: "1.0.0",
  tools: [
    { name: "svc_list", description: "List running services", parameters: [
      { name: "filter", type: "string", description: "Filter by name", required: false },
      { name: "all", type: "boolean", description: "Show all including inactive", required: false },
    ]},
    { name: "svc_status", description: "Get status of a service", parameters: [
      { name: "name", type: "string", description: "Service name", required: true },
    ]},
    { name: "svc_start", description: "Start a service", parameters: [
      { name: "name", type: "string", description: "Service name", required: true },
    ]},
    { name: "svc_stop", description: "Stop a service", parameters: [
      { name: "name", type: "string", description: "Service name", required: true },
    ]},
    { name: "svc_restart", description: "Restart a service", parameters: [
      { name: "name", type: "string", description: "Service name", required: true },
    ]},
    { name: "svc_enable", description: "Enable a service to start on boot", parameters: [
      { name: "name", type: "string", description: "Service name", required: true },
    ]},
    { name: "svc_disable", description: "Disable a service from starting on boot", parameters: [
      { name: "name", type: "string", description: "Service name", required: true },
    ]},
    { name: "svc_logs", description: "View service logs from journalctl", parameters: [
      { name: "name", type: "string", description: "Service name", required: true },
      { name: "lines", type: "number", description: "Number of lines (default: 30)", required: false },
    ]},
    { name: "svc_create", description: "Create a new systemd service unit file", parameters: [
      { name: "name", type: "string", description: "Service name (e.g. kate, kate-web)", required: true },
      { name: "command", type: "string", description: "Full command to run", required: true },
      { name: "workdir", type: "string", description: "Working directory", required: false },
      { name: "user", type: "string", description: "Run as user (default: current)", required: false },
      { name: "restart", type: "string", description: "Restart policy: always, on-failure, no (default: on-failure)", required: false },
      { name: "description", type: "string", description: "Service description", required: false },
    ]},
    { name: "svc_install_kate", description: "Create systemd services for Kate CLI and Web UI with auto-start on boot", parameters: [
      { name: "webPort", type: "number", description: "Web UI port (default: 3200)", required: false },
    ]},
    { name: "svc_failed", description: "List failed services", parameters: [] },
    { name: "svc_reload", description: "Reload systemd daemon (after creating/editing services)", parameters: [] },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "svc_list": {
        const all = (args.all as boolean) ? "--all" : "";
        const filter = (args.filter as string) || "";
        if (filter) return run(`systemctl list-units --type=service ${all} 2>/dev/null | grep -i "${filter}" | head -25`);
        return run(`systemctl list-units --type=service --state=running 2>/dev/null | head -30`);
      }
      case "svc_status": return run(`systemctl status ${args.name} 2>&1 | head -20`);
      case "svc_start": return run(`sudo systemctl start ${args.name} 2>&1 && echo "Started: ${args.name}"`);
      case "svc_stop": return run(`sudo systemctl stop ${args.name} 2>&1 && echo "Stopped: ${args.name}"`);
      case "svc_restart": return run(`sudo systemctl restart ${args.name} 2>&1 && echo "Restarted: ${args.name}"`);
      case "svc_enable": return run(`sudo systemctl enable ${args.name} 2>&1 && echo "Enabled: ${args.name}"`);
      case "svc_disable": return run(`sudo systemctl disable ${args.name} 2>&1 && echo "Disabled: ${args.name}"`);
      case "svc_logs": {
        const n = (args.lines as number) || 30;
        return run(`journalctl -u ${args.name} -n ${n} --no-pager 2>&1`);
      }
      case "svc_create": {
        const name = args.name as string;
        const command = args.command as string;
        const workdir = (args.workdir as string) || os.homedir();
        const user = (args.user as string) || os.userInfo().username;
        const restart = (args.restart as string) || "on-failure";
        const desc = (args.description as string) || `${name} service`;

        const unit = `[Unit]
Description=${desc}
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workdir}
ExecStart=${command}
Restart=${restart}
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${os.homedir()}/.npm-global/bin

[Install]
WantedBy=multi-user.target
`;
        const unitPath = `/etc/systemd/system/${name}.service`;
        fs.writeFileSync("/tmp/kate-svc.tmp", unit);
        const result = await run(`sudo cp /tmp/kate-svc.tmp ${unitPath} && sudo systemctl daemon-reload && echo "Created: ${unitPath}"`);
        return `${result}\n\nService file:\n${unit}\nEnable: sudo systemctl enable ${name}\nStart: sudo systemctl start ${name}`;
      }

      case "svc_install_kate": {
        const port = (args.webPort as number) || 3200;
        const user = os.userInfo().username;
        const home = os.homedir();
        const node = await run("which node");
        const tsx = await run("which tsx 2>/dev/null || echo npx tsx");

        // Kate Web service
        const webUnit = `[Unit]
Description=Kate AI Web UI
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${home}/kate
ExecStart=${node.trim()} ${home}/kate/node_modules/.bin/tsx src/cli.ts web --port ${port}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
Environment=HOME=${home}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${home}/.npm-global/bin:${home}/.local/bin

[Install]
WantedBy=multi-user.target
`;

        // HA health reporter
        const haUnit = `[Unit]
Description=Kate HA Health Reporter
After=network.target

[Service]
Type=simple
User=${user}
ExecStart=/usr/bin/python3 ${home}/ha_health.py
Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal
Environment=HOME=${home}

[Install]
WantedBy=multi-user.target
`;

        const results: string[] = [];

        fs.writeFileSync("/tmp/kate-web.service", webUnit);
        results.push(await run(`sudo cp /tmp/kate-web.service /etc/systemd/system/kate-web.service`));

        fs.writeFileSync("/tmp/kate-ha.service", haUnit);
        results.push(await run(`sudo cp /tmp/kate-ha.service /etc/systemd/system/kate-ha.service`));

        await run("sudo systemctl daemon-reload");
        await run("sudo systemctl enable kate-web");
        await run("sudo systemctl enable kate-ha");

        return [
          "✓ Created systemd services:",
          "",
          "  kate-web — Web UI on port " + port,
          "  kate-ha  — Home Assistant health reporter",
          "",
          "Start them:",
          "  sudo systemctl start kate-web",
          "  sudo systemctl start kate-ha",
          "",
          "Check status:",
          "  sudo systemctl status kate-web",
          "  sudo systemctl status kate-ha",
          "",
          "View logs:",
          "  journalctl -u kate-web -f",
        ].join("\n");
      }

      case "svc_failed": return run("systemctl list-units --type=service --state=failed 2>&1");
      case "svc_reload": return run("sudo systemctl daemon-reload 2>&1 && echo 'Daemon reloaded'");
      default: return `Unknown: ${toolName}`;
    }
  },
};
export default services;

