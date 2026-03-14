import type { Skill, SkillContext } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("multiagent");

interface SubAgent {
  name: string;
  role: string;
  skills: string[];
  prompt: string;
  status: "idle" | "working" | "done" | "error";
  lastTask?: string;
  lastResult?: string;
  taskCount: number;
  created: number;
}

const agents = new Map<string, SubAgent>();

const SPECS: Record<string, Omit<SubAgent, "status" | "taskCount" | "created">> = {
  devops: { name: "DevOps", role: "Docker, SSH, services, monitoring, CI/CD, backups", skills: ["docker", "ssh", "services", "monitoring", "cicd", "backup", "network"], prompt: "DevOps specialist. Manage containers, services, deployments." },
  hardware: { name: "Hardware", role: "ESP32, Arduino, PCB, firmware, sensors, IoT", skills: ["arduino", "pcb", "mqtt"], prompt: "Hardware/embedded specialist. Design PCBs, write firmware, configure sensors." },
  coder: { name: "Coder", role: "Code analysis, git, CI/CD, project scaffolding", skills: ["git", "codeanalysis", "codegen", "packages", "cicd", "installer"], prompt: "Software engineer. Write clean code, manage repos, create pipelines." },
  researcher: { name: "Researcher", role: "Web search, docs, GitHub, information gathering", skills: ["websearch", "github", "docs", "downloads"], prompt: "Research specialist. Search, find repos, read docs. Cite URLs." },
  homelab: { name: "Homelab", role: "Home Assistant, MQTT, Zigbee, network, automation", skills: ["mqtt", "network", "ssh", "monitoring"], prompt: "Home automation specialist. HA at 172.168.1.8, MQTT user mantiz010." },
  sysadmin: { name: "SysAdmin", role: "Security, backups, databases, logs, system admin", skills: ["shell", "files", "monitoring", "backup", "database", "services", "codeanalysis"], prompt: "Sysadmin. Manage servers, security, backups, databases, logs." },
  pcbdesigner: { name: "PCB Designer", role: "Schematic design, PCB layout, BOM, Gerber export", skills: ["pcb", "files", "github"], prompt: "PCB design specialist. Create schematics, layouts, BOMs, Gerber files." },
};

const multiagent: Skill = {
  id: "builtin.multiagent",
  name: "Multi-Agent",
  description: "Kate delegates to specialists: DevOps, Hardware, Coder, Researcher, Homelab, SysAdmin, PCB Designer. Auto-spawns on demand.",
  version: "1.0.0",
  tools: [
    { name: "agent_list", description: "List available specialist agents", parameters: [] },
    { name: "agent_spawn", description: "Spawn a specialist: devops, hardware, coder, researcher, homelab, sysadmin, pcbdesigner", parameters: [
      { name: "type", type: "string", description: "Agent type", required: true },
    ]},
    { name: "agent_delegate", description: "Give a task to a specialist agent", parameters: [
      { name: "agent", type: "string", description: "Agent type", required: true },
      { name: "task", type: "string", description: "Task to do", required: true },
    ]},
    { name: "agent_team", description: "Auto-assemble a team for a project", parameters: [
      { name: "project", type: "string", description: "Project description", required: true },
    ]},
    { name: "agent_status", description: "Check all agent statuses", parameters: [] },
    { name: "agent_kill", description: "Remove an agent or 'all'", parameters: [
      { name: "agent", type: "string", description: "Agent type or 'all'", required: true },
    ]},
    { name: "agent_create_custom", description: "Create a custom specialist", parameters: [
      { name: "name", type: "string", description: "Name", required: true },
      { name: "role", type: "string", description: "Role description", required: true },
      { name: "skills", type: "string", description: "Comma-separated skills", required: true },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "agent_list": {
        const lines = ["Specialist Agents:", ""];
        for (const [key, spec] of Object.entries(SPECS)) {
          const s = agents.has(key);
          lines.push((s ? "  ● " : "  ○ ") + key.toUpperCase() + " — " + spec.name);
          lines.push("    " + spec.role);
          lines.push("    Skills: " + spec.skills.join(", "));
          if (s) lines.push("    Status: " + agents.get(key)!.status + " | Tasks: " + agents.get(key)!.taskCount);
          lines.push("");
        }
        const custom = [...agents.entries()].filter(([k]) => !SPECS[k]);
        if (custom.length) { lines.push("Custom:"); custom.forEach(([k, a]) => lines.push("  ● " + k + " — " + a.role)); }
        return lines.join("\n");
      }

      case "agent_spawn": {
        const t = (args.type as string).toLowerCase();
        const spec = SPECS[t];
        if (!spec) return "Unknown: " + t + ". Available: " + Object.keys(SPECS).join(", ");
        if (agents.has(t)) return spec.name + " already running (" + agents.get(t)!.status + ")";
        agents.set(t, { ...spec, status: "idle", taskCount: 0, created: Date.now() });
        return "Spawned: " + spec.name + "\n  Role: " + spec.role + "\n  Skills: " + spec.skills.join(", ");
      }

      case "agent_delegate": {
        const t = (args.agent as string).toLowerCase();
        const task = args.task as string;
        if (!agents.has(t) && SPECS[t]) agents.set(t, { ...SPECS[t], status: "idle", taskCount: 0, created: Date.now() });
        const a = agents.get(t);
        if (!a) return "Agent not found: " + t;
        a.status = "working"; a.lastTask = task; a.taskCount++;
        log.info(a.name + ": " + task.slice(0, 80));

        const toolMap: Record<string, string> = {
          docker: "docker_ps, docker_run, docker_stop, docker_logs, docker_build",
          ssh: "ssh_run, ssh_health, ssh_copy_to", services: "svc_list, svc_status, svc_start, svc_stop",
          monitoring: "system_info, process_list, disk_usage, resource_alert", backup: "backup_create, backup_list",
          network: "net_scan, net_portscan, net_ping, net_dns", cicd: "cicd_generate, cicd_dockerfile",
          arduino: "arduino_new, arduino_write, arduino_compile", pcb: "pcb_new_project, pcb_design_review, pcb_generate_bom",
          mqtt: "mqtt_publish, mqtt_subscribe, mqtt_z2m_devices", git: "git_status, git_commit, git_push, git_clone",
          codeanalysis: "lint, security_scan, code_stats, check_secrets", codegen: "gen_project, gen_dockerfile, gen_nginx",
          packages: "npm_install, pip_install, apt_install", installer: "install_from_github, install_analyze",
          websearch: "search, search_and_read, fetch_page", github: "gh_search_repos, gh_readme, gh_file",
          docs: "docs_read, docs_crawl", downloads: "download_file, download_git",
          shell: "run_command, run_script", files: "read_file, write_file, list_directory",
          database: "db_query, db_tables",
        };

        const tools = a.skills.map(s => toolMap[s] || s).join(", ");
        a.status = "idle";
        a.lastResult = "Task delegated to " + a.name + ".\nFocused tools: " + tools + "\n\nNow execute: " + task;
        return a.lastResult;
      }

      case "agent_team": {
        const p = (args.project as string).toLowerCase();
        const team: string[] = [];
        if (p.includes("deploy") || p.includes("docker") || p.includes("server")) team.push("devops");
        if (p.includes("esp32") || p.includes("arduino") || p.includes("sensor") || p.includes("firmware")) team.push("hardware");
        if (p.includes("code") || p.includes("build") || p.includes("git")) team.push("coder");
        if (p.includes("search") || p.includes("find") || p.includes("research")) team.push("researcher");
        if (p.includes("home") || p.includes("mqtt") || p.includes("zigbee")) team.push("homelab");
        if (p.includes("security") || p.includes("backup") || p.includes("database")) team.push("sysadmin");
        if (p.includes("pcb") || p.includes("board") || p.includes("schematic")) team.push("pcbdesigner");
        if (team.length === 0) { team.push("coder"); team.push("researcher"); }

        for (const t of team) {
          if (SPECS[t] && !agents.has(t)) agents.set(t, { ...SPECS[t], status: "idle", taskCount: 0, created: Date.now() });
        }
        return "Team for: " + args.project + "\n\n" + team.map(t => "  ● " + (SPECS[t]?.name || t) + " — " + (SPECS[t]?.role || "custom")).join("\n") + "\n\n" + team.length + " agents ready. Use agent_delegate to assign tasks.";
      }

      case "agent_status": {
        if (agents.size === 0) return "No agents. Use agent_spawn or agent_team.";
        return "Active (" + agents.size + "):\n\n" + [...agents.entries()].map(([k, a]) => {
          const up = Math.floor((Date.now() - a.created) / 60000);
          return (a.status === "idle" ? "🟢" : a.status === "working" ? "🟡" : "🔴") + " " + a.name + " [" + k + "]\n  " + a.status + " | Tasks: " + a.taskCount + " | Up: " + up + "m" + (a.lastTask ? "\n  Last: " + a.lastTask.slice(0, 60) : "");
        }).join("\n\n");
      }

      case "agent_kill": {
        const t = (args.agent as string).toLowerCase();
        if (t === "all") { const n = agents.size; agents.clear(); return "Removed " + n + " agents."; }
        if (!agents.has(t)) return "Not found: " + t;
        agents.delete(t); return "Removed: " + t;
      }

      case "agent_create_custom": {
        const n = (args.name as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const skills = (args.skills as string).split(",").map(s => s.trim());
        agents.set(n, { name: args.name as string, role: args.role as string, skills, prompt: "", status: "idle", taskCount: 0, created: Date.now() });
        return "Custom agent: " + args.name + "\n  Skills: " + skills.join(", ");
      }

      default: return "Unknown: " + toolName;
    }
  },
};

export default multiagent;
