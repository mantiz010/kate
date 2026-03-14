import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, ToolCall } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("openai");

export class OpenAIProvider implements Provider {
  name = "openai";
  models = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o1-mini"];
  defaultModel = "gpt-4o";

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
      const { default: OpenAI } = await import("openai");
      this.client = new OpenAI({ apiKey: this.apiKey });
    }

    const model = options?.model || this.defaultModel;

    const chatMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    if (options?.systemPrompt) {
      chatMessages.unshift({ role: "system", content: options.systemPrompt });
    }

    const tools = options?.tools?.map(t => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            t.parameters.map(p => [p.name, {
              type: p.type,
              description: p.description,
            }])
          ),
          required: t.parameters.filter(p => p.required).map(p => p.name),
        },
      },
    }));

    try {
      const response = await this.client.chat.completions.create({
        model,
        messages: chatMessages,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature,
        ...(tools?.length ? { tools } : {}),
      });

      const choice = response.choices[0];
      const toolCalls: ToolCall[] = [];

      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments),
          });
        }
      }

      return {
        content: choice.message.content || "",
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
        model,
        finishReason: choice.finish_reason || "stop",
      };
    } catch (err: any) {
      log.error("OpenAI API error:", err.message);
      throw err;
    }
  }
}

