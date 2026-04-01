import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, ToolCall, ToolDefinition } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("ollama");

export class OllamaProvider implements Provider {
  name = "ollama";
  models: string[] = [];
  defaultModel: string;
  private baseUrl: string;

  constructor(baseUrl: string = "http://172.168.1.162:11434", model?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.defaultModel = model || "llama3.1";
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as any;
        log.info(`Ollama connected: v${data.version}`);
        await this.refreshModels();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async refreshModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      const data = await res.json() as any;
      this.models = (data.models || []).map((m: any) => m.name);
      log.info(`Available models: ${this.models.join(", ") || "(none)"}`);
      return this.models;
    } catch {
      return [];
    }
  }

  async pullModel(model: string, onProgress?: (status: string) => void): Promise<boolean> {
    log.info(`Pulling model: ${model}...`);
    try {
      const res = await fetch(`${this.baseUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model, stream: true }),
      });

      if (!res.ok || !res.body) return false;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value, { stream: true }).split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            if (json.status) {
              onProgress?.(json.status);
              if (json.completed && json.total) {
                const pct = Math.round((json.completed / json.total) * 100);
                onProgress?.(`${json.status} ${pct}%`);
              }
            }
          } catch {}
        }
      }

      await this.refreshModels();
      log.info(`Model ${model} pulled successfully`);
      return true;
    } catch (err: any) {
      log.error(`Failed to pull model: ${err.message}`);
      return false;
    }
  }

  async chat(messages: ProviderMessage[], options?: ProviderOptions): Promise<ProviderResponse> {
    const model = options?.model || this.defaultModel;

    // Build messages array with system prompt
    const ollamaMessages: Array<{ role: string; content: string }> = [];

    if (options?.systemPrompt) {
      ollamaMessages.push({ role: "system", content: options.systemPrompt });
    }

    for (const msg of messages) {
      ollamaMessages.push({ role: msg.role, content: msg.content });
    }

    // Build tools in Ollama format (compatible with OpenAI function calling format)
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
      const body: Record<string, unknown> = {
        model,
        messages: ollamaMessages,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.7,
          num_predict: options?.maxTokens || 4096,
        },
      };

      if (tools && tools.length > 0) {
        body.tools = tools;
      }

      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama API error ${res.status}: ${errText}`);
      }

      const data = await res.json() as any;

      // Extract content and tool calls
      let content = data.message?.content || "";
      const toolCalls: ToolCall[] = [];

      if (data.message?.tool_calls) {
        for (const tc of data.message.tool_calls) {
          toolCalls.push({
            id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: tc.function.name,
            arguments: tc.function.arguments || {},
          });
        }
      }

      // Some models don't support native tool calling — parse from text as fallback
      if (toolCalls.length === 0 && options?.tools && options.tools.length > 0) {
        const parsed = this.parseToolCallsFromText(content, options.tools);
        if (parsed.length > 0) {
          toolCalls.push(...parsed);
          // Remove the tool call text from content
          content = this.stripToolCallText(content);
        }
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: data.prompt_eval_count || 0,
          outputTokens: data.eval_count || 0,
        },
        model,
        finishReason: data.done_reason || "stop",
      };
    } catch (err: any) {
      log.error(`Ollama error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Fallback: parse tool calls from text output for models that don't support
   * native function calling. Looks for JSON blocks with tool invocations.
   */
  private parseToolCallsFromText(text: string, availableTools: ToolDefinition[]): ToolCall[] {
    const calls: ToolCall[] = [];
    const toolNames = new Set(availableTools.map(t => t.name));

    // Pattern 1: ```json { "tool": "name", "arguments": {...} } ```
    const jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    let match;
    while ((match = jsonBlockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const name = parsed.tool || parsed.name || parsed.function;
        const args = parsed.arguments || parsed.args || parsed.parameters || parsed.input || {};
        if (name && toolNames.has(name)) {
          calls.push({
            id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name,
            arguments: args,
          });
        }
      } catch {}
    }

    // Pattern 2: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
    const tagRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    while ((match = tagRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const name = parsed.name || parsed.tool;
        const args = parsed.arguments || parsed.args || {};
        if (name && toolNames.has(name)) {
          calls.push({
            id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name,
            arguments: args,
          });
        }
      } catch {}
    }

    // Pattern 3: <function=name><parameter=key>value</parameter></function>
    const funcRegex = /<function=(\w+)>([\s\S]*?)<\/function>/g;
    while ((match = funcRegex.exec(text)) !== null) {
      const name = match[1];
      const body = match[2];
      const args: Record<string, string> = {};
      const paramRegex = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
      let pmatch;
      while ((pmatch = paramRegex.exec(body)) !== null) {
        args[pmatch[1]] = pmatch[2].trim();
      }
      if (name && toolNames.has(name)) {
        calls.push({
          id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          arguments: args,
        });
      }
    }
    return calls;
  }

  private stripToolCallText(text: string): string {
    return text
      .replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/g, "")
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .trim();
  }

  async streamChat(
    msgs: Array<{role: string; content: string}>,
    opts: any,
    onToken: (token: string) => void,
  ): Promise<{content: string; toolCalls: any[]}> {
    const body: any = {
      model: this.defaultModel,
      messages: msgs,
      stream: true,
      options: { temperature: opts.temperature || 0.7, num_predict: 8192, num_ctx: 32768 },
    };
    if (opts.systemPrompt) {
      body.messages = [{ role: "system", content: opts.systemPrompt }, ...msgs];
    }
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: "object",
            properties: Object.fromEntries((t.parameters || []).map((p: any) => [p.name, { type: p.type, description: p.description }])),
            required: (t.parameters || []).filter((p: any) => p.required).map((p: any) => p.name),
          },
        },
      }));
    }

    const response = await fetch(this.baseUrl + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let fullContent = "";
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.message?.content) {
              fullContent += data.message.content;
              onToken(data.message.content);
            }
          } catch {}
        }
      }
    }

    const toolCalls = this.parseToolCallsFromText(fullContent, opts.tools || []);
    return { content: fullContent, toolCalls };
  }
}

