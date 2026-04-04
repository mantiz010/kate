/**
 * Kate Agent v2.0 — Clean rewrite
 * Proper Ollama tool-calling agent loop.
 * No hacks, no patches, no band-aids.
 */

import { SkillManager } from "../skills/manager.js";
import { InMemoryStore } from "../memory/store.js";
import { loadConfig } from "./config.js";
import { saveMessage } from "./chathistory.js";
import { needsPlan, buildPlanPrompt } from "./planner.js";
import { recordSuccess, recordFailure, getRelevantLessons } from "./learner.js";
import { filterTools as smartFilterTools } from "./toolfilter.js";
import { ContextCache } from "./contextcache.js";

const MAX_ROUNDS = 100;
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
  memory: InMemoryStore;
  config: any;
  model: string;
  onToken?: (token: string) => void;

  private sessions: Map<string, Message[]> = new Map();
  private cache = new ContextCache();

  constructor(config: any, providers: any, skills: SkillManager, memory: InMemoryStore | any) {
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
   * Filter tools using smart intent-based matching from toolfilter.ts,
   * then convert to OpenAI-compatible format.
   */
  private filterToolsSmart(message: string, allSchemas: any[]): any[] {
    // Use the smart filter from toolfilter.ts (intent patterns + keywords + force-skills)
    const allTools = this.skills.getAllTools();
    const skillToolMap = this.skills.getSkillToolMap();
    const filtered = smartFilterTools(allTools, skillToolMap, message);
    const filteredNames = new Set(filtered.map(t => t.name));

    // Return only the OpenAI schemas that match filtered tool names
    const result = allSchemas.filter(s => filteredNames.has(s.function?.name));

    // Always include core tools even if smart filter missed them
    const ALWAYS_CORE = ["run_command", "list_directory", "read_file", "write_file", "memorize", "recall", "search_memory", "remember", "search", "template_search", "template_load", "arduino_compile", "arduino_write", "arduino_search", "web_fetch", "fetch_url"];
    for (const schema of allSchemas) {
      const name = schema.function?.name;
      if (name && ALWAYS_CORE.includes(name) && !filteredNames.has(name)) {
        result.push(schema);
      }
    }

    // Minimum floor: if smart filter returned too few, pad with top keyword matches
    if (result.length < 15) {
      const low = message.toLowerCase();
      const extras = allSchemas
        .filter(s => !result.includes(s))
        .map(s => {
          const name = s.function?.name || "";
          let score = 0;
          for (const part of name.split("_")) {
            if (low.includes(part) && part.length > 2) score += 10;
          }
          return { schema: s, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
      result.push(...extras.map(x => x.schema));
    }

    return result;
  }

  /**
   * Call Ollama API.
   */
  private async callOllama(messages: Message[], tools: any[], opts?: { think?: boolean; temperature?: number }): Promise<{ content: string; toolCalls: any[] }> {
    const body = {
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
      options: {
        temperature: opts?.temperature ?? 0.15,
        num_predict: 8192,
        num_ctx: 32768,
        think: opts?.think ?? false,
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
   * Build dynamic system prompt based on loaded skills and message context.
   * Only includes domain-specific rules when relevant to the current query.
   */
  private buildSystemPrompt(memoryContext: string, message?: string): string {
    const name = this.config?.agent?.name || "Kate";
    const skillList = this.skills.list();
    const skillNames = skillList.map(s => s.name).join(", ");
    const toolCount = skillList.reduce((n, s) => n + s.tools.length, 0);

    // Core identity + rules (always included, compact)
    let prompt = `You are ${name}, an autonomous AI agent with ${skillList.length} skills and ${toolCount} tools.

RULES:
1. Greetings — reply naturally, no tools.
2. Tasks — act immediately, no permission needed.
3. If something fails — try a different approach.
4. RESEARCH FIRST — for open-ended requests, use web search before writing code.
5. When searching for prices, use web_fetch to load actual pages. Never guess prices.
6. Present ideas and let the user choose before building.
7. You think for yourself. You make engineering decisions.

YOUR SKILLS: ${skillNames}

HOMELAB:
- Kate VM: 172.168.1.25 (VM 104)
- Ollama: 172.168.1.162 (Tesla P100 16GB + Tesla P4 8GB, qwen3-coder)
- Proxmox: 172.168.1.204 — use pve_nodes/pve_vms tools, NOT ssh
- Home Assistant: 172.168.1.8
`;

    // Conditionally inject domain-specific context based on what the user is asking
    if (message) {
      const msg = message.toLowerCase();

      // Arduino/ESP32/firmware context — only when relevant
      if (/arduino|esp32|esp8266|sensor|firmware|sketch|compile|upload|library|blink|i2c|spi/.test(msg)) {
        prompt += `
ARDUINO/ESP32 RULES:
- Before writing code: check libraries with ls ~/Arduino/libraries/ | grep -i <type>
- Read library headers to learn the real API: read_file ~/Arduino/libraries/<lib>/src/<header>.h
- NEVER guess a library API. Read the header file first.
- Class HTU21D (NOT SparkFunHTU21D). begin() returns void.
- Class BME280 (NOT SparkFunBME280). Use readTempC(), readFloatHumidity(), readFloatPressure().
- Class Adafruit_INA219. begin() returns void.
- ESP8266: #include <ESP8266WiFi.h>. ESP32: #include <WiFi.h>.
- Pick protocol: WiFi/ETBus for indoor, Zigbee/LoRa for outdoor/battery, MQTT for cloud.
`;
      }

      // ET-Bus context — only when relevant
      if (/etbus|et-bus|et bus/.test(msg)) {
        prompt += `
ET-BUS PATTERN:
  ETBusWiFiManager wm; ETBus etbus;
  wm.begin("Name"); etbus.begin(name, "sensor.type", "Name", "v1.0");
  etbus.enableEncryptionHex(psk.c_str()); etbus.loop();
  StaticJsonDocument<128> payload; payload["key"] = value;
  etbus.sendState(payload.as<JsonObject>());
- MQTT and ET-Bus are DIFFERENT protocols. Never mix them.
`;
      }

      // Docker context
      if (/docker|container|compose|image|dockerfile/.test(msg)) {
        prompt += `
DOCKER: Use docker tools for container management. Check running containers with docker_ps before making changes.
`;
      }

      // Network context
      if (/network|scan|ping|ip|subnet|device|nmap|mac/.test(msg)) {
        prompt += `
NETWORK: Subnet 172.168.1.0/24. Use net_scan for full scan with IP, MAC, hostname. Use net_find_esp for ESP devices. Use net_scan_services for service discovery.
IMPORTANT: When net_scan returns a table of devices, show the FULL TABLE to the user as-is. Do NOT summarize it into prose. The user wants to see every IP and MAC address.
`;
      }

      // Task/project management
      if (/task|todo|project|backlog|deadline/.test(msg)) {
        prompt += `
TASKS: Use task_create/task_list/task_update to manage tasks. Always show task IDs so user can reference them.
`;
      }

      // Vision
      if (/image|photo|picture|screenshot|ocr|vision|look at|analyze/.test(msg)) {
        prompt += `
VISION: Use vision_analyze for images, vision_ocr for text extraction, vision_describe_pcb for circuit boards. Accepts file paths.
`;
      }

      // Notifications
      if (/notify|alert|notification|warn me|tell me/.test(msg)) {
        prompt += `
NOTIFICATIONS: Use notify_send (multi-channel), notify_ha (Home Assistant), notify_alert (urgent, all channels). Channels: ha, mqtt, ntfy, log.
`;
      }
    }

    // Memory context at the end
    if (memoryContext) {
      prompt += `\nCONTEXT FROM MEMORY:\n${memoryContext}\n`;
    }

    return prompt;
  }

  /**
   * Main agent loop — the core of Kate.
   */
  clearConversation(userId: string, source: string): void {
    const sessionId = `${source}-${userId}`;
    this.sessions.delete(sessionId);
  }

  async handleMessage(msg: AgentMessage): Promise<string> {
    const sessionId = msg.sessionId || "default";
    const userId = msg.userId || "user";

    log("▶", "INPUT", `"${msg.content}"`, "36");

    // Quick response — skip LLM entirely for greetings/trivial messages
    const quickReply = this.cache.getQuickResponse(msg.content);
    if (quickReply) {
      log("⚡", "QUICK", `Instant reply: "${quickReply.slice(0, 60)}"`, "32");
      try { saveMessage(sessionId, "user", msg.content); } catch {}
      try { saveMessage(sessionId, "assistant", quickReply); } catch {}
      const history = this.sessions.get(sessionId) || [];
      history.push({ role: "user", content: msg.content });
      history.push({ role: "assistant", content: quickReply });
      this.sessions.set(sessionId, history);
      return quickReply;
    }

    // Save to history
    try { saveMessage(sessionId, "user", msg.content); } catch {}

    // Load memory context (deduplicated — only inject in system prompt, not user message)
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
        // Deduplicate: only add profile entries not already in memoryContext
        const existing = new Set(memoryContext.split("\n").map(l => l.split(":")[0].trim()));
        const newEntries = profile.filter((m: any) => !existing.has(m.key));
        if (newEntries.length) {
          memoryContext += "\n" + newEntries.map((m: any) => `${m.key}: ${m.value}`).join("\n");
        }
      }
    } catch {}

    // Fetch relevant lessons from past successes/failures
    let lessonsContext = "";
    try {
      const lessons = getRelevantLessons(msg.content, 5);
      if (lessons.length > 0) {
        lessonsContext = "\nLESSONS FROM EXPERIENCE:\n" + lessons.join("\n");
        log("📚", "LEARNER", `${lessons.length} relevant lesson(s)`, "33");
      }
    } catch {}

    // Detect complex tasks and activate planner + thinking
    const isComplex = needsPlan(msg.content);
    let userContent = msg.content;
    if (isComplex) {
      userContent = buildPlanPrompt(msg.content);
      log("📋", "PLANNER", "Complex task detected — plan prompt injected", "36");
    }

    // Build messages — dynamic system prompt based on message context
    const systemPrompt = this.buildSystemPrompt(memoryContext + lessonsContext, msg.content);
    const history = this.sessions.get(sessionId) || [];

    // Smart history management: compress old messages instead of hard-truncating.
    // Keep last 8 messages verbatim, compress older ones into a summary.
    // This preserves ~30 exchanges worth of context in the same token budget.
    let compressedHistory: Message[];
    if (history.length > 16) {
      const asSimple = history.map(m => ({ role: m.role, content: m.content }));
      const compressed = this.cache.compressConversation(asSimple, 8);
      compressedHistory = compressed.map(m => ({ role: m.role as Message["role"], content: m.content }));
      log("🗜", "COMPRESS", `${history.length} msgs → ${compressedHistory.length} (kept 8 recent + summary)`, "33");
    } else {
      compressedHistory = history;
    }

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...compressedHistory,
      { role: "user", content: userContent },
    ];

    // Check response cache — skip LLM if we've seen this exact conversation state
    const toolNames = this.skills.getAllTools().map(t => t.name);
    const cachedResponse = this.cache.getResponse(
      messages.map(m => ({ role: m.role, content: m.content })),
      toolNames
    );
    if (cachedResponse) {
      log("💾", "CACHE HIT", `Returning cached response`, "32");
      try { saveMessage(sessionId, "assistant", cachedResponse); } catch {}
      history.push({ role: "user", content: msg.content });
      history.push({ role: "assistant", content: cachedResponse });
      this.sessions.set(sessionId, history);
      return cachedResponse;
    }

    // Get all tools and filter using intent-based smart matching
    const allTools = this.getToolSchemas();
    const tools = this.filterToolsSmart(msg.content, allTools);
    log("🎯", "FILTER", `${tools.length}/${allTools.length} tools (smart)`, "33");

    // Agent loop
    let round = 0;
    let totalToolCalls = 0;
    let lastContent = "";
    let toolResults: string[] = [];
    let calledTools: Set<string> = new Set();

    while (round < MAX_ROUNDS) {
      round++;

      // Enable thinking on round 1 for complex tasks — lets the model reason before acting
      const ollamaOpts = (isComplex && round === 1) ? { think: true, temperature: 0.3 } : undefined;
      log("⚡", `ROUND ${round}`, `→ ${this.model} (${tools.length} tools)${ollamaOpts?.think ? " [THINKING]" : ""}`, "36");

      const response = await this.callOllama(messages, tools, ollamaOpts);

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

      // Execute tool calls in parallel for speed
      const pendingCalls = response.toolCalls.filter((tc: any) => {
        const fnName = tc.function?.name || "";
        const fnArgs = tc.function?.arguments || {};
        const callKey = fnName + ":" + JSON.stringify(fnArgs);
        if (calledTools.has(callKey) && !fnName.includes("compile")) {
          log("  ⏭", fnName, "SKIPPED (duplicate)", "33");
          messages.push({ role: "tool", content: "Already called — see previous result.", tool_call_id: tc.id || fnName });
          return false;
        }
        calledTools.add(callKey);
        return true;
      });

      if (pendingCalls.length > 1) {
        log("  ⚡", "PARALLEL", `Executing ${pendingCalls.length} tools concurrently`, "36");
      }

      const execPromises = pendingCalls.map(async (tc: any) => {
        const fnName = tc.function?.name || "";
        const fnArgs = tc.function?.arguments || {};
        totalToolCalls++;
        log("  →", fnName, JSON.stringify(fnArgs).slice(0, 80), "0");

        const start = Date.now();
        const result = await this.executeTool(fnName, fnArgs, userId, "web");
        const elapsed = Date.now() - start;

        const success = !result.startsWith("Error:");
        log("  " + (success ? "✓" : "✗"), fnName, `${elapsed}ms — ${result.slice(0, 80)}`, success ? "32" : "31");

        // Record outcome for learning
        try {
          if (success) recordSuccess(fnName, JSON.stringify(fnArgs).slice(0, 200), result.slice(0, 200));
          else recordFailure(fnName, JSON.stringify(fnArgs).slice(0, 200), result.slice(0, 200));
        } catch {}

        // auto-remember compile outcomes
        if (fnName.includes("compile") && result.includes("error:")) {
          const err = result.split("\n").find((l: string) => l.includes("error:")) || result.slice(0, 150);
          try { await this.executeTool("remember", { key: "err_" + Date.now(), value: err.slice(0, 200), category: "fact", importance: 0.9 }, userId, "auto"); } catch {}
        }
        if (fnName.includes("compile") && result.includes("Compiled:")) {
          try { await this.executeTool("remember", { key: "ok_" + Date.now(), value: result.split("\n")[0].slice(0, 200), category: "fact", importance: 0.5 }, userId, "auto"); } catch {}
        }

        return { tc, fnName, result, success };
      });

      const results = await Promise.all(execPromises);

      // Add results back to messages in order (preserves tool_call_id alignment)
      for (const { tc, result, success } of results) {
        toolResults.push(result);
        const toolContent = success
          ? result.slice(0, 4000)
          : result.slice(0, 3000) + "\n\n⚠️ This tool failed. Try a different approach or different tool. Do NOT repeat the exact same call.";
        messages.push({
          role: "tool",
          content: toolContent,
          tool_call_id: tc.id || tc.function?.name || "",
        });
      }
    }

    // Auto-expand: if model got no results and we used a filtered tool set,
    // retry once with ALL tools so Kate doesn't say "I can't" when she actually can
    if (!lastContent && totalToolCalls === 0 && tools.length < allTools.length) {
      log("🔓", "EXPAND", `Smart filter too narrow (${tools.length} tools) — retrying with all ${allTools.length}`, "33");
      const expandResponse = await this.callOllama(messages, allTools);
      if (expandResponse.content) {
        lastContent = expandResponse.content;
      }
      if (expandResponse.toolCalls?.length) {
        const callNames = expandResponse.toolCalls.map((tc: any) => tc.function?.name || "?").join(", ");
        log("🔧", "EXPAND TOOLS", callNames, "33");
        messages.push({ role: "assistant", content: expandResponse.content || "", tool_calls: expandResponse.toolCalls });
        for (const tc of expandResponse.toolCalls) {
          const fnName = tc.function?.name || "";
          const fnArgs = tc.function?.arguments || {};
          totalToolCalls++;
          const result = await this.executeTool(fnName, fnArgs, userId, "web");
          const success = !result.startsWith("Error:");
          log("  " + (success ? "✓" : "✗"), fnName, result.slice(0, 80), success ? "32" : "31");
          toolResults.push(result);
          messages.push({ role: "tool", content: result.slice(0, 4000), tool_call_id: tc.id || fnName });
        }
        // One more round to get the final text response
        const finalRound = await this.callOllama(messages, allTools);
        if (finalRound.content) lastContent = finalRound.content;
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

    // Always include tool results that contain structured data (tables, code, compile output)
    // The model tends to summarize these away — force them into the response
    if (toolResults.length > 0) {
      // Debug: log what tool results contain
      for (const r of toolResults) {
        if (r.length > 100) log("📊", "RESULT", `len=${r.length} hasMAC=${r.includes("MAC Address")} first80=${r.slice(0, 80)}`, "33");
      }
      // Force-include scan tables that have MAC addresses or structured data
      const tableResults = toolResults.filter(r =>
        r && r.length > 200 && !r.startsWith("Error:") &&
        (r.includes("MAC Address") || r.includes("lladdr") || r.includes("════") || r.includes("────"))
      );
      if (tableResults.length > 0) {
        // Strip any instruction lines and wrap in code block
        const cleanTable = tableResults.map(r => r.replace(/\nIMPORTANT:.*$/gm, "").replace(/\nSHOW THIS.*$/gm, "").trim()).join("\n\n");
        if (!finalResponse.includes("MAC") && !finalResponse.includes("lladdr")) {
          finalResponse = (finalResponse ? finalResponse + "\n\n" : "") + "```\n" + cleanTable + "\n```";
        }
      }

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

    // Cache this response for future identical queries (only cache tool-free responses)
    if (totalToolCalls === 0 && finalResponse) {
      this.cache.setResponse(
        messages.map(m => ({ role: m.role, content: m.content })),
        toolNames,
        finalResponse,
        Math.ceil(finalResponse.length / 4), // rough token estimate
      );
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

    // Update session — keep up to 40 raw messages (compression handles the rest)
    history.push({ role: "user", content: msg.content });
    history.push({ role: "assistant", content: finalResponse });
    if (history.length > 40) history.splice(0, history.length - 40);
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
