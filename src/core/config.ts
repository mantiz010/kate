import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { KateConfigSchema, type KateConfig } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("config");

const CONFIG_DIR = path.join(os.homedir(), ".kate");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml");
const ENV_FILE = path.join(CONFIG_DIR, ".env");

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    log.info(`Created config directory: ${CONFIG_DIR}`);
  }
}

export function resolveHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

export async function loadConfig(): Promise<KateConfig> {
  ensureConfigDir();

  // Load .env if it exists
  if (fs.existsSync(ENV_FILE)) {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  }

  let rawConfig: Record<string, unknown> = {};

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const { parse } = await import("yaml");
      const content = fs.readFileSync(CONFIG_FILE, "utf-8");
      rawConfig = parse(content) || {};
      log.info("Loaded config from", CONFIG_FILE);
    } catch (err) {
      log.warn("Failed to parse config file, using defaults");
    }
  }

  // Override with environment variables
  const envOverrides: Record<string, unknown> = {};
  if (process.env.ANTHROPIC_API_KEY) {
    (envOverrides as any).provider = {
      ...(rawConfig.provider as any),
      anthropic: {
        ...((rawConfig.provider as any)?.anthropic),
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    };
  }
  if (process.env.OPENAI_API_KEY) {
    (envOverrides as any).provider = {
      ...(envOverrides as any)?.provider || (rawConfig.provider as any),
      openai: {
        ...((rawConfig.provider as any)?.openai),
        apiKey: process.env.OPENAI_API_KEY,
      },
    };
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    (envOverrides as any).integrations = {
      ...(rawConfig.integrations as any),
      telegram: {
        ...((rawConfig.integrations as any)?.telegram),
        enabled: true,
        token: process.env.TELEGRAM_BOT_TOKEN,
      },
    };
  }
  if (process.env.DISCORD_BOT_TOKEN) {
    (envOverrides as any).integrations = {
      ...(envOverrides as any)?.integrations || (rawConfig.integrations as any),
      discord: {
        ...((rawConfig.integrations as any)?.discord),
        enabled: true,
        token: process.env.DISCORD_BOT_TOKEN,
      },
    };
  }

  const merged = { ...rawConfig, ...envOverrides };
  const config = KateConfigSchema.parse(merged);

  // Resolve home paths
  config.memory.dbPath = resolveHome(config.memory.dbPath);
  config.skills.directory = resolveHome(config.skills.directory);

  return config;
}

export async function saveConfig(config: Partial<KateConfig>): Promise<void> {
  ensureConfigDir();
  const { stringify } = await import("yaml");
  fs.writeFileSync(CONFIG_FILE, stringify(config), "utf-8");
  log.info("Config saved to", CONFIG_FILE);
}

export async function saveEnv(vars: Record<string, string>): Promise<void> {
  ensureConfigDir();
  let content = "";
  if (fs.existsSync(ENV_FILE)) {
    content = fs.readFileSync(ENV_FILE, "utf-8");
  }
  for (const [key, val] of Object.entries(vars)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `${content.endsWith("\n") || content === "" ? "" : "\n"}${key}=${val}\n`;
    }
  }
  fs.writeFileSync(ENV_FILE, content, "utf-8");
}

export { CONFIG_DIR, CONFIG_FILE, ENV_FILE };

