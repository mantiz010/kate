import type { Integration, Message } from "../../core/types.js";
import { createLogger } from "../../core/logger.js";
import * as readline from "node:readline";

const log = createLogger("cli");

export class CLIIntegration implements Integration {
  name = "cli";
  private rl?: readline.Interface;
  private messageHandler?: (msg: Message) => Promise<void>;
  private agentName: string;

  constructor(agentName: string = "Kate") {
    this.agentName = agentName;
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log("");
    console.log(`  \x1b[36m\x1b[1m${this.agentName}\x1b[0m is ready. Type your message or 'exit' to quit.`);
    console.log(`  Type '/clear' to reset conversation, '/skills' to list skills.`);
    console.log("");

    this.prompt();
  }

  private prompt(): void {
    this.rl?.question(`\x1b[32m❯\x1b[0m `, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        this.prompt();
        return;
      }

      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        console.log(`\n  ${this.agentName}: Goodbye!\n`);
        process.exit(0);
      }

      if (this.messageHandler) {
        const msg: Message = {
          id: Date.now().toString(),
          role: "user",
          content: trimmed,
          timestamp: Date.now(),
          source: "cli",
          userId: "local",
        };

        try {
          process.stdout.write(`\n  \x1b[36m${this.agentName}:\x1b[0m `);
          const response = await this.messageHandler(msg);
          // Format response with wrapping
          const formatted = wordWrap(response, 80);
          console.log(formatted);
          console.log("");
        } catch (err: any) {
          console.log(`\x1b[31mError: ${err.message}\x1b[0m\n`);
        }
      }

      this.prompt();
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  async sendMessage(_userId: string, content: string): Promise<void> {
    console.log(`\n  \x1b[36m${this.agentName}:\x1b[0m ${content}\n`);
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.messageHandler = handler;
  }
}

function wordWrap(text: string, width: number): string {
  return text.split("\n").map(line => {
    if (line.length <= width) return line;
    const words = line.split(" ");
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      if (current.length + word.length + 1 > width) {
        lines.push(current);
        current = word;
      } else {
        current += (current ? " " : "") + word;
      }
    }
    if (current) lines.push(current);
    return lines.join("\n  ");
  }).join("\n");
}

