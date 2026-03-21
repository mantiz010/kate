import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const shell: Skill = {
  id: "builtin.shell",
  name: "Shell",
  description: "Execute shell commands on the host machine",
  version: "1.0.0",
  tools: [
    {
      name: "run_command",
      description: "Execute a shell command and return its output. Use for system tasks, file operations, package management, etc.",
      parameters: [
        { name: "command", type: "string", description: "The shell command to execute", required: true },
        { name: "cwd", type: "string", description: "Working directory for the command", required: false },
        { name: "timeout", type: "number", description: "Timeout in milliseconds (default: 30000)", required: false },
      ],
    },
    {
      name: "run_script",
      description: "Execute a multi-line script (bash by default)",
      parameters: [
        { name: "script", type: "string", description: "The script content to execute", required: true },
        { name: "interpreter", type: "string", description: "Script interpreter (default: /bin/bash)", required: false },
        { name: "timeout", type: "number", description: "Timeout in milliseconds (default: 60000)", required: false },
      ],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "run_command": {
        const command = args.command as string;
        const cwd = (args.cwd as string) || process.cwd();
        const timeout = (args.timeout as number) || 30000;

        ctx.log.info(`Executing: ${command}`);
        try {
          const { stdout, stderr } = await execAsync(command, { shell: "/bin/bash", cwd, timeout, maxBuffer: 1024 * 1024 * 10 });
          const output = stdout || stderr || "(no output)";
          return output.slice(0, 10000); // Cap output
        } catch (err: any) {
          return `Error (exit ${err.code}): ${err.stderr || err.message}`.slice(0, 5000);
        }
      }

      case "run_script": {
        const script = args.script as string;
        const interpreter = (args.interpreter as string) || "/bin/bash";
        const timeout = (args.timeout as number) || 60000;

        ctx.log.info(`Running script with ${interpreter}`);
        try {
          const { stdout, stderr } = await execAsync(`${interpreter} << 'KATE_EOF'\n${script}\nKATE_EOF`, {
            timeout,
            maxBuffer: 1024 * 1024 * 10,
          });
          return (stdout || stderr || "(no output)").slice(0, 10000);
        } catch (err: any) {
          return `Script error: ${err.stderr || err.message}`.slice(0, 5000);
        }
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },
};

export default shell;

