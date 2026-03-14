import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, ToolDefinition, ToolCall } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("anthropic");

export class AnthropicProvider implements Provider {
  name = "anthropic";
  models = ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-opus-4-5-20250527"];
  defaultModel = "claude-sonnet-4-20250514";

  private apiKey: string;
  private client: any;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    if (model) this.defaultModel = model;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async chat(messages: ProviderMessage[], options?: ProviderOptions): Promise<ProviderResponse> {
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.client = new Anthropic({ apiKey: this.apiKey });
    }

    const model = options?.model || this.defaultModel;
    const systemMsg = messages.find(m => m.role === "system");
    const chatMessages = messages
      .filter(m => m.role !== "system")
      .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

    // Build tools for Anthropic format
    const tools = options?.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        properties: Object.fromEntries(
          t.parameters.map(p => [p.name, {
            type: p.type,
            description: p.description,
          }])
        ),
        required: t.parameters.filter(p => p.required).map(p => p.name),
      },
    }));

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature,
        system: options?.systemPrompt || systemMsg?.content || undefined,
        messages: chatMessages,
        ...(tools?.length ? { tools } : {}),
      });

      // Extract text and tool calls
      let content = "";
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          content += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
        }
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0,
        },
        model,
        finishReason: response.stop_reason || "end_turn",
      };
    } catch (err: any) {
      log.error("Anthropic API error:", err.message);
      throw err;
    }
  }
}

