#!/usr/bin/env node

import { Command } from "commander";
import { Kate } from "./app.js";
import { loadConfig, saveConfig, saveEnv, CONFIG_DIR } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { OllamaProvider } from "./providers/ollama.js";
import * as readline from "node:readline";

const log = createLogger("cli");

const program = new Command();

program
  .name("kate")
  .description("Kate — Personal AI Agent (local-first)")
  .version("0.1.0");

// ── Main: start the assistant ──────────────────────────────────
program
  .command("start", { isDefault: true })
  .description("Start Kate in interactive CLI mode")
  .option("-d, --daemon", "Run in daemon mode (Telegram/Discord only, no CLI)")
  .option("-a, --all", "Run CLI + all integrations")
  .option("-m, --model <model>", "Override the model for this session")
  .action(async (opts) => {
    printBanner();
    const app = new Kate();
    try {
      const overrides: any = {};
      if (opts.model) {
        overrides.provider = { ollama: { model: opts.model } };
      }
      await app.init(Object.keys(overrides).length > 0 ? overrides : undefined);
      const mode = opts.daemon ? "daemon" : opts.all ? "all" : "cli";
      await app.start(mode);
    } catch (err: any) {
      if (err.message.includes("No AI providers")) {
        console.log("\n  \x1b[33mNo provider configured. Run:\x1b[0m\n");
        console.log("    kate onboard\n");
      } else {
        log.error("Failed to start:", err.message);
      }
      process.exit(1);
    }
  });

// ── Onboard: first-time setup ──────────────────────────────────
program
  .command("onboard")
  .description("Set up Kate for the first time")
  .action(async () => {
    printBanner();
    console.log("  Welcome! Let's get you set up.\n");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(`  ${q}`, resolve));

    // Agent name
    const name = (await ask("What should your assistant be called? [Kate]: ")).trim() || "Kate";

    // Provider — Ollama first
    console.log("\n  Which AI provider? (Ollama = fully local, no API keys needed)\n");
    console.log("    1. \x1b[36mOllama (local)\x1b[0m — recommended, private, free");
    console.log("    2. Anthropic (Claude) — cloud, needs API key");
    console.log("    3. OpenAI (GPT) — cloud, needs API key");
    console.log("    4. Ollama + cloud fallback\n");
    const providerChoice = (await ask("Choice [1]: ")).trim() || "1";

    const envVars: Record<string, string> = {};
    let defaultProvider = "ollama";
    let ollamaModel = "llama3.1";
    let ollamaUrl = "http://localhost:11434";

    if (providerChoice === "1" || providerChoice === "4") {
      const customUrl = (await ask(`\n  Ollama URL [${ollamaUrl}]: `)).trim();
      if (customUrl) ollamaUrl = customUrl;

      // Check if Ollama is running
      console.log("\n  Checking Ollama connection...");
      const ollama = new OllamaProvider(ollamaUrl);
      const available = await ollama.isAvailable();

      if (available) {
        console.log("  \x1b[32m✓\x1b[0m Ollama is running!");
        const models = await ollama.refreshModels();

        if (models.length > 0) {
          console.log(`\n  Installed models: ${models.join(", ")}`);
          const chosen = (await ask(`\n  Which model? [${models[0]}]: `)).trim();
          ollamaModel = chosen || models[0];
        } else {
          console.log("\n  No models installed. Let's pull one.\n");
          console.log("  Recommended models for tool use:");
          console.log("    • \x1b[36mllama3.1\x1b[0m      — 8B, great all-rounder (4.7 GB)");
          console.log("    • \x1b[36mllama3.1:70b\x1b[0m  — 70B, very capable (40 GB)");
          console.log("    • \x1b[36mmistral\x1b[0m       — 7B, fast and solid (4.1 GB)");
          console.log("    • \x1b[36mqwen2.5\x1b[0m       — 7B, good tool calling (4.7 GB)");
          console.log("    • \x1b[36mcommand-r\x1b[0m     — 35B, excellent tool use (20 GB)");
          console.log("    • \x1b[36mdeepseek-r1\x1b[0m   — reasoning focused (4.7 GB)\n");

          const modelChoice = (await ask("  Model to pull [llama3.1]: ")).trim() || "llama3.1";
          ollamaModel = modelChoice;

          console.log(`\n  Pulling ${modelChoice}... (this may take a few minutes)\n`);
          const success = await ollama.pullModel(modelChoice, (status) => {
            process.stdout.write(`\r  ${status}                    `);
          });
          console.log("");

          if (success) {
            console.log(`  \x1b[32m✓\x1b[0m Model ${modelChoice} ready!`);
          } else {
            console.log(`  \x1b[31m✗\x1b[0m Failed to pull model. You can do it manually: ollama pull ${modelChoice}`);
          }
        }
      } else {
        console.log("  \x1b[31m✗\x1b[0m Ollama is not running.\n");
        console.log("  Install Ollama: https://ollama.com/download");
        console.log("  Then run: ollama serve\n");

        const cont = (await ask("  Continue setup anyway? (Y/n): ")).trim().toLowerCase();
        if (cont === "n") {
          rl.close();
          process.exit(0);
        }
      }
    }

    if (providerChoice === "2" || providerChoice === "4") {
      const key = (await ask("\n  Anthropic API key: ")).trim();
      if (key) envVars.ANTHROPIC_API_KEY = key;
      if (providerChoice === "2") defaultProvider = "anthropic";
    }

    if (providerChoice === "3") {
      const key = (await ask("\n  OpenAI API key: ")).trim();
      if (key) envVars.OPENAI_API_KEY = key;
      defaultProvider = "openai";
    }

    // Integrations
    console.log("\n  Chat integrations (optional, you can add these later):");
    const setupTelegram = (await ask("  Set up Telegram? (y/N): ")).trim().toLowerCase() === "y";
    if (setupTelegram) {
      const token = (await ask("  Telegram bot token (from @BotFather): ")).trim();
      if (token) envVars.TELEGRAM_BOT_TOKEN = token;
    }

    const setupDiscord = (await ask("  Set up Discord? (y/N): ")).trim().toLowerCase() === "y";
    if (setupDiscord) {
      const token = (await ask("  Discord bot token: ")).trim();
      if (token) envVars.DISCORD_BOT_TOKEN = token;
    }

    // Save config
    await saveConfig({
      agent: {
        name,
        personality: `You are ${name}, a professional and proactive personal AI assistant. You are helpful, efficient, and adapt to the user's style.`,
      },
      provider: {
        default: defaultProvider as any,
        ollama: {
          baseUrl: ollamaUrl,
          model: ollamaModel,
        },
      } as any,
    });

    if (Object.keys(envVars).length > 0) {
      await saveEnv(envVars);
    }

    console.log(`\n  \x1b[32m✓\x1b[0m Setup complete! Config saved to ${CONFIG_DIR}`);
    console.log(`\n  Start your assistant:\n`);
    console.log(`    \x1b[36mkate\x1b[0m                        # Start chatting`);
    console.log(`    \x1b[36mkate --model mistral\x1b[0m         # Use a different model`);
    console.log(`    \x1b[36mkate start --all\x1b[0m             # CLI + Telegram/Discord`);
    console.log(`    \x1b[36mkate models\x1b[0m                  # Manage Ollama models\n`);

    rl.close();
    process.exit(0);
  });

// ── Models: manage Ollama models ───────────────────────────────
program
  .command("models")
  .description("List, pull, and manage Ollama models")
  .action(async () => {
    const config = await loadConfig();
    const ollama = new OllamaProvider(config.provider.ollama.baseUrl);
    const available = await ollama.isAvailable();

    if (!available) {
      console.log("\n  \x1b[31mOllama is not running.\x1b[0m");
      console.log("  Start it with: ollama serve\n");
      process.exit(1);
    }

    const models = await ollama.refreshModels();
    const current = config.provider.ollama.model;

    console.log("\n  Installed Ollama models:\n");
    if (models.length === 0) {
      console.log("  (none)\n");
    } else {
      for (const m of models) {
        const marker = m === current ? " \x1b[36m← active\x1b[0m" : "";
        console.log(`    • ${m}${marker}`);
      }
      console.log("");
    }

    console.log("  Commands:");
    console.log("    \x1b[36mkate pull <model>\x1b[0m      Pull a new model");
    console.log("    \x1b[36mkate use <model>\x1b[0m       Set the default model");
    console.log("");
  });

// ── Pull: download an Ollama model ─────────────────────────────
program
  .command("pull <model>")
  .description("Pull/download an Ollama model")
  .action(async (model: string) => {
    const config = await loadConfig();
    const ollama = new OllamaProvider(config.provider.ollama.baseUrl);

    const available = await ollama.isAvailable();
    if (!available) {
      console.log("\n  \x1b[31mOllama is not running.\x1b[0m Start it with: ollama serve\n");
      process.exit(1);
    }

    console.log(`\n  Pulling ${model}...\n`);
    const success = await ollama.pullModel(model, (status) => {
      process.stdout.write(`\r  ${status}                              `);
    });
    console.log("");

    if (success) {
      console.log(`\n  \x1b[32m✓\x1b[0m ${model} is ready!`);
      console.log(`  Use it: \x1b[36mkate --model ${model}\x1b[0m`);
      console.log(`  Set as default: \x1b[36mkate use ${model}\x1b[0m\n`);
    } else {
      console.log(`\n  \x1b[31m✗\x1b[0m Failed to pull ${model}\n`);
    }
  });

// ── Use: set default model ─────────────────────────────────────
program
  .command("use <model>")
  .description("Set the default Ollama model")
  .action(async (model: string) => {
    const config = await loadConfig();
    config.provider.ollama.model = model;
    await saveConfig(config);
    console.log(`\n  \x1b[32m✓\x1b[0m Default model set to: ${model}\n`);
  });

// ── Config: show current config ────────────────────────────────
program
  .command("config")
  .description("Show current configuration")
  .action(async () => {
    const config = await loadConfig();
    const ollama = new OllamaProvider(config.provider.ollama.baseUrl);
    const ollamaUp = await ollama.isAvailable();

    console.log("\n  Kate Configuration\n");
    console.log(`  Agent name:     ${config.agent.name}`);
    console.log(`  Default provider: ${config.provider.default}`);
    console.log("");
    console.log(`  Ollama:         ${ollamaUp ? "\x1b[32m● running\x1b[0m" : "\x1b[31m● offline\x1b[0m"} (${config.provider.ollama.baseUrl})`);
    console.log(`  Ollama model:   ${config.provider.ollama.model}`);
    console.log(`  Anthropic key:  ${config.provider.anthropic.apiKey ? "\x1b[32m✓ set\x1b[0m" : "✗ not set"}`);
    console.log(`  OpenAI key:     ${config.provider.openai.apiKey ? "\x1b[32m✓ set\x1b[0m" : "✗ not set"}`);
    console.log("");
    console.log(`  Telegram:       ${config.integrations.telegram.enabled ? "\x1b[32m✓ enabled\x1b[0m" : "✗ disabled"}`);
    console.log(`  Discord:        ${config.integrations.discord.enabled ? "\x1b[32m✓ enabled\x1b[0m" : "✗ disabled"}`);
    console.log("");
    console.log(`  Memory DB:      ${config.memory.dbPath}`);
    console.log(`  Skills dir:     ${config.skills.directory}`);
    console.log(`  Config dir:     ${CONFIG_DIR}\n`);
  });

// ── Skills: list skills ────────────────────────────────────────
program
  .command("skills")
  .description("List available skills and tools")
  .action(async () => {
    const { SkillManager } = await import("./skills/manager.js");
    const config = await loadConfig();
    const skills = new SkillManager();
    await skills.loadBuiltin(config.skills.builtin);
    await skills.loadFromDirectory(config.skills.directory);

    console.log("\n  Loaded skills:\n");
    for (const skill of skills.list()) {
      console.log(`  \x1b[36m${skill.name}\x1b[0m v${skill.version} — ${skill.description}`);
      for (const tool of skill.tools) {
        console.log(`    • ${tool.name}: ${tool.description}`);
      }
      console.log("");
    }
  });

// ── Web: start the web UI ──────────────────────────────────────
program
  .command("web")
  .description("Start the web UI dashboard")
  .option("-p, --port <port>", "Port number", "3201")
  .action(async (opts) => {
    printBanner();
    console.log("  Starting web server...\n");
    try {
      const { startWebServer } = await import("./web/server.js");
      await startWebServer(parseInt(opts.port));
    } catch (err: any) {
      log.error("Failed to start web server:", err.message);
      if (err.message.includes("ws")) {
        console.log("\n  Missing dependency. Run: npm install ws\n");
      }
      process.exit(1);
    }
  });

function printBanner(): void {
  console.log("");
  console.log("  \x1b[36m\x1b[1m╔═══════════════════════════════════╗\x1b[0m");
  console.log("  \x1b[36m\x1b[1m║          K A T E                ║\x1b[0m");
  console.log("  \x1b[36m\x1b[1m║   Personal AI Agent v0.3      ║\x1b[0m");
  console.log("  \x1b[36m\x1b[1m║   Local-first · Private · Yours   ║\x1b[0m");
  console.log("  \x1b[36m\x1b[1m╚═══════════════════════════════════╝\x1b[0m");
  console.log("");
}

program.parse();

