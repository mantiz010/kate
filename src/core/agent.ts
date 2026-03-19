/**
 * Kate Agent v2.0 — Clean rewrite
 * Proper Ollama tool-calling agent loop.
 * No hacks, no patches, no band-aids.
 */

import { SkillManager } from "../skills/manager.js";
import { MemoryStore } from "../memory/store.js";
import { loadConfig } from "./config.js";
import { saveMessage } from "./chathistory.js";

const MAX_ROUNDS = 50;
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
      stream: true,
      options: {
        temperature: 0.3,
        num_predict: 4096,
        num_ctx: 16384,
        think: false,
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

    // Stream response
    let content = "";
    let toolCalls: any[] = [];
    let buffer = "";
    
    for await (const chunk of res.body as any) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.message?.content) {
            content += obj.message.content;
            if (this.onToken) this.onToken(obj.message.content);
          }
          if (obj.message?.tool_calls) {
            toolCalls = obj.message.tool_calls;
          }
        } catch {}
      }
    }
    
    return { content, toolCalls };
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
    return `You are ${name}, an autonomous AI engineer managing a homelab.

YOU THINK FOR YOURSELF. You research, design, choose components, and build.
You are not a copy machine. You make engineering decisions.

CORE RULES:
1. Greetings — reply naturally, no tools.
2. Tasks — act immediately, no permission needed.
3. If something fails — try a different approach.
4. RESEARCH FIRST — for open-ended requests, use web search before writing code.
5. Present ideas and let the user choose before building.

ENGINEERING DECISIONS:
- YOU choose the best sensor for each project. Do NOT default to HTU21D.
- Before writing code: check what libraries exist with ls ~/Arduino/libraries/ | grep -i <type>
- Or search the web: search "best sensor for <application>"
- Read library header files to learn the real API: read_file ~/Arduino/libraries/<lib>/src/<header>.h
- Pick the right protocol: WiFi/ETBus for indoor, Zigbee/LoRa for outdoor/battery, MQTT for cloud.
- NEVER guess a library API. Read the header file first.

COMPILE RULES — THESE ARE FACTS:
- Class HTU21D (NOT SparkFunHTU21D). begin() returns void. Just call htu.begin() — no if check.
- Class BME280 (NOT SparkFunBME280). Use readTempC(), readFloatHumidity(), readFloatPressure().
- Class Adafruit_INA219. begin() returns void. Just call ina.begin() — no if check.
- Class SparkFun_ENS160. Use begin(), getAQI(), getECO2(), getTVOC().
- MQTT and ET-Bus are DIFFERENT protocols. Never mix them.
- ESP8266: use #include <ESP8266WiFi.h>. ESP32: use #include <WiFi.h>.

ET-BUS PATTERN (when user asks for ET-Bus):
  ETBusWiFiManager wm; ETBus etbus;
  wm.begin("Name"); etbus.begin(name, "sensor.type", "Name", "v1.0");
  etbus.enableEncryptionHex(psk.c_str()); etbus.loop();
  StaticJsonDocument<128> payload; payload["key"] = value;
  etbus.sendState(payload.as<JsonObject>());

YOUR HOMELAB — THESE ARE FACTS, DO NOT RE-DISCOVER THEM:
- Kate VM: 172.168.1.72 (VM 104, 16 CPU, 8GB RAM, Ubuntu 22.04) — THIS is where you run commands
- Ollama GPU Server: 172.168.1.162 (VM 103, Tesla P100 16GB + Tesla P4 8GB, 40 CPU, 125GB RAM) — has qwen3-coder at 40 tok/s
- Proxmox Host: 172.168.1.204 (80 cores Xeon Gold 6230, 251GB RAM) — use pve_nodes/pve_vms tools with API token, NOT ssh
- Home Assistant: 172.168.1.8 (VM 101, 8 CPU, 32GB RAM)
- VMs: 100=LinuxMint, 101=HA, 102=TrueNas(stopped), 103=OllamaGPU, 104=Kate
- When asked about Proxmox: use pve_nodes or pve_vms tool. Do NOT try SSH.
- When asked about Ollama GPU: the answer is Tesla P100 16GB + Tesla P4 8GB. Do NOT run nvidia-smi locally.
- When asked about system specs: check memory first, then use the right tool for the right server.

ENVIRONMENT:
- Home: /home/mantiz010
- Arduino: ~/Arduino/ (500+ projects), libraries: ~/Arduino/libraries/
- Proxmox: 172.168.1.204 — READ ONLY. Do NOT delete/stop VMs without asking.
- Home Assistant: 172.168.1.8
- Ollama: 172.168.1.162
- WiFi: SSID=mantiz010, PASS=DavidCross010
- MQTT: host=172.168.1.8, port=1883, user=mantiz010, pass=DavidCross010
- Workers: ALWAYS use model "qwen3-coder".

DECISION MAKING:
- Research max 3-4 rounds. Then DECIDE and BUILD.
- Do NOT spend rounds checking libraries you already know. Just use them.
- If you need a library you don't have — install it with arduino-cli lib install or write code without it.
- Make a DECISION. Present it. Build it. Don't ask permission.
- You are an engineer, not a librarian. Stop browsing and start building.

YOU ARE FREE TO:
- Research anything on the web
- Read any file on this system
- Run any command
- Create any project
- Choose any sensor, protocol, or architecture
- Disagree with the user if you have a better idea

YOU MUST NOT:
- Delete or stop Proxmox VMs without asking
- rm -rf anything important
- Guess library APIs — read the header file
- ESP32-S3: WiFi+BLE+USB
- ESP32-C6: WiFi+BLE+Zigbee+Thread
- ESP32-H2: BLE+Zigbee only (NO WiFi)

ARDUINO WORKFLOW:
1. Search existing projects first: run_command with 'ls ~/Arduino/ | grep -i <keywords>'
2. Read best match: read_file
3. Create improved version with arduino_new + arduino_write (FULL working code)
4. Compile with arduino_compile
5. Always show the code

${memoryContext ? "\n⚠️ IMPORTANT — YOU ALREADY KNOW THIS (from your memory database — USE THIS FIRST, do not re-discover with tools):\n" + memoryContext + "\n" : ""}`;
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
      log("🧠", "MEMORY", "searching for: " + msg.content.slice(0, 40) + " userId=" + userId, "35");
      const memories = await this.memory.search(msg.content, userId, 5);
      log("🧠", "MEMORY", "found " + (memories?.length || 0) + " results", "35");
      if (memories?.length) {
        memoryContext = memories.map((m: any) => `${m.key}: ${m.value}`).join("\n");
      }
      // Always load user profile
      const profile = await this.memory.search("user profile network arduino", userId, 3);
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
      { role: "user", content: (memoryContext ? "Context from my memory (use this):\n" + memoryContext + "\n\nUser question: " : "") + msg.content },
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
    let calledTools: Set<string> = new Set();

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

        // Skip if same tool+args called before
        const callKey = fnName + ":" + JSON.stringify(fnArgs);
        if (calledTools.has(callKey) && !fnName.includes("compile")) {
          log("  ⏭", fnName, "SKIPPED (duplicate)", "33");
          messages.push({ role: "tool", content: "Already called — see previous result.", tool_call_id: tc.id || fnName });
          continue;
        }
        calledTools.add(callKey);

        log("  →", fnName, JSON.stringify(fnArgs).slice(0, 80), "0");

        const start = Date.now();
        const result = await this.executeTool(fnName, fnArgs, userId, "web");
        const elapsed = Date.now() - start;

        const success = !result.startsWith("Error:");
        log("  " + (success ? "✓" : "✗"), fnName, `${elapsed}ms — ${result.slice(0, 80)}`, success ? "32" : "31");

        toolResults.push(result);
        // auto-remember compile outcomes
        if (fnName.includes("compile") && result.includes("error:")) {
          const err = result.split("\n").find((l: string) => l.includes("error:")) || result.slice(0, 150);
          try { await this.executeTool("remember", { key: "err_" + Date.now(), value: err.slice(0, 200), category: "fact", importance: 0.9 }, userId, "auto"); } catch {}
        }
        if (fnName.includes("compile") && result.includes("Compiled:")) {
          try { await this.executeTool("remember", { key: "ok_" + Date.now(), value: result.split("\n")[0].slice(0, 200), category: "fact", importance: 0.5 }, userId, "auto"); } catch {}
        }

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

    // Always include tool results that contain code or compile output
    if (toolResults.length > 0) {
      const codeResults = toolResults.filter(r => 
        r && r.length > 100 && !r.startsWith("Error:") && 
        (r.includes("```cpp") || r.includes("✅ Written") || r.includes("✅ Compiled") || r.includes("❌ Compile"))
      );
      if (codeResults.length > 0 && !finalResponse.includes("```cpp")) {
        finalResponse = codeResults.join("\n\n");
        if (lastContent && lastContent.length < 200) {
          finalResponse = lastContent + "\n\n" + finalResponse;
        }
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
