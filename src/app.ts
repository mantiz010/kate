import type { KateConfig, Integration, Message } from "./core/types.js";
import { loadConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { Agent } from "./core/agent.js";
import { ProviderRegistry } from "./providers/registry.js";
import { SkillManager } from "./skills/manager.js";
import { SQLiteMemory, InMemoryStore } from "./memory/store.js";
import { CLIIntegration } from "./integrations/cli/index.js";

const log = createLogger("kate");

export class Kate {
  private config!: KateConfig;
  private agent!: Agent;
  private integrations: Integration[] = [];
  private running = false;

  async init(configOverrides?: Partial<KateConfig>): Promise<void> {
    log.info("Initializing Kate...");

    // Load config
    this.config = await loadConfig();
    if (configOverrides) {
      Object.assign(this.config, configOverrides);
    }

    // Initialize memory
    let memory;
    try {
      memory = new SQLiteMemory(this.config.memory.dbPath);
    } catch {
      log.warn("SQLite unavailable, using in-memory store");
      memory = new InMemoryStore();
    }

    // Initialize providers
    const providers = new ProviderRegistry(this.config);

    // Check if Ollama is available when it's the default
    if (this.config.provider.default === "ollama") {
      const ollama = providers.getOllama();
      if (ollama) {
        const available = await ollama.isAvailable();
        if (!available) {
          log.warn("Ollama is not running. Start it with: ollama serve");
          log.warn("Or switch provider: set ANTHROPIC_API_KEY or OPENAI_API_KEY");
        }
      }
    }

    // Initialize skills
    const skills = new SkillManager();
    await skills.loadBuiltin(this.config.skills.builtin);
    await skills.loadFromDirectory(this.config.skills.directory);

    // Create agent
    this.agent = new Agent(this.config, providers, skills, memory);

    // Give router skill access to the actual router instance
    try {
      const { setRouterInstance } = await import("./skills/router.js");
      setRouterInstance(providers.getRouter());
    } catch {}

    // Start self-evolution engine (learns from errors, auto-fixes)
    try {
      const { evolution } = await import("./core/evolution.js");
      evolution.start();
      log.info("Self-evolution: active");
    } catch (err: any) {
      log.warn(`Evolution init: ${err.message}`);
    }

    // Start heartbeat (proactive health monitoring)
    try {
      const { heartbeat } = await import("./core/heartbeat.js");
      heartbeat.start(this.agent);
      log.info("Heartbeat: active (60s interval)");
    } catch (err: any) {
      log.warn(`Heartbeat init: ${err.message}`);
    }

    log.info(`Agent "${this.config.agent.name}" initialized`);
    log.info(`Provider: ${this.config.provider.default}`);
    log.info(`Skills: ${skills.list().map(s => s.name).join(", ")}`);
  }

  async start(mode: "cli" | "daemon" | "all" = "cli"): Promise<void> {
    this.running = true;

    const messageHandler = async (msg: Message): Promise<string> => {
      // Handle built-in commands
      if (msg.content.startsWith("/")) {
        return this.handleCommand(msg);
      }
      return this.agent.handleMessage(msg);
    };

    // Start CLI if requested
    if (mode === "cli" || mode === "all") {
      const cli = new CLIIntegration(this.config.agent.name);
      cli.onMessage(async (msg) => {
        const response = await messageHandler(msg);
        return response;
      });
      this.integrations.push(cli);
      await cli.start();
    }

    // Start Telegram if configured
    if ((mode === "daemon" || mode === "all") && this.config.integrations.telegram.enabled) {
      try {
        const { TelegramIntegration } = await import("./integrations/telegram/index.js");
        const telegram = new TelegramIntegration(
          this.config.integrations.telegram.token!,
          this.config.integrations.telegram.allowedUsers,
        );
        telegram.onMessage(async (msg) => {
          const response = await messageHandler(msg);
          return response;
        });
        this.integrations.push(telegram);
        await telegram.start();
        log.info("Telegram integration started");
      } catch (err: any) {
        log.error("Failed to start Telegram:", err.message);
      }
    }

    // Start Discord if configured
    if ((mode === "daemon" || mode === "all") && this.config.integrations.discord.enabled) {
      try {
        const { DiscordIntegration } = await import("./integrations/discord/index.js");
        const discord = new DiscordIntegration(
          this.config.integrations.discord.token!,
          this.config.integrations.discord.allowedUsers,
        );
        discord.onMessage(async (msg) => {
          const response = await messageHandler(msg);
          return response;
        });
        this.integrations.push(discord);
        await discord.start();
        log.info("Discord integration started");
      } catch (err: any) {
        log.error("Failed to start Discord:", err.message);
      }
    }

    // Graceful shutdown
    const shutdown = async () => {
      log.info("Shutting down...");
      this.running = false;
      for (const integration of this.integrations) {
        await integration.stop();
      }
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  private handleCommand(msg: Message): string {
    const [cmd, ...args] = msg.content.slice(1).split(" ");

    switch (cmd.toLowerCase()) {
      case "clear":
        this.agent.clearConversation(msg.userId, msg.source);
        return "Conversation cleared.";

      case "skills":
        // Will be populated from skill manager
        return "Use /help for available commands.";

      case "help":
        return [
          "Available commands:",
          "  /clear    — Reset conversation history",
          "  /skills   — List loaded skills",
          "  /help     — Show this help",
          "",
          "Everything else is sent to the AI agent.",
        ].join("\n");

      default:
        return `Unknown command: /${cmd}. Type /help for options.`;
    }
  }
}

