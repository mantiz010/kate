import type { Integration, Message } from "../../core/types.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("telegram");

export class TelegramIntegration implements Integration {
  name = "telegram";
  private token: string;
  private allowedUsers: string[];
  private bot: any;
  private messageHandler?: (msg: Message) => Promise<void>;

  constructor(token: string, allowedUsers: string[] = []) {
    this.token = token;
    this.allowedUsers = allowedUsers;
  }

  async start(): Promise<void> {
    const { Telegraf } = await import("telegraf");
    this.bot = new Telegraf(this.token);

    this.bot.on("text", async (ctx: any) => {
      const userId = ctx.from.id.toString();
      const username = ctx.from.username || ctx.from.first_name || userId;

      // Access control
      if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(userId) && !this.allowedUsers.includes(username)) {
        log.warn(`Unauthorized user: ${username} (${userId})`);
        await ctx.reply("Sorry, I'm not configured to talk to you yet.");
        return;
      }

      if (!this.messageHandler) return;

      const msg: Message = {
        id: ctx.message.message_id.toString(),
        role: "user",
        content: ctx.message.text,
        timestamp: Date.now(),
        source: "telegram",
        userId,
        metadata: { username, chatId: ctx.chat.id },
      };

      log.info(`Message from ${username}: ${msg.content.slice(0, 80)}...`);

      try {
        // Show typing indicator
        await ctx.sendChatAction("typing");
        const response = await this.messageHandler(msg);
        
        // Split long messages (Telegram limit is 4096 chars)
        if (response.length > 4000) {
          const chunks = splitMessage(response, 4000);
          for (const chunk of chunks) {
            await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() =>
              ctx.reply(chunk) // Fallback without markdown
            );
          }
        } else {
          await ctx.reply(response, { parse_mode: "Markdown" }).catch(() =>
            ctx.reply(response)
          );
        }
      } catch (err: any) {
        log.error("Error handling message:", err.message);
        await ctx.reply("Sorry, I encountered an error processing your message.");
      }
    });

    await this.bot.launch();
    log.info("Telegram bot started");
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop("SIGINT");
      log.info("Telegram bot stopped");
    }
  }

  async sendMessage(userId: string, content: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.telegram.sendMessage(userId, content, { parse_mode: "Markdown" }).catch(() =>
      this.bot.telegram.sendMessage(userId, content)
    );
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.messageHandler = handler;
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx === -1 || splitIdx < maxLength / 2) splitIdx = maxLength;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

