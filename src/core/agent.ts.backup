import type {
  KateConfig, Message, MemoryStore, ProviderMessage,
  ToolCall, ToolResult, SkillContext, Logger,
} from "../core/types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { SkillManager } from "../skills/manager.js";
import { createLogger } from "../core/logger.js";
import { ContextCache } from "../core/contextcache.js";
import { saveMessage } from "../core/chathistory.js";
import { filterTools } from "../core/toolfilter.js";
import { recordSuccess, recordFailure, getRelevantLessons, getStats as getLearnerStats } from "../core/learner.js";
import { needsPlan, buildPlanPrompt } from "../core/planner.js";
import { eventBus, EVENTS } from "../core/eventbus.js";

// Fallback tools — if one fails, try another
const FALLBACK_TOOLS: Record<string, string[]> = {
  "part_search_online": ["part_search", "part_for_project"],
  "search": ["gh_search_repos", "fetch_page"],
  "gh_search_repos": ["search"],
  "net_scan": ["run_command"],
  "docker_ps": ["run_command"],
  "mqtt_publish": ["run_command"],
  "arduino_compile": ["run_command"],
};

let addActivity: any;
try {
  const mod = await import("../skills/scheduler.js");
  addActivity = mod.addActivity;
} catch {
  addActivity = () => {};
}

const MAX_TOOL_ROUNDS = 10;

interface ConversationState {
  messages: ProviderMessage[];
  userId: string;
  source: string;
}

function printLive(icon: string, label: string, msg: string, color: string = "36") {
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  console.log(`  \x1b[90m${ts}\x1b[0m \x1b[${color}m${icon} ${label}\x1b[0m ${msg}`);
}

export class Agent {
  private config: KateConfig;
  private providers: ProviderRegistry;
  private skills: SkillManager;
  private memory: MemoryStore;
  private conversations = new Map<string, ConversationState>();
  private log: Logger;
  private cache: ContextCache;
  private totalRequests = 0;
  private totalToolCalls = 0;
  private totalErrors = 0;

  constructor(
    config: KateConfig,
    providers: ProviderRegistry,
    skills: SkillManager,
    memory: MemoryStore,
  ) {
    this.config = config;
    this.providers = providers;
    this.skills = skills;
    this.memory = memory;
    this.log = createLogger("agent");
    this.cache = new ContextCache(500, 3600000);
  }

  async handleMessage(msg: Message): Promise<string> {
    const convKey = `${msg.source}:${msg.userId}`;
    const startTime = Date.now();
    this.totalRequests++;

    saveMessage(msg.sessionId || "default", "user", msg.content);
    printLive("▶", "INPUT", `"${msg.content.slice(0, 80)}${msg.content.length > 80 ? "..." : ""}"`, "33");
    addActivity({ type: "info", source: msg.source, message: `User: ${msg.content.slice(0, 80)}` });

    // ── Quick response cache (greetings bypass LLM entirely) ──
    const quickReply = this.cache.getQuickResponse(msg.content);
    if (quickReply) {
      const elapsed = Date.now() - startTime;
      printLive("⚡", "INSTANT", `${elapsed}ms (cached)`, "32");
      printLive("💬", "REPLY", quickReply, "36");
      addActivity({ type: "info", source: "cache", message: `Instant: ${quickReply.slice(0, 60)}` });
      console.log("");
      return quickReply;
    }

    // Get or create conversation
    let conv = this.conversations.get(convKey);
    if (!conv) {
      conv = { messages: [], userId: msg.userId, source: msg.source };
      this.conversations.set(convKey, conv);
      printLive("◆", "SESSION", `New: ${convKey}`, "90");
    }

    // Retrieve memories
    const memories = await this.memory.search(msg.content, msg.userId, 12);
    if (memories.length > 0) {
      printLive("◈", "MEMORY", `${memories.length} relevant`, "35");
      for (const m of memories.slice(0, 3)) {
        printLive("  ", "  ", `[${m.category}] ${m.key}: ${m.value.slice(0, 60)}`, "90");
      }
      addActivity({ type: "info", source: "memory", message: `Recalled ${memories.length} memories` });
    }

    // Always load key user info regardless of query
    const keyMemories = await this.memory.search("user network github preferences", msg.userId, 5);
    const allMemories = [...memories, ...keyMemories.filter(k => !memories.find(m => m.key === k.key))];
    const memoryContext = allMemories.length > 0
      ? `\n\nKnown context:\n${memories.map(m => `- [${m.category}] ${m.key}: ${m.value}`).join("\n")}`
      : "";

    conv.messages.push({ role: "user", content: msg.content });

    // ── Compress old messages to save tokens ───────────────
    if (conv.messages.length > 12) {
      const before = conv.messages.length;
      conv.messages = this.cache.compressConversation(conv.messages, 8);
      if (conv.messages.length < before) {
        printLive("📦", "COMPRESS", `${before} → ${conv.messages.length} messages`, "90");
      }
    }

    // ── Lessons from past experience ───────────────
    const lessons = getRelevantLessons(msg.content);
    if (lessons.length > 0) {
      printLive("🧠", "LEARNED", lessons.length + " relevant lessons", "35");
    }
    const lessonsContext = lessons.length > 0 ? "\nLessons:\n" + lessons.join("\n") : "";

    // ── Chain-of-thought for complex tasks ─────────
    let planContext = "";
    if (needsPlan(msg.content)) {
      printLive("📋", "PLANNING", "Complex task — thinking through steps first", "33");
      planContext = "\n\n" + buildPlanPrompt(msg.content);
    }

    // ── Smart tool filtering ───────────────────────────────
    // Smart tool hints — tell the model which tools to prefer

    const TOOL_HINTS: Array<{pattern: RegExp; hint: string}> = [
      { pattern: /parts? (for|do i need|list)|what parts|bom/i, hint: "Use part_for_project for project kits, part_search for specific parts. Do NOT use part_search_online (it is blocked)." },
      { pattern: /search|find|look/i, hint: "Use search for web results (GitHub+Wikipedia+StackOverflow). Use gh_search_repos for GitHub repos." },
      { pattern: /clone|download|install.*from/i, hint: "Use install_from_github to clone and setup projects." },
      { pattern: /list files|show files|directory/i, hint: "Use list_directory with the path." },
      { pattern: /read file|show file|cat /i, hint: "Use read_file with the file path." },
      { pattern: /remember|save|store/i, hint: "Use memorize to save information." },
      { pattern: /what do you know|recall|my (github|network)/i, hint: "Use recall to search memories." },
      { pattern: /scan.*network|find devices/i, hint: "Use net_scan with the network range." },
      { pattern: /system|health|cpu|memory|disk/i, hint: "Use system_info for system stats." },
      { pattern: /mqtt|publish|subscribe/i, hint: "Use mqtt_publish. Default broker: 172.168.1.8, user: mantiz010." },
      { pattern: /docker|container/i, hint: "Use docker_ps to list, docker_run to start." },
      { pattern: /git status|commit|push/i, hint: "Use git_status, git_commit, git_push." },
      { pattern: /review|improve|gap|optimize/i, hint: "Use self_review, self_analyze, self_optimize." },
      { pattern: /agent|delegate|team/i, hint: "Use agent_list, agent_spawn, agent_delegate, agent_team." },
      { pattern: /alternative|replace|substitute/i, hint: "Use part_alternatives." },
      { pattern: /etbus|et-bus|esp32 device/i, hint: "Use etbus_discover, etbus_command, etbus_switch." },
      { pattern: /worker|spawn|batch/i, hint: "Use worker_spawn (max 2 concurrent). Do NOT batch more than 3 tasks." },
    ];

    let toolHint = "";
    for (const h of TOOL_HINTS) {
      if (h.pattern.test(msg.content)) { toolHint = "\nTOOL HINT: " + h.hint; break; }
    }
    const hintContext = toolHint ? "\nHINT: " + toolHint : "";

    const allTools = this.skills.getAllTools();
    const skillToolMap = new Map<string, any[]>();
    for (const skill of this.skills.list()) {
      skillToolMap.set(skill.id, skill.tools);
    }
    const tools = filterTools(allTools, skillToolMap, msg.content);
    const provider = this.providers.get();

    printLive("🎯", "FILTER", `${tools.length}/${allTools.length} tools`, "90");

    // ── Check response cache ───────────────────────────────
    const toolNames = tools.map(t => t.name);
    const cached = this.cache.getResponse(conv.messages, toolNames);
    if (cached) {
      const elapsed = Date.now() - startTime;
      conv.messages.push({ role: "assistant", content: cached });
      printLive("⚡", "CACHED", `${elapsed}ms (saved LLM call)`, "32");
      printLive("💬", "REPLY", cached.replace(/\n/g, " ").slice(0, 80), "36");
      const s = this.cache.getStats();
      printLive("📊", "CACHE", `Rate: ${s.hitRate} | Saved: ~${s.tokensSaved} tokens`, "90");
      addActivity({ type: "info", source: "cache", message: `Hit: ${elapsed}ms` });
      console.log("");
      return cached;
    }

    // ── Build system prompt (cached if tools unchanged) ────
    const systemPrompt = this.cache.getCachedSystemPrompt(tools, () => this.buildSystemPrompt(memoryContext + hintContext + lessonsContext + planContext));

    printLive("⚡", "THINKING", `→ ${provider.name} (${tools.length} tools)`, "36");
    addActivity({ type: "info", source: "agent", message: `Thinking (${tools.length} tools)...` });

    // ── Call LLM ───────────────────────────────────────────
    let response = await provider.chat(conv.messages, {
      systemPrompt,
      tools: tools.length > 0 ? tools : undefined,
      temperature: 0.3,
    });

    let rounds = 0;
    let roundToolCalls = 0;

    // ── Agentic loop ───────────────────────────────────────
    while (response.toolCalls && response.toolCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      roundToolCalls += response.toolCalls.length;
      this.totalToolCalls += response.toolCalls.length;

      const tcNames = response.toolCalls.map(t => t.name);
      printLive("🔧", `ROUND ${rounds}`, `${response.toolCalls.length} tool(s): ${tcNames.join(", ")}`, "33");
      addActivity({ type: "tool", source: "agent", message: `Round ${rounds}: ${tcNames.join(", ")}` });

      for (const tc of response.toolCalls) {
        printLive("  →", tc.name, JSON.stringify(tc.arguments).slice(0, 120), "90");
        addActivity({ type: "tool", source: tc.name, message: `Args: ${JSON.stringify(tc.arguments).slice(0, 80)}` });
      }

      const results = await this.executeToolCalls(response.toolCalls, msg.userId, msg.source);

      for (const r of results) {
        if (r.success) {
          const p = r.result.replace(/\n/g, " ").slice(0, 100);
          printLive("  ✓", r.name, p, "32");
          addActivity({ type: "tool", source: r.name, message: `✓ ${p.slice(0, 80)}` });
        } else {
          printLive("  ✗", r.name, r.error || "error", "31");
          addActivity({ type: "error", source: r.name, message: `✗ ${(r.error || "").slice(0, 80)}` });
          this.totalErrors++;
        }
      }

      conv.messages.push({
        role: "assistant",
        content: (response.content ? response.content + "\n" : "") +
          response.toolCalls.map(tc => `[Executing ${tc.name}(${JSON.stringify(tc.arguments)})]`).join("\n"),
      });

      conv.messages.push({
        role: "user",
        content: results.map(r =>
          `[${r.name} ${r.success ? "OK" : "FAILED"}]: ${r.success ? r.result : `Error: ${r.error}`}`
        ).join("\n\n"),
      });

      printLive("⚡", "THINKING", `Round ${rounds} done...`, "36");
      response = await provider.chat(conv.messages, {
        systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        temperature: 0.3,
      });
    }

    conv.messages.push({ role: "assistant", content: response.content });

    // Cache non-tool responses
    const tokens = (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0);
    if (rounds === 0 && tokens > 0) {
      this.cache.setResponse(conv.messages, toolNames, response.content, tokens);
    }

    const elapsed = Date.now() - startTime;
    const tokStr = `${response.usage?.inputTokens || "?"}in/${response.usage?.outputTokens || "?"}out`;

    printLive("✔", "DONE", `${rounds} rounds, ${roundToolCalls} tools, ${elapsed}ms, ${tokStr}`, "32");
    printLive("📊", "STATS", `Req: ${this.totalRequests} | Tools: ${this.totalToolCalls} | Err: ${this.totalErrors} | Cache: ${this.cache.getStats().hitRate}`, "90");
    addActivity({ type: "info", source: "agent", message: `Done: ${rounds}r ${roundToolCalls}t ${elapsed}ms` });

    if (response.content && response.content.length > 10) {
      printLive("💬", "REPLY", response.content.replace(/\n/g, " ").slice(0, 80), "36");
    }

    console.log("");
    // Check if model leaked [Executing...] as text — try to run those tools
    let rawContent = response.content || "";
    const leakedCalls = [...rawContent.matchAll(/\[Executing (\w+)\(([\s\S]*?)\)\]/g)];
    
    if (leakedCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
      // Model tried to call tools via text — execute them
      const extraCalls = [];
      for (const m of leakedCalls) {
        try {
          const args = JSON.parse(m[2]);
          extraCalls.push({ id: "fix_" + Date.now(), name: m[1], arguments: args });
        } catch {}
      }
      if (extraCalls.length > 0) {
        const extraResults = await this.executeToolCalls(extraCalls, msg.userId, msg.source);
        roundToolCalls += extraCalls.length;
        // Use the tool results as the response
        const resultText = extraResults.map(r => r.success ? r.result : "Error: " + r.error).join("\n\n");
        conv.messages.push({ role: "assistant", content: resultText });
        return resultText;
      }
    }

    let finalResponse = rawContent.replace(/\[Executing [^\]]*\]/g, "").trim();
    if (!finalResponse && rounds > 0) {
      // Model returned empty text but tools ran — show the last tool results
      const lastResults = toolHistory.slice(-3).filter((r: any) => r.success && r.result).map((r: any) => r.result).join("\n\n");
      if (lastResults) {
        finalResponse = lastResults;
      } else {
        finalResponse = "Completed " + rounds + " round(s) with " + roundToolCalls + " tool(s) but got no useful output.";
      }
    }

    // If empty response and no tools used, auto-retry with direct action
    if (!finalResponse && rounds === 0) {
      const m = msg.content.toLowerCase();
      let autoTool = "";
      let autoArgs: Record<string, any> = {};

      if (m.includes("list") && (m.includes("vm") || m.includes("proxmox"))) { autoTool = "pve_vms"; autoArgs = {}; }
      else if (m.includes("node") && m.includes("proxmox")) { autoTool = "pve_nodes"; autoArgs = {}; }
      else if (m.includes("list") && (m.includes("file") || m.includes("dir") || m.includes("folder"))) { autoTool = "list_directory"; autoArgs = { path: m.includes("arduino") ? "/home/mantiz010/Arduino" : "~" }; }
      else if (m.includes("list") && m.includes("librar")) { autoTool = "list_directory"; autoArgs = { path: "/home/mantiz010/Arduino/libraries" }; }
      else if (m.includes("search") || m.includes("find")) { autoTool = "search"; autoArgs = { query: msg.content.replace(/search|find|for|me/gi, "").trim() }; }
      else if (m.includes("system") || m.includes("health") || m.includes("cpu") || m.includes("status")) { autoTool = "system_info"; autoArgs = {}; }
      else if (m.includes("part") && (m.includes("esp32") || m.includes("zigbee") || m.includes("sensor"))) { autoTool = "part_for_project"; autoArgs = { project: "esp32-zigbee" }; }
      else if (m.includes("docker") || m.includes("container")) { autoTool = "docker_ps"; autoArgs = {}; }
      else if (m.includes("remember") || m.includes("what do you know")) { autoTool = "recall"; autoArgs = { query: msg.content }; }
      else if (m.includes("scan") && m.includes("network")) { autoTool = "net_scan"; autoArgs = { range: "172.168.1.0/24" }; }
      else if (m.includes("mqtt") || m.includes("publish")) { autoTool = "mqtt_publish"; autoArgs = { topic: "kate/test", message: msg.content }; }
      else if (m.includes("create") || m.includes("make") || m.includes("build") || m.includes("write") || m.includes("sketch") || m.includes("arduino")) {
        // For creation tasks, use run_command to delegate
        autoTool = "run_command";
        autoArgs = { command: "echo 'Task: " + msg.content.replace(/'/g, "") + "' && echo 'Use skill_create, arduino_new, gen_project, or write_file to create content.'" };
      }

      if (autoTool) {
        printLive("🔄", "AUTO-RETRY", "Empty response — auto-calling " + autoTool, "33");
        try {
          const result = await this.skills.executeTool(autoTool, autoArgs);
          if (result) finalResponse = result;
        } catch (e: any) {
          printLive("  ", "✗", "Auto-retry failed: " + e.message, "31");
        }
      }
    }

    if (!finalResponse) finalResponse = "I tried but got an empty response. Try rephrasing, or use a specific command like: list files in ~/Arduino, or search for ESP32 projects.";
  }

  private async executeToolCalls(calls: ToolCall[], userId: string, source: string): Promise<ToolResult[]> {
    const ctx: SkillContext = {
      userId, source, memory: this.memory, config: this.config, log: this.log,
    };
    const promises = calls.map(async (call) => {
      const t0 = Date.now();
      try {
        const result = await this.skills.executeTool(call.name, call.arguments, ctx);
        printLive("  ⏱", call.name, `${Date.now() - t0}ms`, "90");
        eventBus.fire(EVENTS.TOOL_SUCCESS, call.name, { toolName: call.name, elapsed: Date.now() - t0, resultLen: result.length });
        recordSuccess(call.name, JSON.stringify(call.arguments).slice(0, 150), result.slice(0, 150));
        return { callId: call.id, name: call.name, result, success: true } as ToolResult;
      } catch (err: any) {
        printLive("  ⏱", call.name, `${Date.now() - t0}ms (FAIL)`, "31");
        eventBus.fire(EVENTS.TOOL_FAIL, call.name, { toolName: call.name, error: err.message, elapsed: Date.now() - t0 });
        recordFailure(call.name, JSON.stringify(call.arguments).slice(0, 150), err.message);
        // Try fallback tool
        const fallbacks = FALLBACK_TOOLS[call.name] || [];
        for (const fb of fallbacks) {
          try {
            const fbResult = await this.skills.executeTool(fb, call.arguments);
            if (fbResult) {
              recordSuccess(fb, JSON.stringify(call.arguments).slice(0, 150), fbResult.slice(0, 150));
              printLive("  ", "🔄", call.name + " failed, used " + fb + " instead", "33");
              return { callId: call.id, name: fb, result: fbResult, success: true } as ToolResult;
            }
          } catch {}
        }
        recordFailure(call.name, JSON.stringify(call.arguments).slice(0, 150), err.message);
        return { callId: call.id, name: call.name, result: "", success: false, error: err.message } as ToolResult;
      }
    });
    return (await Promise.allSettled(promises)).map(s =>
      s.status === "fulfilled" ? s.value :
      { callId: "?", name: "unknown", result: "", success: false, error: s.reason?.message || "Unknown" }
    );
  }

  private buildSystemPrompt(memoryContext: string): string {
    const name = this.config.agent.name;
    const skills = this.skills.list();
    const toolNames = skills.map(s => s.name + ": " + s.tools.map(t => t.name).join(", ")).join("\n");
    return "You are " + name + ", an AI agent that controls a homelab.\n\n" +
      "UNDERSTAND THE USER — they speak casually. Map their words to the right tool:\n" +
      "- \"list VMs\" or \"show my VMs\" or \"proxmox\" → pve_vms\n" +
      "- \"list nodes\" or \"show nodes\" → pve_nodes\n" +
      "- \"start VM 100\" → pve_vm_start\n" +
      "- \"list files\" or \"show files\" or \"whats in\" → list_directory\n" +
      "- \"read file\" or \"show me\" or \"cat\" → read_file\n" +
      "- \"search\" or \"find\" or \"look up\" → search\n" +
      "- \"parts for\" or \"what parts\" or \"bom\" → part_for_project\n" +
      "- \"my arduino\" or \"libraries\" → list_directory with /home/mantiz010/Arduino\n" +
      "- \"clone\" or \"download repo\" → install_from_github\n" +
      "- \"system health\" or \"cpu\" or \"memory\" → system_info\n" +
      "- \"docker\" or \"containers\" → docker_ps\n" +
      "- \"mqtt\" or \"publish\" → mqtt_publish (broker: 172.168.1.8)\n" +
      "- \"scan network\" → net_scan\n" +
      "- \"remember\" or \"save\" → memorize\n" +
      "- \"what do you know\" → recall\n" +
      "- \"agents\" or \"delegate\" → agent_list or agent_delegate\n" +
      "- \"review yourself\" → self_review\n" +
      "- \"etbus\" or \"discover devices\" → etbus_discover\n" +
      "- \"snapshot\" or \"backup vm\" → pve_snapshot\n" +
      "\nRULES:\n" +
      "1. ALWAYS use a tool. Never reply with just text.\n" +
      "2. Never say [Executing] — call the tool.\n" +
      "3. Never ask permission. Just do it.\n" +
      "4. If unsure, use run_command with a shell command.\n" +
      "5. Arduino sketchbook: /home/mantiz010/Arduino\n" +
      "6. Proxmox: 172.168.1.204 (token pre-configured)\n" +
      "7. Home Assistant: 172.168.1.8\n" +
      "8. Ollama: 172.168.1.162\n" +
      "9. ESP Boards: ESP8266=WiFi, ESP32=WiFi+BT, ESP32-S2=WiFi, ESP32-S3=WiFi+BLE+USB, ESP32-C3=WiFi+BLE(RISC-V), ESP32-C6=WiFi6+BLE+Zigbee+Thread, ESP32-H2=BLE+Zigbee(NO WiFi). Only C6 and H2 do Zigbee.\n" +
      "10. ALWAYS check ~/Arduino/libraries before installing. User has 145 libraries including: AGS02MA, Adafruit-HX8340B, Adafruit-MCP23017, Adafruit-ST7735, Adafruit_ADS1X15, Adafruit_AHT10, Adafruit_AHTX0, Adafruit_BME280, Adafruit_BME680, Adafruit_BMP085, Adafruit_BMP280, Adafruit_BusIO, Adafruit_GFX_Library, Adafruit_ILI9340, Adafruit_ILI9341, Adafruit_INA219, Adafruit_MAX31865, Adafruit_NeoPixel, Adafruit_SGP30_Sensor, Adafruit_SH110X\n" +
      "9. ESP Boards: ESP8266=WiFi, ESP32=WiFi+BT, ESP32-S2=WiFi, ESP32-S3=WiFi+BLE+USB, ESP32-C3=WiFi+BLE(RISC-V), ESP32-C6=WiFi6+BLE+Zigbee+Thread, ESP32-H2=BLE+Zigbee(NO WiFi). Only C6 and H2 do Zigbee.\n" +
      "10. ALWAYS check ~/Arduino/libraries before installing. User has 145 libraries including: AGS02MA, Adafruit-HX8340B, Adafruit-MCP23017, Adafruit-ST7735, Adafruit_ADS1X15, Adafruit_AHT10, Adafruit_AHTX0, Adafruit_BME280, Adafruit_BME680, Adafruit_BMP085, Adafruit_BMP280, Adafruit_BusIO, Adafruit_GFX_Library, Adafruit_ILI9340, Adafruit_ILI9341, Adafruit_INA219, Adafruit_MAX31865, Adafruit_NeoPixel, Adafruit_SGP30_Sensor, Adafruit_SH110X\n" +
      "\nTools:\n" + toolNames + (memoryContext ? "\n\nMemory:\n" + memoryContext : "");
  }

  clearConversation(userId: string, source: string): void {
    this.conversations.delete(`${source}:${userId}`);
    printLive("🗑", "CLEAR", `${source}:${userId}`, "33");
  }

  getCacheStats() { return this.cache.getStats(); }
}

