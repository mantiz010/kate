import type { Skill, ToolDefinition, SkillContext, KateConfig, Logger } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import fs from "node:fs";
import path from "node:path";

const log = createLogger("skills");

export class SkillManager {
  private skills = new Map<string, Skill>();
  private toolToSkill = new Map<string, string>();

  async loadBuiltin(names: string[]): Promise<void> {
    for (const name of names) {
      try {
        let skill: Skill;
        switch (name) {
          case "shell":
            skill = (await import("../skills/shell.js")).default;
            break;
          case "files":
            skill = (await import("../skills/files.js")).default;
            break;
          case "memory":
            skill = (await import("../skills/memory-skill.js")).default;
            break;
          case "web":
            skill = (await import("../skills/web.js")).default;
            break;
          case "browser":
            skill = (await import("../skills/browser.js")).default;
            break;
          case "scheduler":
            skill = (await import("../skills/scheduler.js")).default;
            break;
          case "pcb":
            skill = (await import("../skills/pcb.js")).default;
            break;
          case "arduino":
            skill = (await import("../skills/arduino.js")).default;
            break;
          case "workers":
            skill = (await import("../skills/workers.js")).default;
            break;
          case "skillforge":
            skill = (await import("../skills/skillforge.js")).default;
            break;
          case "router":
            skill = (await import("../skills/router.js")).default;
            break;
          case "git":
            skill = (await import("../skills/git.js")).default;
            break;
          case "templates":
            skill = (await import("../skills/templates.js")).default;
            break;
          case "codeanalysis":
            skill = (await import("../skills/codeanalysis.js")).default;
            break;
          case "packages":
            skill = (await import("../skills/packages.js")).default;
            break;
          case "monitoring":
            skill = (await import("../skills/monitoring.js")).default;
            break;
          case "apibuilder":
            skill = (await import("../skills/apibuilder.js")).default;
            break;
          case "cicd":
            skill = (await import("../skills/cicd.js")).default;
            break;
          case "autohealer":
            skill = (await import("../skills/autohealer.js")).default;
            break;
          case "agentcomm":
            skill = (await import("../skills/agentcomm.js")).default;
            break;
          case "websearch":
            skill = (await import("../skills/websearch.js")).default;
            break;
          case "github":
            skill = (await import("../skills/github.js")).default;
            break;
          case "docs":
            skill = (await import("../skills/docs.js")).default;
            break;
          case "downloads":
            skill = (await import("../skills/downloads.js")).default;
            break;
          case "apitester":
            skill = (await import("../skills/apitester.js")).default;
            break;
          case "docker":
            skill = (await import("../skills/docker.js")).default;
            break;
          case "ssh":
            skill = (await import("../skills/ssh.js")).default;
            break;
          case "database":
            skill = (await import("../skills/database.js")).default;
            break;
          case "network":
            skill = (await import("../skills/network.js")).default;
            break;
          case "backup":
            skill = (await import("../skills/backup.js")).default;
            break;
          case "mqtt":
            skill = (await import("../skills/mqtt.js")).default;
            break;
          case "services":
            skill = (await import("../skills/services.js")).default;
            break;
          case "codegen":
            skill = (await import("../skills/codegen.js")).default;
            break;
          case "installer":
            skill = (await import("../skills/installer.js")).default;
            break;
          case "multiagent":
            skill = (await import("../skills/multiagent.js")).default;
            break;
          case "partpicker":
            skill = (await import("../skills/partpicker.js")).default;
            break;
          case "selfimprove":
            skill = (await import("../skills/selfimprove.js")).default;
            break;
          case "etbus":
            skill = (await import("../skills/etbus.js")).default;
            break;
            break;
          case "proxmox":
            skill = (await import("../skills/proxmox.js")).default;
            break;
          case "events":
            skill = (await import("../skills/events.js")).default;
            break;
          case "evolution":
            skill = (await import("../skills/evolution.js")).default;
            break;
          case "heartbeat":
            skill = (await import("../skills/heartbeat.js")).default;
            break;
          case "webhooks":
            skill = (await import("../skills/webhooks.js")).default;
            break;
          case "history":
            skill = (await import("../skills/history.js")).default;
            break;
          case "marketplace":
            skill = (await import("../skills/marketplace.js")).default;
            break;

          default:
            log.warn(`Unknown builtin skill: ${name}`);
            continue;
        }
        this.register(skill);
      } catch (err: any) {
        log.error(`Failed to load builtin skill '${name}':`, err.message);
      }
    }
  }

  async loadFromDirectory(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(dir, entry.name, "index.js");
      if (!fs.existsSync(skillPath)) continue;

      try {
        const mod = await import(skillPath);
        const skill: Skill = mod.default || mod;
        this.register(skill);
        log.info(`Loaded custom skill: ${skill.name}`);
      } catch (err: any) {
        log.error(`Failed to load skill from ${entry.name}:`, err.message);
      }
    }
  }

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
    for (const tool of skill.tools) {
      this.toolToSkill.set(tool.name, skill.id);
    }
    log.info(`Registered skill: ${skill.name} (${skill.tools.length} tools)`);
  }

  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const skill of this.skills.values()) {
      tools.push(...skill.tools);
    }
    return tools;
  }

  /** Returns a map of skillId → tools for smart filtering */
  getSkillToolMap(): Map<string, ToolDefinition[]> {
    const map = new Map<string, ToolDefinition[]>();
    for (const [id, skill] of this.skills) {
      map.set(id, [...skill.tools]);
    }
    return map;
  }

  /** Get the skillId that owns a tool */
  getToolSkillId(toolName: string): string | undefined {
    return this.toolToSkill.get(toolName);
  }

  async executeTool(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const skillId = this.toolToSkill.get(toolName);
    if (!skillId) throw new Error(`No skill registered for tool: ${toolName}`);

    const skill = this.skills.get(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);

    return skill.execute(toolName, args, ctx);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }
}

