import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, KateConfig, Logger } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { OllamaProvider } from "./ollama.js";

const log = createLogger("router");

// ── Route classification ───────────────────────────────────────

type Complexity = "simple" | "simple" | "moderate" | "complex" | "expert";

interface RouteConfig {
  trivial: string;   // Model for very simple tasks (greetings, yes/no, formatting)
  simple: string;    // Model for basic tasks (single tool call, short answers)
  moderate: string;  // Model for multi-step tasks (2-5 tool calls, reasoning)
  complex: string;   // Model for hard tasks (multi-round, code gen, analysis)
  expert: string;    // Model for the hardest tasks (architecture, debugging, creative)
}

interface RouteDecision {
  complexity: Complexity;
  model: string;
  reason: string;
  confidence: number;
}

interface RouterStats {
  totalRouted: number;
  byComplexity: Record<Complexity, number>;
  byModel: Record<string, number>;
  avgLatency: Record<string, number>;
  tokensSaved: number;
}

// ── Complexity classifier ──────────────────────────────────────

const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|bye|quit|exit)/i,
  /^(yes|no|yep|nope|sure|fine)$/i,
  /^\/\w+/,  // slash commands
  /^.{1,15}$/,  // very short messages
];

const SIMPLE_PATTERNS = [
  /^(what|when|where|who|how)\s+(is|are|was|were|do|does)\b/i,
  /^(list|show|get|check|read|tell me)\b/i,
  /^(run|execute)\s+\w+$/i,
  /\b(time|date|weather|version)\b/i,
];

const COMPLEX_PATTERNS = [
  /\b(create|build|design|implement|write|develop|architect)\b.*\b(project|app|system|service|api|skill|plugin|website)\b/i,
  /\b(refactor|rewrite|optimize|improve|debug|fix)\b.*\b(code|project|system)\b/i,
  /\b(compare|analyze|evaluate|research|investigate)\b/i,
  /\b(and then|after that|next|also|additionally|furthermore)\b/i,  // multi-step indicators
  /\b(pcb|schematic|circuit|firmware|deploy|pipeline|ci\/cd)\b/i,
];

const EXPERT_PATTERNS = [
  /\b(architecture|design pattern|security audit|performance optimization)\b/i,
  /\b(from scratch|production.ready|enterprise|scale)\b/i,
  /\b(explain why|how does.*work|what's the best approach)\b/i,
  /\b(plan|strategy|roadmap)\b/i,
];

function classifyComplexity(prompt: string, toolCount: number = 0): { complexity: Complexity; confidence: number; reason: string } {
  const words = prompt.split(/\s+/).length;
  const hasCode = prompt.includes("```") || prompt.includes("function ") || prompt.includes("class ");

  // Trivial: very short, greetings, slash commands
  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(prompt)) {
      return { complexity: "simple", confidence: 0.9, reason: "Reclassified to simple" };
    }
  }

  // Expert: architecture, deep reasoning
  for (const pattern of EXPERT_PATTERNS) {
    if (pattern.test(prompt)) {
      return { complexity: "expert", confidence: 0.75, reason: "Expert-level task pattern" };
    }
  }

  // Complex: multi-step, creation, code
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(prompt)) {
      return { complexity: "complex", confidence: 0.8, reason: "Complex task pattern" };
    }
  }

  // Heuristics based on length and content
  if (hasCode || words > 100) {
    return { complexity: "complex", confidence: 0.7, reason: "Long prompt or code content" };
  }

  if (words > 40) {
    return { complexity: "moderate", confidence: 0.65, reason: "Medium-length detailed request" };
  }

  // Simple: basic queries, single operations
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(prompt)) {
      return { complexity: "simple", confidence: 0.8, reason: "Simple query pattern" };
    }
  }

  if (words <= 10) {
    return { complexity: "simple", confidence: 0.6, reason: "Short prompt, likely simple" };
  }

  // Default to moderate
  // Code/create tasks → complex (uses qwen3-coder)
  const codePat = /create|write|build|code|sketch|arduino|compile|script|function|class|program|implement|develop|generate|improve|fix.*code|refactor|debug|sensor|mqtt|esp32|esp8266|zigbee|etbus/i;
  if (codePat.test(prompt)) return { complexity: "complex", confidence: 0.85, reason: "Code task → qwen3-coder" };

  return { complexity: "moderate", confidence: 0.5, reason: "No strong signals, defaulting to moderate" };
}

// ── Smart Router Provider ──────────────────────────────────────

export class SmartRouter implements Provider {
  name = "router";
  models: string[] = [];
  defaultModel: string;

  private routes: RouteConfig;
  private ollamaUrl: string;
  private providerCache = new Map<string, OllamaProvider>();
  private stats: RouterStats = {
    totalRouted: 0,
    byComplexity: { trivial: 0, simple: 0, moderate: 0, complex: 0, expert: 0 },
    byModel: {},
    avgLatency: {},
    tokensSaved: 0,
  };

  constructor(config: KateConfig) {
    this.ollamaUrl = config.provider.ollama.baseUrl;
    this.defaultModel = config.provider.ollama.model;

    // Default route config — maps complexity to models
    // Users can override via config
    this.routes = {
      trivial: 'qwen3-coder',    // fastest available
      simple: 'qwen3-coder',     // fast
      moderate: 'qwen3-coder',   // balanced
      complex: 'qwen3-coder',    // capable
      expert: 'qwen3-coder',     // most capable
    };
  }

  // Configure which models handle which complexity levels
  setRoutes(routes: Partial<RouteConfig>): void {
    Object.assign(this.routes, routes);
    log.info("Routes updated:");
    for (const [level, model] of Object.entries(this.routes)) {
      log.info(`  ${level} → ${model}`);
    }
  }

  getRoutes(): RouteConfig {
    return { ...this.routes };
  }

  // Analyze a prompt and decide which model to use
  route(prompt: string): RouteDecision {
    const { complexity, confidence, reason } = classifyComplexity(prompt);
    const model = this.routes[complexity];

    return { complexity, model, reason, confidence };
  }

  async isAvailable(): Promise<boolean> {
    const provider = this.getProvider(this.defaultModel);
    return provider.isAvailable();
  }

  async chat(messages: ProviderMessage[], options?: ProviderOptions): Promise<ProviderResponse> {
    // Get the last user message for routing
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const prompt = lastUser?.content || "";

    // Route to the right model
    const decision = this.route(prompt);
    const model = options?.model || decision.model;

    log.info(`Routing: [${decision.complexity}] → ${model} (${decision.reason}, ${Math.round(decision.confidence * 100)}% confident)`);

    // Update stats
    this.stats.totalRouted++;
    this.stats.byComplexity[decision.complexity]++;
    this.stats.byModel[model] = (this.stats.byModel[model] || 0) + 1;

    // Get or create provider for this model
    const provider = this.getProvider(model);
    const startTime = Date.now();

    const response = await provider.chat(messages, {
      ...options,
      model,
      // Adjust parameters based on complexity
      temperature: decision.complexity === "simple" ? 0.1 :
                   decision.complexity === "simple" ? 0.2 :
                   decision.complexity === "moderate" ? 0.4 :
                   decision.complexity === "complex" ? 0.5 :
                   0.6,
      maxTokens: decision.complexity === "simple" ? 256 :
                 decision.complexity === "simple" ? 1024 :
                 decision.complexity === "moderate" ? 2048 :
                 decision.complexity === "complex" ? 4096 :
                 4096,
    });

    const elapsed = Date.now() - startTime;

    // Track latency
    if (!this.stats.avgLatency[model]) this.stats.avgLatency[model] = elapsed;
    else this.stats.avgLatency[model] = (this.stats.avgLatency[model] + elapsed) / 2;

    return response;
  }

  private getProvider(model: string): OllamaProvider {
    if (!this.providerCache.has(model)) {
      this.providerCache.set(model, new OllamaProvider(this.ollamaUrl, model));
    }
    return this.providerCache.get(model)!;
  }

  getStats(): RouterStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalRouted: 0,
      byComplexity: { trivial: 0, simple: 0, moderate: 0, complex: 0, expert: 0 },
      byModel: {},
      avgLatency: {},
      tokensSaved: 0,
    };
  }
}

