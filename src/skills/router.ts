import type { Skill, SkillContext } from "../core/types.js";
import { SmartRouter } from "../providers/router.js";
import { OllamaProvider } from "../providers/ollama.js";
import { loadConfig } from "../core/config.js";
import { saveConfig } from "../core/config.js";

let routerInstance: SmartRouter | null = null;

export function setRouterInstance(router: SmartRouter) {
  routerInstance = router;
}

const routerSkill: Skill = {
  id: "builtin.router",
  name: "Model Router",
  description: "Configure and monitor multi-model routing. Assign different Ollama models to different complexity levels for optimal speed and quality.",
  version: "1.0.0",
  tools: [
    {
      name: "router_status",
      description: "Show current routing configuration, model assignments, and performance stats",
      parameters: [],
    },
    {
      name: "router_set",
      description: "Assign a model to a complexity level. Levels: trivial (greetings), simple (one-step), moderate (multi-step), complex (creation), expert (architecture)",
      parameters: [
        { name: "level", type: "string", description: "Complexity level: trivial, simple, moderate, complex, expert", required: true },
        { name: "model", type: "string", description: "Ollama model name to use for this level", required: true },
      ],
    },
    {
      name: "router_auto",
      description: "Auto-configure routes based on installed Ollama models. Assigns fastest models to simple tasks and most capable to complex ones.",
      parameters: [],
    },
    {
      name: "router_test",
      description: "Test how a prompt would be routed without actually running it",
      parameters: [
        { name: "prompt", type: "string", description: "Test prompt to classify", required: true },
      ],
    },
    {
      name: "router_stats",
      description: "Show routing statistics: calls per model, latency, token usage",
      parameters: [],
    },
    {
      name: "router_reset_stats",
      description: "Reset all routing statistics",
      parameters: [],
    },
    {
      name: "router_benchmark",
      description: "Run a quick benchmark across available models to measure response times",
      parameters: [],
    },
    {
      name: "router_list_models",
      description: "List all available Ollama models with their sizes and capabilities",
      parameters: [],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const config = await loadConfig();

    if (!routerInstance) {
      return "Router not initialized. Start kate with multi-model mode enabled.";
    }

    switch (toolName) {
      case "router_status": {
        const routes = routerInstance.getRoutes();
        const stats = routerInstance.getStats();

        return [
          "Multi-Model Router Status",
          "═══════════════════════",
          "",
          "Route Configuration:",
          `  trivial  → ${routes.trivial}   (greetings, yes/no, short)`,
          `  simple   → ${routes.simple}   (single queries, lookups)`,
          `  moderate → ${routes.moderate}   (multi-step, tool use)`,
          `  complex  → ${routes.complex}   (creation, code gen)`,
          `  expert   → ${routes.expert}   (architecture, deep analysis)`,
          "",
          `Total routed: ${stats.totalRouted}`,
          "",
          "Calls by complexity:",
          ...Object.entries(stats.byComplexity).map(([k, v]) => `  ${k}: ${v}`),
          "",
          "Calls by model:",
          ...Object.entries(stats.byModel).map(([k, v]) => `  ${k}: ${v} calls`),
          "",
          "Avg latency:",
          ...Object.entries(stats.avgLatency).map(([k, v]) => `  ${k}: ${Math.round(v)}ms`),
        ].join("\n");
      }

      case "router_set": {
        const level = args.level as string;
        const model = args.model as string;

        const validLevels = ["trivial", "simple", "moderate", "complex", "expert"];
        if (!validLevels.includes(level)) {
          return `Invalid level: ${level}. Valid: ${validLevels.join(", ")}`;
        }

        routerInstance.setRoutes({ [level]: model } as any);
        return `Route updated: ${level} → ${model}`;
      }

      case "router_auto": {
        const ollama = new OllamaProvider(config.provider.ollama.baseUrl);
        const available = await ollama.isAvailable();
        if (!available) return "Ollama not running.";

        const models = await ollama.refreshModels();
        if (models.length === 0) return "No Ollama models installed.";

        // Size heuristics — map models to complexity
        const sizeOrder: Array<{ name: string; size: string }> = [];

        for (const m of models) {
          const name = m.toLowerCase();
          let size = "medium";
          if (name.includes("70b") || name.includes("72b") || name.includes("65b")) size = "xlarge";
          else if (name.includes("32b") || name.includes("34b")) size = "large";
          else if (name.includes("14b") || name.includes("13b")) size = "medium";
          else if (name.includes("7b") || name.includes("8b") || name.includes("3b")) size = "small";
          else if (name.includes("1b") || name.includes("0.5b") || name.includes("flash") || name.includes("fast") || name.includes("mini")) size = "tiny";
          sizeOrder.push({ name: m, size });
        }

        // Sort: tiny first, xlarge last
        const sizeRank: Record<string, number> = { tiny: 0, small: 1, medium: 2, large: 3, xlarge: 4 };
        sizeOrder.sort((a, b) => (sizeRank[a.size] || 2) - (sizeRank[b.size] || 2));

        const routes: Record<string, string> = {};
        const levels = ["trivial", "simple", "moderate", "complex", "expert"];

        if (sizeOrder.length === 1) {
          // Only one model — use it for everything
          for (const level of levels) routes[level] = sizeOrder[0].name;
        } else if (sizeOrder.length === 2) {
          // Two models — small for easy, big for hard
          routes.trivial = sizeOrder[0].name;
          routes.simple = sizeOrder[0].name;
          routes.moderate = sizeOrder[1].name;
          routes.complex = sizeOrder[1].name;
          routes.expert = sizeOrder[1].name;
        } else {
          // 3+ models — spread across levels
          const step = (sizeOrder.length - 1) / (levels.length - 1);
          for (let i = 0; i < levels.length; i++) {
            const idx = Math.min(Math.round(i * step), sizeOrder.length - 1);
            routes[levels[i]] = sizeOrder[idx].name;
          }
        }

        routerInstance.setRoutes(routes as any);

        return [
          "Auto-configured routes based on installed models:",
          "",
          ...Object.entries(routes).map(([level, model]) =>
            `  ${level.padEnd(10)} → ${model}`
          ),
          "",
          `Based on ${models.length} installed model(s).`,
        ].join("\n");
      }

      case "router_test": {
        const prompt = args.prompt as string;
        const decision = routerInstance.route(prompt);

        return [
          `Prompt: "${prompt.slice(0, 80)}"`,
          ``,
          `Classification: ${decision.complexity}`,
          `Model: ${decision.model}`,
          `Reason: ${decision.reason}`,
          `Confidence: ${Math.round(decision.confidence * 100)}%`,
        ].join("\n");
      }

      case "router_stats": {
        const stats = routerInstance.getStats();

        if (stats.totalRouted === 0) return "No routing stats yet. Start using the agent to generate data.";

        return [
          `Total requests routed: ${stats.totalRouted}`,
          "",
          "By complexity:",
          ...Object.entries(stats.byComplexity)
            .filter(([_, v]) => v > 0)
            .map(([k, v]) => `  ${k}: ${v} (${Math.round(v / stats.totalRouted * 100)}%)`),
          "",
          "By model:",
          ...Object.entries(stats.byModel)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `  ${k}: ${v} calls`),
          "",
          "Average latency:",
          ...Object.entries(stats.avgLatency)
            .sort((a, b) => a[1] - b[1])
            .map(([k, v]) => `  ${k}: ${Math.round(v)}ms`),
        ].join("\n");
      }

      case "router_reset_stats": {
        routerInstance.resetStats();
        return "Routing stats reset.";
      }

      case "router_benchmark": {
        const ollama = new OllamaProvider(config.provider.ollama.baseUrl);
        const models = await ollama.refreshModels();

        if (models.length === 0) return "No models available.";

        const results: Array<{ model: string; latency: number; tokPerSec: number }> = [];
        const testPrompt = "What is 2+2? Answer with just the number.";

        for (const model of models.slice(0, 6)) { // Max 6 models
          const provider = new OllamaProvider(config.provider.ollama.baseUrl, model);
          const start = Date.now();
          try {
            const res = await provider.chat(
              [{ role: "user", content: testPrompt }],
              { maxTokens: 32, temperature: 0 },
            );
            const elapsed = Date.now() - start;
            const tokPerSec = res.usage ? res.usage.outputTokens / (elapsed / 1000) : 0;
            results.push({ model, latency: elapsed, tokPerSec: Math.round(tokPerSec) });
          } catch (err: any) {
            results.push({ model, latency: -1, tokPerSec: 0 });
          }
        }

        results.sort((a, b) => a.latency - b.latency);

        return [
          "Benchmark Results (simple prompt):",
          "═══════════════════════════════════",
          "",
          ...results.map((r, i) => {
            if (r.latency === -1) return `  ${i + 1}. ${r.model} — ERROR`;
            return `  ${i + 1}. ${r.model} — ${r.latency}ms (${r.tokPerSec} tok/s)`;
          }),
          "",
          "Use router_auto to assign models based on these results.",
        ].join("\n");
      }

      case "router_list_models": {
        const ollama = new OllamaProvider(config.provider.ollama.baseUrl);
        const available = await ollama.isAvailable();
        if (!available) return "Ollama not running.";

        const models = await ollama.refreshModels();
        if (models.length === 0) return "No models installed.";

        return models.map(m => `  • ${m}`).join("\n");
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },
};

export default routerSkill;

