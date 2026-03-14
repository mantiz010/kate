/**
 * Kate Agent v2.0 — Clean rewrite
 * Proper Ollama tool-calling agent loop.
 * No hacks, no patches, no band-aids.
 */

import { SkillManager } from "../skills/manager.js";
import { MemoryStore } from "../memory/store.js";
import { loadConfig } from "./config.js";
import { saveMessage } from "./chathistory.js";

const MAX_ROUNDS = 10;
const OLLAMA_URL = "http://172.168.1.162:11434";

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface AgentMessage {
  content: string;
  userId?: string;
  sessionId?: string;
}

function log(icon: string, label: string, msg: string, color = "0") {
  const time = new Date().toLocaleTimeString();
  const c = color === "31" ? "\x1b[31m" : color === "32" ? "\x1b[32m" : color === "33" ? "\x1b[33m" : color === "36" ? "\x1b[36m" : "";
  console.log(`  ${time} ${c}${icon}\x1b[0m ${label} ${msg.slice(0, 120)}`);
}

export class Agent {
  skills: SkillManager;
  memory: MemoryStore;
  config: any;
  model: string;
  onToken?: (token: string) => void;

  private sessions: Map<string, Message[]> = new Map();

  constructor(config: any, providers: any, skills: SkillManager, memory: MemoryStore) {
    this.skills = skills;
    this.memory = memory;
    this.config = config;
    this.model = config?.provider?.ollama?.model || "qwen3-coder";
  }

  /**
   * Build OpenAI-compatible tool schemas from registered skills.
   */
  private getToolSchemas(): any[] {
    const tools = this.skills.getAllTools();
    return tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            (t.parameters || []).map(p => [p.name, {
              type: p.type || "string",
              description: p.description || "",
            }])
          ),
          required: (t.parameters || []).filter(p => p.required).map(p => p.name),
        },
      },
    }));
  }

  /**
   * Filter tools to most relevant ~50 for this message.
   */
  private filterTools(message: string, allTools: any[]): any[] {
    const low = message.toLowerCase();
    const scored = allTools.map(t => {
      const fn = t.function;
      let score = 0;
      // Name match
      const nameParts = fn.name.split("_");
      for (const part of nameParts) {
        if (low.includes(part) && part.length > 2) score += 20;
      }
      // Description match
      const descWords = fn.description.toLowerCase().split(/\s+/);
      for (const w of descWords) {
        if (low.includes(w) && w.length > 3) score += 2;
      }
      // Boost common tools
      if (["run_command", "list_directory", "read_file", "write_file", "memorize", "recall", "search", "system_info"].includes(fn.name)) score += 5;
      return { tool: t, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Always include core tools + top scored
    const core = scored.filter(s =>
      ["run_command", "list_directory", "read_file", "write_file", "memorize", "recall"].includes(s.tool.function.name)
    ).map(s => s.tool);

    const topScored = scored.filter(s => s.score > 0).slice(0, 40).map(s => s.tool);
    const merged = [...new Map([...core, ...topScored].map(t => [t.function.name, t])).values()];

    return merged.length > 5 ? merged : scored.slice(0, 30).map(s => s.tool);
  }

  /**
   * Call Ollama API.
   */
  private async callOllama(messages: Message[], tools: any[]): Promise<{ content: string; toolCalls: any[] }> {
    const body = {
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 4096,
        num_ctx: 8192,
      },
    };

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as any;
    const msg = data.message || {};

    return {
      content: msg.content || "",
      toolCalls: msg.tool_calls || [],
    };
  }

  /**
   * Execute a single tool call.
   */
  private async executeTool(name: string, args: Record<string, any>, userId = "web-user", source = "web"): Promise<string> {
    try {
      const ctx = {
        userId,
        source,
        memory: this.memory,
        config: this.config,
        log: {
          debug: (msg: string, ...a: unknown[]) => {},
          info: (msg: string, ...a: unknown[]) => console.log(`[${name}]`, msg, ...a),
          warn: (msg: string, ...a: unknown[]) => console.warn(`[${name}]`, msg, ...a),
          error: (msg: string, ...a: unknown[]) => console.error(`[${name}]`, msg, ...a),
        },
      };
      const result = await this.skills.executeTool(name, args, ctx);
      return result || "Tool returned empty result.";
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  /**
   * Build system prompt.
   */
  private buildSystemPrompt(memoryContext: string): string {
    const name = this.config?.agent?.name || "Kate";
    return `You are ${name}, an AI agent that manages a homelab.

RULES:
1. For greetings (hello, hi, hey, thanks) — just reply naturally. Do NOT call any tools.
2. For questions about yourself — answer from this prompt. No tools needed.
3. For tasks (create, build, list, show, search, check, find, read, write, compile, start, stop, scan, deploy) — use the right tool immediately.
4. Never print [Executing] — call the tool directly.
5. Never ask permission. Act.
6. If a tool fails, try a different approach or tool.
7. Show results clearly — code in code blocks, data formatted.
8. Use MINIMUM tool calls needed. Don't explore the filesystem for fun.
9. One tool call per step unless parallel makes sense.

HOME DIRECTORY: /home/mantiz010 (NOT /home/kate)
ENVIRONMENT:
- Arduino projects: ~/Arduino/ (500+ projects, libraries in ~/Arduino/libraries/)
- Kate projects: ~/kate/projects/arduino/
- Proxmox: 172.168.1.204 (token pre-configured)
- Home Assistant: 172.168.1.8 (ET-Bus encrypted)
- Ollama: 172.168.1.162
- WiFi: SSID=mantiz010, PASS=DavidCross010
- MQTT: host=172.168.1.8, port=1883, user=mantiz010, pass=DavidCross010

USER'S ACTUAL LIBRARIES (use THESE exact includes):
- ADS1115: #include <Adafruit_ADS1X15.h> // from Adafruit_ADS1X15\n- AHTX0: #include <Adafruit_AHTX0.h> // from Adafruit_AHTX0\n- BME280: #include <SparkFunBME280.h> // from SparkFun_BME280\n- BME680: #include <Zanshin_BME680.h> // from BME680-1.0.10\n- ENS160: #include <SparkFun_ENS160.h> // from SparkFun_Indoor_Air_Quality_Sensor_-_ENS160\n- ETBus: #include <ETBus.h> // from ETBus\n- HTU21D: #include <SparkFunHTU21D.h> // from SparkFun_HTU21D_Humidity_and_Temperature_Sensor_Breakout\n- INA219: #include <Adafruit_INA219.h> // from Adafruit_INA219\n- NeoPixel: #include <NeoPixelSegmentBus.h> // from NeoPixelBus_by_Makuna\n- PubSubClient: #include <ShimClient.h> // from PubSubClient\n- RF24: #include <RF24Network_config.h> // from RF24Network\n- SSD1306: #include <SH1106Spi.h> // from esp8266-oled-ssd1306
IMPORTANT: Do NOT use Adafruit_HTU21DF.h — it doesn't exist. Use SparkFunHTU21D.h.

ESP BOARDS:
- ESP8266 (D1 Mini): WiFi only, use #include <ESP8266WiFi.h>
- ESP32: WiFi+BT, use #include <WiFi.h>
- ESP32-S3: WiFi+BLE+USB
- ESP32-C6: WiFi+BLE+Zigbee+Thread
- ESP32-H2: BLE+Zigbee only (NO WiFi)

ARDUINO WORKFLOW:
1. Search existing projects first: run_command with 'ls ~/Arduino/ | grep -i <keywords>'
2. Read best match: read_file
3. Create improved version with arduino_new + arduino_write (FULL working code)
4. Compile with arduino_compile
5. Always show the code

${memoryContext ? "MEMORY:\n" + memoryContext + "\n" : ""}`;
  }

  /**
   * Main agent loop — the core of Kate.
   */
  async handleMessage(msg: AgentMessage): Promise<string> {
    const sessionId = msg.sessionId || "default";
    const userId = msg.userId || "user";

    log("▶", "INPUT", `"${msg.content}"`, "36");

    // Save to history
    try { saveMessage(sessionId, "user", msg.content); } catch {}

    // Load memory context
    let memoryContext = "";
    try {
      const memories = await this.memory.recall(msg.content, 5);
      if (memories?.length) {
        memoryContext = memories.map((m: any) => `${m.key}: ${m.value}`).join("\n");
      }
      // Always load user profile
      const profile = await this.memory.recall("user profile network arduino", 3);
      if (profile?.length) {
        memoryContext += "\n" + profile.map((m: any) => `${m.key}: ${m.value}`).join("\n");
      }
    } catch {}

    // Build messages
    const systemPrompt = this.buildSystemPrompt(memoryContext);
    const history = this.sessions.get(sessionId) || [];

    // Keep last 6 messages
    if (history.length > 12) history.splice(0, history.length - 12);

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: msg.content },
    ];

    // Get all tools and filter
    const allTools = this.getToolSchemas();
    const tools = this.filterTools(msg.content, allTools);
    log("🎯", "FILTER", `${tools.length}/${allTools.length} tools`, "33");

    // Agent loop
    let round = 0;
    let totalToolCalls = 0;
    let lastContent = "";
    let toolResults: string[] = [];

    while (round < MAX_ROUNDS) {
      round++;

      log("⚡", `ROUND ${round}`, `→ ${this.model} (${tools.length} tools)`, "36");

      const response = await this.callOllama(messages, tools);

      // If model returned text content
      if (response.content) {
        lastContent = response.content;
      }

      // If no tool calls, we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        log("✔", "DONE", `${round} round(s), ${totalToolCalls} tool(s)`, "32");
        break;
      }

      // Process tool calls
      const callNames = response.toolCalls.map((tc: any) => tc.function?.name || "?").join(", ");
      log("🔧", `TOOLS`, callNames, "33");

      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: response.toolCalls,
      });

      // Execute each tool call
      for (const tc of response.toolCalls) {
        const fnName = tc.function?.name || "";
        const fnArgs = tc.function?.arguments || {};
        totalToolCalls++;

        log("  →", fnName, JSON.stringify(fnArgs).slice(0, 80), "0");

        const start = Date.now();
        const result = await this.executeTool(fnName, fnArgs, userId, "web");
        const elapsed = Date.now() - start;

        const success = !result.startsWith("Error:");
        log("  " + (success ? "✓" : "✗"), fnName, `${elapsed}ms — ${result.slice(0, 80)}`, success ? "32" : "31");

        toolResults.push(result);

        // Add tool result back to messages
        messages.push({
          role: "tool",
          content: result.slice(0, 4000),
          tool_call_id: tc.id || fnName,
        });
      }
    }

    // Build final response
    let finalResponse = lastContent;

    // Clean up [Executing...] artifacts
    if (finalResponse) {
      finalResponse = finalResponse.replace(/\[Executing [^\]]*\]/g, "").trim();
    }

    // If model gave no text but tools ran, show tool results
    if (!finalResponse && toolResults.length > 0) {
      finalResponse = toolResults.filter(r => r && !r.startsWith("Error:")).join("\n\n");
    }

    // If model's text is short and references results, show the LAST tool result only
    if (finalResponse && finalResponse.length < 200 && toolResults.length > 0) {
      const lastGood = toolResults.filter(r => r && r.length > 50 && !r.startsWith("Error:")).pop();
      if (lastGood) {
        finalResponse += "\n\n" + lastGood;
      }
    }

    // If still empty, auto-retry with run_command
    if (!finalResponse && totalToolCalls === 0) {
      log("🔄", "AUTO", "Empty response — trying direct action", "33");
      const low = msg.content.toLowerCase();

      if (low.includes("list") || low.includes("show") || low.includes("what")) {
        try {
          let cmd = "echo 'No specific action found'";
          if (low.includes("librar")) cmd = "ls ~/Arduino/libraries/ | head -30";
          else if (low.includes("arduino") || low.includes("project")) cmd = "ls ~/Arduino/ | grep -i '" + msg.content.split(" ").pop() + "' | head -20";
          else if (low.includes("vm") || low.includes("proxmox")) cmd = "echo 'Use: show my proxmox VMs'";
          else if (low.includes("docker")) cmd = "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null || echo 'Docker not running'";
          else if (low.includes("system") || low.includes("health")) cmd = "echo \"CPU: $(top -bn1 | grep 'Cpu(s)' | awk '{print $2}')% | RAM: $(free -h | grep Mem | awk '{print $3\"/\"$2}') | Disk: $(df -h / | tail -1 | awk '{print $5}')\"";

          const result = await this.executeTool("run_command", { command: cmd });
          finalResponse = result;
        } catch {}
      }
    }

    if (!finalResponse) {
      finalResponse = "I couldn't complete that. Try being more specific, like:\n• list files in ~/Arduino\n• create an ESP32 MQTT sensor\n• show my proxmox VMs\n• check system health";
    }

    // Update ET-Bus state file
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");
      const sf = path.default.join(os.default.homedir(), ".kate", "etbus-state.json");
      let st: any = {};
      try { st = JSON.parse(fs.default.readFileSync(sf, "utf-8")); } catch {}
      st.last_command = msg.content.slice(0, 200);
      st.last_response = finalResponse.slice(0, 200);
      st.requests = (st.requests || 0) + 1;
      st.status = "online";
      fs.default.writeFileSync(sf, JSON.stringify(st));
    } catch {}

    // Save to history
    try { saveMessage(sessionId, "assistant", finalResponse); } catch {}

    // Update session
    history.push({ role: "user", content: msg.content });
    history.push({ role: "assistant", content: finalResponse });
    this.sessions.set(sessionId, history);

    // Deduplicate — remove repeated blocks
    const blocks = finalResponse.split("\n═══════════════════════════════════════\n");
    if (blocks.length > 2) {
      finalResponse = blocks[0] + "\n═══════════════════════════════════════\n" + blocks[blocks.length - 1];
    }

    log("💬", "REPLY", finalResponse.slice(0, 80), "36");
    return finalResponse;
  }
}
