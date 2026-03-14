import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const run = async (cmd: string, timeout = 60000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 5 });
    return (stdout || stderr || "(no output)").slice(0, 10000);
  } catch (err: any) { return `Error: ${err.stderr || err.stdout || err.message}`.slice(0, 5000); }
};

const docker: Skill = {
  id: "builtin.docker",
  name: "Docker",
  description: "Build, run, manage Docker containers, images, volumes, networks, and docker-compose stacks",
  version: "1.0.0",
  tools: [
    { name: "docker_ps", description: "List running containers", parameters: [
      { name: "all", type: "boolean", description: "Include stopped containers", required: false },
    ]},
    { name: "docker_images", description: "List Docker images", parameters: [] },
    { name: "docker_run", description: "Run a new container", parameters: [
      { name: "image", type: "string", description: "Image name (e.g. nginx, redis, postgres:16)", required: true },
      { name: "name", type: "string", description: "Container name", required: false },
      { name: "ports", type: "string", description: "Port mapping (e.g. '8080:80,5432:5432')", required: false },
      { name: "env", type: "string", description: "Environment vars (e.g. 'KEY=val,DB=test')", required: false },
      { name: "volumes", type: "string", description: "Volume mounts (e.g. './data:/data')", required: false },
      { name: "detach", type: "boolean", description: "Run in background (default: true)", required: false },
    ]},
    { name: "docker_stop", description: "Stop a container", parameters: [
      { name: "container", type: "string", description: "Container name or ID", required: true },
    ]},
    { name: "docker_rm", description: "Remove a container", parameters: [
      { name: "container", type: "string", description: "Container name or ID", required: true },
      { name: "force", type: "boolean", description: "Force remove running container", required: false },
    ]},
    { name: "docker_logs", description: "View container logs", parameters: [
      { name: "container", type: "string", description: "Container name or ID", required: true },
      { name: "lines", type: "number", description: "Number of lines (default: 50)", required: false },
      { name: "follow", type: "boolean", description: "Follow/tail mode (5 seconds)", required: false },
    ]},
    { name: "docker_exec", description: "Execute a command inside a running container", parameters: [
      { name: "container", type: "string", description: "Container name or ID", required: true },
      { name: "command", type: "string", description: "Command to run", required: true },
    ]},
    { name: "docker_inspect", description: "Inspect a container's details", parameters: [
      { name: "container", type: "string", description: "Container name or ID", required: true },
    ]},
    { name: "docker_stats", description: "Show resource usage of containers", parameters: [] },
    { name: "docker_build", description: "Build an image from a Dockerfile", parameters: [
      { name: "path", type: "string", description: "Build context path", required: true },
      { name: "tag", type: "string", description: "Image tag (e.g. myapp:latest)", required: true },
    ]},
    { name: "docker_pull", description: "Pull an image from registry", parameters: [
      { name: "image", type: "string", description: "Image to pull", required: true },
    ]},
    { name: "docker_compose_up", description: "Start docker-compose stack", parameters: [
      { name: "path", type: "string", description: "Path to docker-compose.yml directory", required: true },
      { name: "detach", type: "boolean", description: "Run in background (default: true)", required: false },
    ]},
    { name: "docker_compose_down", description: "Stop docker-compose stack", parameters: [
      { name: "path", type: "string", description: "Path to docker-compose.yml directory", required: true },
      { name: "volumes", type: "boolean", description: "Also remove volumes", required: false },
    ]},
    { name: "docker_compose_ps", description: "List compose stack services", parameters: [
      { name: "path", type: "string", description: "Path to docker-compose.yml directory", required: true },
    ]},
    { name: "docker_network_ls", description: "List Docker networks", parameters: [] },
    { name: "docker_volume_ls", description: "List Docker volumes", parameters: [] },
    { name: "docker_prune", description: "Clean up unused containers, images, networks, volumes", parameters: [
      { name: "all", type: "boolean", description: "Remove all unused images, not just dangling", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "docker_ps": return run(`docker ps ${(args.all as boolean) ? "-a" : ""} --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"`);
      case "docker_images": return run('docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}"');
      case "docker_run": {
        const parts = ["docker run"];
        if (args.detach !== false) parts.push("-d");
        if (args.name) parts.push(`--name ${args.name}`);
        if (args.ports) (args.ports as string).split(",").forEach(p => parts.push(`-p ${p.trim()}`));
        if (args.env) (args.env as string).split(",").forEach(e => parts.push(`-e ${e.trim()}`));
        if (args.volumes) (args.volumes as string).split(",").forEach(v => parts.push(`-v ${v.trim()}`));
        parts.push(args.image as string);
        return run(parts.join(" "));
      }
      case "docker_stop": return run(`docker stop ${args.container}`);
      case "docker_rm": return run(`docker rm ${(args.force as boolean) ? "-f" : ""} ${args.container}`);
      case "docker_logs": {
        const n = (args.lines as number) || 50;
        if (args.follow) return run(`timeout 5 docker logs -f --tail ${n} ${args.container} 2>&1`, 8000);
        return run(`docker logs --tail ${n} ${args.container} 2>&1`);
      }
      case "docker_exec": return run(`docker exec ${args.container} ${args.command}`);
      case "docker_inspect": return run(`docker inspect ${args.container} 2>&1 | head -80`);
      case "docker_stats": return run('docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"');
      case "docker_build": return run(`docker build -t ${args.tag} ${args.path}`, 300000);
      case "docker_pull": return run(`docker pull ${args.image}`, 300000);
      case "docker_compose_up": return run(`cd ${args.path} && docker compose up ${(args.detach as boolean) !== false ? "-d" : ""} 2>&1`, 120000);
      case "docker_compose_down": return run(`cd ${args.path} && docker compose down ${(args.volumes as boolean) ? "-v" : ""} 2>&1`);
      case "docker_compose_ps": return run(`cd ${args.path} && docker compose ps 2>&1`);
      case "docker_network_ls": return run("docker network ls");
      case "docker_volume_ls": return run("docker volume ls");
      case "docker_prune": return run(`docker system prune ${(args.all as boolean) ? "-a" : ""} -f 2>&1`);
      default: return `Unknown: ${toolName}`;
    }
  },
};
export default docker;

