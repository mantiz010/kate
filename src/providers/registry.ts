import type { Provider, KateConfig } from "../core/types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { SmartRouter } from "./router.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("providers");

export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private defaultProvider: string;
  private router: SmartRouter;

  constructor(config: KateConfig) {
    this.defaultProvider = config.provider.default;

    // Ollama (local)
    const ollama = new OllamaProvider(
      config.provider.ollama.baseUrl,
      config.provider.ollama.model,
    );
    this.providers.set("ollama", ollama);
    log.info(`Registered provider: Ollama (${config.provider.ollama.baseUrl}, model: ${config.provider.ollama.model})`);

    // Smart Router — wraps Ollama with multi-model routing
    this.router = new SmartRouter(config);
    this.providers.set("router", this.router);
    log.info("Registered provider: Smart Router (multi-model)");

    // Anthropic (cloud)
    if (config.provider.anthropic.apiKey) {
      this.providers.set("anthropic", new AnthropicProvider(
        config.provider.anthropic.apiKey,
        config.provider.anthropic.model,
      ));
      log.info("Registered provider: Anthropic");
    }

    // OpenAI (cloud)
    if (config.provider.openai.apiKey) {
      this.providers.set("openai", new OpenAIProvider(
        config.provider.openai.apiKey,
        config.provider.openai.model,
      ));
      log.info("Registered provider: OpenAI");
    }
  }

  get(name?: string): Provider {
    const key = name || this.defaultProvider;
    const provider = this.providers.get(key);
    if (!provider) {
      const available = [...this.providers.keys()];
      if (available.length === 0) {
        throw new Error("No AI providers configured. Run: kate onboard");
      }
      log.warn(`Provider '${key}' not available, falling back to '${available[0]}'`);
      return this.providers.get(available[0])!;
    }
    return provider;
  }

  getOllama(): OllamaProvider | null {
    const p = this.providers.get("ollama");
    return p instanceof OllamaProvider ? p : null;
  }

  getRouter(): SmartRouter {
    return this.router;
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  async checkAvailability(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [name, provider] of this.providers) {
      results[name] = await provider.isAvailable();
    }
    return results;
  }
}

