import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const HOSTS_FILE = path.join(os.homedir(), ".aegis", "ssh-hosts.json");

interface SSHHost { name: string; host: string; user: string; port: number; key?: string; }
let hosts: SSHHost[] = [];
function loadHosts() { try { if (fs.existsSync(HOSTS_FILE)) hosts = JSON.parse(fs.readFileSync(HOSTS_FILE, "utf-8")); } catch {} }
function saveHosts() { const d = path.dirname(HOSTS_FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2)); }

function sshCmd(host: SSHHost, cmd: string): string {
  const key = host.key ? `-i ${host.key}` : "";
  return `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${key} -p ${host.port} ${host.user}@${host.host} "${cmd.replace(/"/g, '\\"')}"`;
}

const run = async (cmd: string, timeout = 30000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 5 });
    return (stdout || stderr || "(no output)").slice(0, 10000);
  } catch (err: any) { return `Error: ${err.stderr || err.message}`.slice(0, 5000); }
};

const ssh: Skill = {
  id: "builtin.ssh",
  name: "SSH Remote",
  description: "Manage remote servers via SSH — run commands, transfer files, check health, manage saved hosts",
  version: "1.0.0",
  tools: [
    { name: "ssh_run", description: "Run a command on a remote server", parameters: [
      { name: "host", type: "string", description: "Hostname/IP or saved host name", required: true },
      { name: "command", type: "string", description: "Command to execute", required: true },
      { name: "user", type: "string", description: "SSH user (default: current user)", required: false },
      { name: "port", type: "number", description: "SSH port (default: 22)", required: false },
    ]},
    { name: "ssh_health", description: "Quick health check on a remote server (CPU, mem, disk, uptime)", parameters: [
      { name: "host", type: "string", description: "Hostname/IP or saved host name", required: true },
      { name: "user", type: "string", description: "SSH user", required: false },
    ]},
    { name: "ssh_copy_to", description: "Copy a file to a remote server via scp", parameters: [
      { name: "local", type: "string", description: "Local file path", required: true },
      { name: "host", type: "string", description: "Hostname/IP or saved host name", required: true },
      { name: "remote", type: "string", description: "Remote destination path", required: true },
      { name: "user", type: "string", description: "SSH user", required: false },
    ]},
    { name: "ssh_copy_from", description: "Copy a file from a remote server", parameters: [
      { name: "host", type: "string", description: "Hostname/IP or saved host name", required: true },
      { name: "remote", type: "string", description: "Remote file path", required: true },
      { name: "local", type: "string", description: "Local destination path", required: true },
      { name: "user", type: "string", description: "SSH user", required: false },
    ]},
    { name: "ssh_tunnel", description: "Create an SSH tunnel (port forward)", parameters: [
      { name: "host", type: "string", description: "Hostname/IP", required: true },
      { name: "localPort", type: "number", description: "Local port", required: true },
      { name: "remotePort", type: "number", description: "Remote port", required: true },
      { name: "user", type: "string", description: "SSH user", required: false },
    ]},
    { name: "ssh_save_host", description: "Save a host for quick access", parameters: [
      { name: "name", type: "string", description: "Friendly name", required: true },
      { name: "host", type: "string", description: "Hostname or IP", required: true },
      { name: "user", type: "string", description: "SSH username", required: true },
      { name: "port", type: "number", description: "Port (default: 22)", required: false },
      { name: "key", type: "string", description: "Path to SSH key file", required: false },
    ]},
    { name: "ssh_list_hosts", description: "List saved SSH hosts", parameters: [] },
    { name: "ssh_remove_host", description: "Remove a saved host", parameters: [
      { name: "name", type: "string", description: "Host name to remove", required: true },
    ]},
    { name: "ssh_multi_run", description: "Run a command on multiple hosts at once", parameters: [
      { name: "hosts", type: "string", description: "Comma-separated host names or IPs", required: true },
      { name: "command", type: "string", description: "Command to run on all", required: true },
      { name: "user", type: "string", description: "SSH user", required: false },
    ]},
  ],

  async onLoad() { loadHosts(); },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    loadHosts();

    function resolve(name: string, user?: string): SSHHost {
      const saved = hosts.find(h => h.name === name);
      if (saved) return saved;
      return { name, host: name, user: (user as string) || os.userInfo().username, port: (args.port as number) || 22 };
    }

    switch (toolName) {
      case "ssh_run": {
        const h = resolve(args.host as string, args.user as string);
        return run(sshCmd(h, args.command as string), 60000);
      }
      case "ssh_health": {
        const h = resolve(args.host as string, args.user as string);
        const cmd = `echo "=== $(hostname) ===" && echo "Uptime: $(uptime)" && echo "CPU: $(top -bn1 | head -3 | tail -1)" && echo "Memory:" && free -h | head -2 && echo "Disk:" && df -h / | tail -1 && echo "Load: $(cat /proc/loadavg)"`;
        return run(sshCmd(h, cmd), 15000);
      }
      case "ssh_copy_to": {
        const h = resolve(args.host as string, args.user as string);
        const key = h.key ? `-i ${h.key}` : "";
        return run(`scp ${key} -P ${h.port} -o StrictHostKeyChecking=no "${args.local}" ${h.user}@${h.host}:"${args.remote}"`, 120000);
      }
      case "ssh_copy_from": {
        const h = resolve(args.host as string, args.user as string);
        const key = h.key ? `-i ${h.key}` : "";
        return run(`scp ${key} -P ${h.port} -o StrictHostKeyChecking=no ${h.user}@${h.host}:"${args.remote}" "${args.local}"`, 120000);
      }
      case "ssh_tunnel": {
        const h = resolve(args.host as string, args.user as string);
        const key = h.key ? `-i ${h.key}` : "";
        const cmd = `ssh -f -N -L ${args.localPort}:localhost:${args.remotePort} ${key} -p ${h.port} ${h.user}@${h.host}`;
        const result = await run(cmd, 10000);
        return result.includes("Error") ? result : `Tunnel: localhost:${args.localPort} → ${h.host}:${args.remotePort}`;
      }
      case "ssh_save_host": {
        const h: SSHHost = { name: args.name as string, host: args.host as string, user: args.user as string, port: (args.port as number) || 22, key: args.key as string };
        hosts = hosts.filter(x => x.name !== h.name);
        hosts.push(h);
        saveHosts();
        return `Saved: ${h.name} → ${h.user}@${h.host}:${h.port}`;
      }
      case "ssh_list_hosts": {
        if (hosts.length === 0) return "No saved hosts. Use ssh_save_host to add one.";
        return hosts.map(h => `• ${h.name} → ${h.user}@${h.host}:${h.port}${h.key ? " (key: " + h.key + ")" : ""}`).join("\n");
      }
      case "ssh_remove_host": {
        hosts = hosts.filter(h => h.name !== args.name);
        saveHosts();
        return `Removed: ${args.name}`;
      }
      case "ssh_multi_run": {
        const names = (args.hosts as string).split(",").map(s => s.trim());
        const results: string[] = [];
        for (const name of names) {
          const h = resolve(name, args.user as string);
          const out = await run(sshCmd(h, args.command as string), 30000);
          results.push(`=== ${h.name} (${h.host}) ===\n${out}`);
        }
        return results.join("\n\n");
      }
      default: return `Unknown: ${toolName}`;
    }
  },
};
export default ssh;

