import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const run = async (cmd: string, timeout = 120000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 5 });
    return (stdout || stderr || "(no output)").slice(0, 10000);
  } catch (err: any) {
    return `Error: ${err.stderr || err.stdout || err.message}`.slice(0, 5000);
  }
};

const pkgManager: Skill = {
  id: "builtin.packages",
  name: "Package Manager",
  description: "Manage npm, pip, and apt packages — install, remove, update, search, list",
  version: "1.0.0",
  tools: [
    { name: "npm_install", description: "Install npm packages", parameters: [
      { name: "packages", type: "string", description: "Space-separated package names (or empty for npm install)", required: false },
      { name: "dev", type: "boolean", description: "Install as devDependency", required: false },
      { name: "global", type: "boolean", description: "Install globally", required: false },
      { name: "path", type: "string", description: "Project path", required: false },
    ]},
    { name: "npm_remove", description: "Remove npm packages", parameters: [
      { name: "packages", type: "string", description: "Space-separated package names", required: true },
      { name: "path", type: "string", description: "Project path", required: false },
    ]},
    { name: "npm_update", description: "Update npm packages", parameters: [
      { name: "path", type: "string", description: "Project path", required: false },
    ]},
    { name: "npm_search", description: "Search npm registry for packages", parameters: [
      { name: "query", type: "string", description: "Search query", required: true },
    ]},
    { name: "npm_list", description: "List installed npm packages", parameters: [
      { name: "path", type: "string", description: "Project path", required: false },
      { name: "global", type: "boolean", description: "List global packages", required: false },
    ]},
    { name: "npm_init", description: "Initialize a new npm project", parameters: [
      { name: "path", type: "string", description: "Project path", required: true },
      { name: "name", type: "string", description: "Package name", required: false },
    ]},
    { name: "pip_install", description: "Install Python packages via pip", parameters: [
      { name: "packages", type: "string", description: "Space-separated package names", required: true },
    ]},
    { name: "pip_remove", description: "Remove Python packages", parameters: [
      { name: "packages", type: "string", description: "Space-separated package names", required: true },
    ]},
    { name: "pip_list", description: "List installed Python packages", parameters: [
      { name: "outdated", type: "boolean", description: "Show only outdated", required: false },
    ]},
    { name: "pip_freeze", description: "Generate requirements.txt from installed packages", parameters: [
      { name: "path", type: "string", description: "Output path for requirements.txt", required: false },
    ]},
    { name: "apt_install", description: "Install system packages via apt (requires sudo)", parameters: [
      { name: "packages", type: "string", description: "Space-separated package names", required: true },
    ]},
    { name: "apt_remove", description: "Remove system packages", parameters: [
      { name: "packages", type: "string", description: "Space-separated package names", required: true },
    ]},
    { name: "apt_search", description: "Search for system packages", parameters: [
      { name: "query", type: "string", description: "Search query", required: true },
    ]},
    { name: "apt_update", description: "Update apt package list and upgrade all", parameters: [
      { name: "upgrade", type: "boolean", description: "Also upgrade packages", required: false },
    ]},
    { name: "apt_list_installed", description: "List installed system packages", parameters: [
      { name: "filter", type: "string", description: "Filter by name", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const cwd = (args.path as string) || process.cwd();

    switch (toolName) {
      case "npm_install": {
        const pkgs = (args.packages as string) || "";
        const dev = (args.dev as boolean) ? "--save-dev" : "";
        const global = (args.global as boolean) ? "-g" : "";
        return run(`npm install ${global} ${dev} ${pkgs}`.trim(), 180000);
      }
      case "npm_remove": return run(`npm uninstall ${args.packages}`);
      case "npm_update": return run("npm update", 120000);
      case "npm_search": return run(`npm search ${args.query} --long 2>&1 | head -20`);
      case "npm_list": {
        const g = (args.global as boolean) ? "-g" : "";
        return run(`npm list ${g} --depth=0`);
      }
      case "npm_init": return run(`cd ${cwd} && npm init -y`);
      case "pip_install": return run(`pip install ${args.packages} --break-system-packages 2>&1`);
      case "pip_remove": return run(`pip uninstall -y ${args.packages} --break-system-packages 2>&1`);
      case "pip_list": {
        return (args.outdated as boolean) ? run("pip list --outdated") : run("pip list");
      }
      case "pip_freeze": {
        const out = (args.path as string) || "";
        return out ? run(`pip freeze > ${out} && echo "Saved to ${out}"`) : run("pip freeze");
      }
      case "apt_install": return run(`sudo apt install -y ${args.packages} 2>&1`, 300000);
      case "apt_remove": return run(`sudo apt remove -y ${args.packages} 2>&1`);
      case "apt_search": return run(`apt search ${args.query} 2>&1 | head -30`);
      case "apt_update": {
        const upgrade = (args.upgrade as boolean) ? "&& sudo apt upgrade -y" : "";
        return run(`sudo apt update ${upgrade} 2>&1`, 300000);
      }
      case "apt_list_installed": {
        const filter = (args.filter as string) || "";
        return filter ? run(`dpkg -l | grep -i ${filter} | head -30`) : run("dpkg -l | tail -30");
      }
      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export default pkgManager;

