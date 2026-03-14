import type { Integration, Message } from "../../core/types.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("discord");

export class DiscordIntegration implements Integration {
  name = "discord";
  private token: string;
  private allowedUsers: string[];
  private client: any;
  private messageHandler?: (msg: Message) => Promise<void>;

  constructor(token: string, allowedUsers: string[] = []) {
    this.token = token;
    this.allowedUsers = allowedUsers;
  }

  async start(): Promise<void> {
    const { Client, GatewayIntentBits } = await import("discord.js");

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on("ready", () => {
      log.info(`Discord bot ready as ${this.client.user?.tag}`);
    });

    this.client.on("messageCreate", async (discordMsg: any) => {
      // Ignore bot messages
      if (discordMsg.author.bot) return;

      // Only respond to DMs or mentions
      const isMentioned = discordMsg.mentions.has(this.client.user);
      const isDM = discordMsg.channel.type === 1; // DM channel
      if (!isDM && !isMentioned) return;

      const userId = discordMsg.author.id;
      const username = discordMsg.author.username;

      // Access control
      if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(userId) && !this.allowedUsers.includes(username)) {
        log.warn(`Unauthorized user: ${username} (${userId})`);
        return;
      }

      if (!this.messageHandler) return;

      // Strip mention from message
      let content = discordMsg.content.replace(/<@!?\d+>/g, "").trim();
      if (!content) return;

      const msg: Message = {
        id: discordMsg.id,
        role: "user",
        content,
        timestamp: Date.now(),
        source: "discord",
        userId,
        metadata: { username, channelId: discordMsg.channel.id, guildId: discordMsg.guild?.id },
      };

      log.info(`Message from ${username}: ${content.slice(0, 80)}...`);

      try {
        await discordMsg.channel.sendTyping();
        const response = await this.messageHandler(msg);

        // Discord limit is 2000 chars
        if (response.length > 1900) {
          const chunks = splitMessage(response, 1900);
          for (const chunk of chunks) {
            await discordMsg.reply(chunk);
          }
        } else {
          await discordMsg.reply(response);
        }
      } catch (err: any) {
        log.error("Error handling message:", err.message);
        await discordMsg.reply("Sorry, I encountered an error.");
      }
    });

    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      log.info("Discord bot stopped");
    }
  }

  async sendMessage(userId: string, content: string): Promise<void> {
    if (!this.client) return;
    try {
      const user = await this.client.users.fetch(userId);
      const dm = await user.createDM();
      await dm.send(content);
    } catch (err: any) {
      log.error(`Failed to send DM to ${userId}:`, err.message);
    }
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
    let splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx === -1 || splitIdx < maxLength / 2) splitIdx = maxLength;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

