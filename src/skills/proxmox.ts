import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const PVE_HOST = "172.168.1.204";
const PVE_PORT = 8006;
const PVE_BASE = "https://" + PVE_HOST + ":" + PVE_PORT + "/api2/json";

async function pveApi(method: string, path: string, token?: string, data?: string): Promise<any> {
  let cmd = "curl -s -k -m 15 -X " + method;
  if (token) {
    cmd += " -H " + JSON.stringify("Authorization: PVEAPIToken=" + token);
  }
  if (data) {
    cmd += " -d " + JSON.stringify(data);
  }
  cmd += " " + JSON.stringify(PVE_BASE + path);
  console.log("[PVE] CMD:", cmd);
  console.log("[PVE] CMD:", cmd);
  try {
    const { stdout } = await execAsync(cmd, { timeout: 20000 });
    return JSON.parse(stdout);
  } catch (e: any) {
    return { error: e.message };
  }
}

async function pveLogin(user: string, password: string): Promise<string> {
  const cmd = "curl -s -k -m 10 -d 'username=" + user + "&password=" + password + "' \"" + PVE_BASE + "/access/ticket\"";
  try {
    const { stdout } = await execAsync(cmd, { timeout: 15000 });
    const data = JSON.parse(stdout);
    if (data.data?.ticket) {
      return "PVEAuthCookie=" + data.data.ticket;
    }
    return "";
  } catch { return ""; }
}

let savedToken = "root@pam!kate=72044133-574b-4b30-be19-3559f828a7b0";

const proxmox: Skill = {
  id: "builtin.proxmox",
  name: "Proxmox",
  description: "Manage Proxmox VE: list VMs/containers, start/stop/restart, check status, manage storage, view cluster health.",
  version: "1.0.0",
  tools: [
    { name: "pve_auth", description: "Authenticate with Proxmox API. Use API token format: user@realm!tokenid=TOKEN-UUID", parameters: [
      { name: "token", type: "string", description: "API token: user@pam!tokenid=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", required: true },
    ]},
    { name: "pve_nodes", description: "List all Proxmox nodes in the cluster", parameters: [] },
    { name: "pve_vms", description: "List all VMs and containers across all nodes", parameters: [
      { name: "node", type: "string", description: "Node name (optional, lists all if empty)", required: false },
    ]},
    { name: "pve_vm_status", description: "Get detailed status of a VM or container", parameters: [
      { name: "node", type: "string", description: "Node name", required: true },
      { name: "vmid", type: "string", description: "VM ID number", required: true },
      { name: "type", type: "string", description: "qemu or lxc (default: qemu)", required: false },
    ]},
    { name: "pve_vm_start", description: "Start a VM or container", parameters: [
      { name: "node", type: "string", description: "Node name", required: true },
      { name: "vmid", type: "string", description: "VM ID", required: true },
      { name: "type", type: "string", description: "qemu or lxc", required: false },
    ]},
    { name: "pve_vm_stop", description: "Stop a VM or container", parameters: [
      { name: "node", type: "string", description: "Node name", required: true },
      { name: "vmid", type: "string", description: "VM ID", required: true },
      { name: "type", type: "string", description: "qemu or lxc", required: false },
    ]},
    { name: "pve_vm_restart", description: "Restart a VM or container", parameters: [
      { name: "node", type: "string", description: "Node name", required: true },
      { name: "vmid", type: "string", description: "VM ID", required: true },
      { name: "type", type: "string", description: "qemu or lxc", required: false },
    ]},
    { name: "pve_storage", description: "List storage on a node", parameters: [
      { name: "node", type: "string", description: "Node name", required: true },
    ]},
    { name: "pve_cluster_status", description: "Get cluster health and resource usage", parameters: [] },
    { name: "pve_node_status", description: "Get detailed node status (CPU, RAM, uptime)", parameters: [
      { name: "node", type: "string", description: "Node name", required: true },
    ]},
    { name: "pve_tasks", description: "List recent tasks on a node", parameters: [
      { name: "node", type: "string", description: "Node name", required: true },
    ]},
    { name: "pve_snapshot", description: "Create a snapshot of a VM", parameters: [
      { name: "node", type: "string", description: "Node name", required: true },
      { name: "vmid", type: "string", description: "VM ID", required: true },
      { name: "name", type: "string", description: "Snapshot name", required: true },
      { name: "type", type: "string", description: "qemu or lxc", required: false },
    ]},
    { name: "pve_backup", description: "Start a backup of a VM", parameters: [
      { name: "node", type: "string", description: "Node name", required: true },
      { name: "vmid", type: "string", description: "VM ID", required: true },
      { name: "storage", type: "string", description: "Backup storage name", required: true },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    const token = savedToken;
        console.log("[PVE] Token:", token ? token.slice(0, 20) + "..." : "EMPTY");
        console.log("[PVE] Token:", token ? token.slice(0, 20) + "..." : "EMPTY");

    switch (toolName) {
      case "pve_auth": {
        savedToken = args.token as string;
        // Test auth
        const result = await pveApi("GET", "/version", savedToken);
        if (result.data?.version) {
          return "Authenticated. Proxmox VE " + result.data.version + " (release: " + result.data.release + ")";
        }
        return "Auth failed. Use format: user@pam!tokenid=TOKEN-UUID\nResponse: " + JSON.stringify(result).slice(0, 200);
      }

      case "pve_nodes": {
        const result = await pveApi("GET", "/nodes", token);
        if (result.error) return "Error: " + result.error;
        if (!result.data) return "No nodes found. Are you authenticated? Use pve_auth first.";
        return "Proxmox Nodes:\n\n" + result.data.map((n: any) =>
          (n.status === "online" ? "🟢" : "🔴") + " " + n.node +
          "\n  Status: " + n.status +
          "\n  CPU: " + Math.round((n.cpu || 0) * 100) + "%" +
          "\n  RAM: " + Math.round(((n.mem || 0) / (n.maxmem || 1)) * 100) + "% (" + Math.round((n.mem || 0) / 1073741824) + "/" + Math.round((n.maxmem || 0) / 1073741824) + " GB)" +
          "\n  Uptime: " + Math.round((n.uptime || 0) / 3600) + "h"
        ).join("\n\n");
      }

      case "pve_vms": {
        const node = args.node as string;
        let nodes: string[] = [];

        if (node) {
          nodes = [node];
        } else {
          const nodesResult = await pveApi("GET", "/nodes", token);
          if (nodesResult.data) nodes = nodesResult.data.map((n: any) => n.node);
        }

        const allVms: string[] = [];
        for (const n of nodes) {
          // QEMUs
          const qemu = await pveApi("GET", "/nodes/" + n + "/qemu", token);
          if (qemu.data) {
            for (const vm of qemu.data) {
              allVms.push(
                (vm.status === "running" ? "🟢" : "🔴") + " VM " + vm.vmid + ": " + vm.name +
                "\n  Node: " + n + " | Status: " + vm.status + " | Type: qemu" +
                "\n  CPU: " + (vm.cpus || "?") + " cores | RAM: " + Math.round((vm.maxmem || 0) / 1073741824) + " GB" +
                (vm.status === "running" ? "\n  CPU use: " + Math.round((vm.cpu || 0) * 100) + "% | RAM use: " + Math.round((vm.mem || 0) / 1073741824) + " GB" : "")
              );
            }
          }
          // LXCs
          const lxc = await pveApi("GET", "/nodes/" + n + "/lxc", token);
          if (lxc.data) {
            for (const ct of lxc.data) {
              allVms.push(
                (ct.status === "running" ? "🟢" : "🔴") + " CT " + ct.vmid + ": " + ct.name +
                "\n  Node: " + n + " | Status: " + ct.status + " | Type: lxc" +
                "\n  RAM: " + Math.round((ct.maxmem || 0) / 1073741824) + " GB"
              );
            }
          }
        }

        if (allVms.length === 0) return "No VMs found. Check auth with pve_auth.";
        return "VMs & Containers (" + allVms.length + "):\n\n" + allVms.join("\n\n");
      }

      case "pve_vm_status": {
        const type = (args.type as string) || "qemu";
        const result = await pveApi("GET", "/nodes/" + args.node + "/" + type + "/" + args.vmid + "/status/current", token);
        if (result.error) return "Error: " + result.error;
        const d = result.data;
        if (!d) return "VM not found.";
        return "VM " + args.vmid + " (" + (d.name || "?") + "):\n" +
          "  Status: " + d.status + "\n" +
          "  CPU: " + (d.cpus || "?") + " cores, " + Math.round((d.cpu || 0) * 100) + "% used\n" +
          "  RAM: " + Math.round((d.mem || 0) / 1073741824) + "/" + Math.round((d.maxmem || 0) / 1073741824) + " GB\n" +
          "  Disk: " + Math.round((d.disk || 0) / 1073741824) + "/" + Math.round((d.maxdisk || 0) / 1073741824) + " GB\n" +
          "  Uptime: " + Math.round((d.uptime || 0) / 3600) + "h\n" +
          "  PID: " + (d.pid || "?");
      }

      case "pve_vm_start": {
        const type = (args.type as string) || "qemu";
        const result = await pveApi("POST", "/nodes/" + args.node + "/" + type + "/" + args.vmid + "/status/start", token);
        return result.data ? "Starting VM " + args.vmid + "..." : "Error: " + JSON.stringify(result).slice(0, 200);
      }

      case "pve_vm_stop": {
        const type = (args.type as string) || "qemu";
        const result = await pveApi("POST", "/nodes/" + args.node + "/" + type + "/" + args.vmid + "/status/stop", token);
        return result.data ? "Stopping VM " + args.vmid + "..." : "Error: " + JSON.stringify(result).slice(0, 200);
      }

      case "pve_vm_restart": {
        const type = (args.type as string) || "qemu";
        const result = await pveApi("POST", "/nodes/" + args.node + "/" + type + "/" + args.vmid + "/status/reboot", token);
        return result.data ? "Restarting VM " + args.vmid + "..." : "Error: " + JSON.stringify(result).slice(0, 200);
      }

      case "pve_storage": {
        const result = await pveApi("GET", "/nodes/" + args.node + "/storage", token);
        if (result.error) return "Error: " + result.error;
        if (!result.data) return "No storage found.";
        return "Storage on " + args.node + ":\n\n" + result.data.map((s: any) =>
          "📦 " + s.storage + " [" + s.type + "]\n" +
          "  Used: " + Math.round((s.used || 0) / 1073741824) + "/" + Math.round((s.total || 0) / 1073741824) + " GB (" + Math.round(((s.used || 0) / (s.total || 1)) * 100) + "%)\n" +
          "  Status: " + (s.active ? "active" : "inactive") + " | Content: " + (s.content || "?")
        ).join("\n\n");
      }

      case "pve_cluster_status": {
        const result = await pveApi("GET", "/cluster/status", token);
        if (result.error) return "Error: " + result.error;
        if (!result.data) return "No cluster info.";
        return "Cluster Status:\n\n" + result.data.map((n: any) =>
          (n.online ? "🟢" : "🔴") + " " + n.name + " [" + n.type + "]" +
          (n.ip ? "\n  IP: " + n.ip : "") +
          (n.level !== undefined ? "\n  Level: " + n.level : "")
        ).join("\n\n");
      }

      case "pve_node_status": {
        const result = await pveApi("GET", "/nodes/" + args.node + "/status", token);
        if (result.error) return "Error: " + result.error;
        const d = result.data;
        if (!d) return "Node not found.";
        return "Node " + args.node + ":\n" +
          "  CPU: " + (d.cpuinfo?.cpus || "?") + " cores, " + (d.cpuinfo?.model || "?") + "\n" +
          "  RAM: " + Math.round((d.memory?.used || 0) / 1073741824) + "/" + Math.round((d.memory?.total || 0) / 1073741824) + " GB\n" +
          "  Swap: " + Math.round((d.swap?.used || 0) / 1073741824) + "/" + Math.round((d.swap?.total || 0) / 1073741824) + " GB\n" +
          "  Uptime: " + Math.round((d.uptime || 0) / 3600) + "h\n" +
          "  Kernel: " + (d.kversion || "?") + "\n" +
          "  PVE: " + (d.pveversion || "?");
      }

      case "pve_tasks": {
        const result = await pveApi("GET", "/nodes/" + args.node + "/tasks?limit=10", token);
        if (result.error) return "Error: " + result.error;
        if (!result.data?.length) return "No recent tasks.";
        return "Recent Tasks on " + args.node + ":\n\n" + result.data.slice(0, 10).map((t: any) =>
          (t.status === "OK" ? "✓" : "✗") + " " + t.type + " — " + (t.id || "?") +
          "\n  Status: " + t.status + " | User: " + (t.user || "?") +
          "\n  Start: " + new Date((t.starttime || 0) * 1000).toLocaleString()
        ).join("\n\n");
      }

      case "pve_snapshot": {
        const type = (args.type as string) || "qemu";
        const result = await pveApi("POST", "/nodes/" + args.node + "/" + type + "/" + args.vmid + "/snapshot", token, "snapname=" + args.name);
        return result.data ? "Snapshot '" + args.name + "' created for VM " + args.vmid : "Error: " + JSON.stringify(result).slice(0, 200);
      }

      case "pve_backup": {
        const result = await pveApi("POST", "/nodes/" + args.node + "/vzdump", token, "vmid=" + args.vmid + "&storage=" + args.storage + "&mode=snapshot");
        return result.data ? "Backup started for VM " + args.vmid + " to " + args.storage : "Error: " + JSON.stringify(result).slice(0, 200);
      }

      default: return "Unknown: " + toolName;
    }
  },
};

export default proxmox;
