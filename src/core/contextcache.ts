import { createLogger } from "./logger.js";
import crypto from "node:crypto";

const log = createLogger("cache");

interface CacheEntry {
  hash: string;
  response: string;
  tokens: number;
  timestamp: number;
  hits: number;
  ttl: number;
}

interface PromptCache {
  systemPromptHash: string | null;
  toolsHash: string | null;
  lastToolDefs: string | null;
  lastSystemPrompt: string | null;
}

export class ContextCache {
  // Response cache — exact match on (system + tools + last N messages)
  private responseCache = new Map<string, CacheEntry>();
  
  // Prompt template cache — avoid re-serializing tools every call
  private promptCache: PromptCache = {
    systemPromptHash: null,
    toolsHash: null,
    lastToolDefs: null,
    lastSystemPrompt: null,
  };

  // Conversation summary cache — compress old messages
  private summaryCache = new Map<string, string>();

  private maxEntries: number;
  private defaultTTL: number;
  private stats = {
    hits: 0,
    misses: 0,
    tokensSaved: 0,
    promptCacheHits: 0,
  };

  constructor(maxEntries = 500, defaultTTL = 3600000) { // 1hr default TTL
    this.maxEntries = maxEntries;
    this.defaultTTL = defaultTTL;
  }

  // ── Hash helpers ─────────────────────────────────────────
  private hash(content: string): string {
    return crypto.createHash("md5").update(content).digest("hex").slice(0, 16);
  }

  // ── Response caching ─────────────────────────────────────
  
  // Check if we have a cached response for this exact conversation state
  getResponse(messages: Array<{ role: string; content: string }>, toolNames: string[]): string | null {
    const key = this.buildResponseKey(messages, toolNames);
    const entry = this.responseCache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.responseCache.delete(key);
      this.stats.misses++;
      return null;
    }

    entry.hits++;
    this.stats.hits++;
    this.stats.tokensSaved += entry.tokens;
    log.debug(`Cache HIT (${entry.hits} hits, saved ~${entry.tokens} tokens)`);
    return entry.response;
  }

  setResponse(
    messages: Array<{ role: string; content: string }>,
    toolNames: string[],
    response: string,
    tokens: number,
    ttl?: number,
  ): void {
    const key = this.buildResponseKey(messages, toolNames);

    // Evict oldest if full
    if (this.responseCache.size >= this.maxEntries) {
      let oldest: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.responseCache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldest = k;
        }
      }
      if (oldest) this.responseCache.delete(oldest);
    }

    this.responseCache.set(key, {
      hash: key,
      response,
      tokens,
      timestamp: Date.now(),
      hits: 0,
      ttl: ttl || this.defaultTTL,
    });
  }

  private buildResponseKey(messages: Array<{ role: string; content: string }>, toolNames: string[]): string {
    // Use last 3 messages + tool list for the key
    const recentMsgs = messages.slice(-3).map(m => `${m.role}:${m.content}`).join("|");
    const tools = toolNames.sort().join(",");
    return this.hash(recentMsgs + "||" + tools);
  }

  // ── System prompt caching ────────────────────────────────
  
  // Returns cached system prompt string if tools haven't changed
  getCachedSystemPrompt(tools: Array<{ name: string; description: string }>, buildFn: () => string): string {
    const toolsStr = tools.map(t => t.name).sort().join(",");
    const toolsHash = this.hash(toolsStr);

    if (toolsHash === this.promptCache.toolsHash && this.promptCache.lastSystemPrompt) {
      this.stats.promptCacheHits++;
      return this.promptCache.lastSystemPrompt;
    }

    // Rebuild
    const prompt = buildFn();
    this.promptCache.toolsHash = toolsHash;
    this.promptCache.lastSystemPrompt = prompt;
    this.promptCache.lastToolDefs = toolsStr;

    return prompt;
  }

  // ── Conversation compression ─────────────────────────────
  
  // Compress old messages into a summary to reduce token count
  compressConversation(
    messages: Array<{ role: string; content: string }>,
    keepRecent: number = 6,
  ): Array<{ role: string; content: string }> {
    if (messages.length <= keepRecent + 2) return messages;

    const oldMessages = messages.slice(0, messages.length - keepRecent);
    const recentMessages = messages.slice(-keepRecent);
    const summaryKey = this.hash(oldMessages.map(m => m.content).join(""));

    let summary = this.summaryCache.get(summaryKey);
    if (!summary) {
      // Build a compact summary of old messages
      const parts: string[] = [];
      for (const msg of oldMessages) {
        if (msg.role === "user") {
          parts.push(`User asked: ${msg.content.slice(0, 80)}`);
        } else if (msg.role === "assistant") {
          // Extract just tool calls and key info
          const toolCalls = msg.content.match(/\[Executing \w+/g);
          if (toolCalls) {
            parts.push(`Agent used: ${toolCalls.map(t => t.replace("[Executing ", "")).join(", ")}`);
          } else {
            parts.push(`Agent: ${msg.content.slice(0, 60)}`);
          }
        }
      }
      summary = parts.join("\n");
      this.summaryCache.set(summaryKey, summary);

      // Limit summary cache
      if (this.summaryCache.size > 100) {
        const first = this.summaryCache.keys().next().value;
        if (first) this.summaryCache.delete(first);
      }
    }

    return [
      { role: "user", content: `[Previous conversation summary]\n${summary}` },
      { role: "assistant", content: "Understood, I have context from our previous conversation." },
      ...recentMessages,
    ];
  }

  // ── Greetings / simple response cache ────────────────────
  
  // For trivial messages, return instant without hitting the LLM
  getQuickResponse(message: string): string | null {
    const msg = message.trim().toLowerCase();

    const greetings: Record<string, string> = {
      "hi": "Hey! What do you need me to do?",
      "hello": "Hey! Ready to work. What's the task?",
      "hey": "Hey! What should I do?",
      "yo": "Yo! What's up? Give me a task.",
      "sup": "Ready to go. What do you need?",
      "thanks": "No problem. Need anything else?",
      "thank you": "You're welcome. What's next?",
      "ok": "Standing by. What's next?",
      "okay": "Got it. Anything else?",
      "bye": "Later! I'll be here when you need me.",
      "quit": "Shutting down. Run `npx tsx src/cli.ts` to start again.",
      "ping": "Pong! 🏓 System is responsive.",
      "test": "I'm here and working. Give me a real task!",
      "status": "Online. 34 skills, 297 tools ready.",
      "help": "Just tell me what to do. Try: check system health, scan network, search github, clone a repo, create a backup.",
      "what can you do": "34 skills: Shell, Files, Git, Docker, SSH, MQTT, Web Search, GitHub, Network, Monitoring, Backup, CI/CD, Database, Code Analysis, Package Manager, API tools, Code Generator, Installer, Event Bus, Workers, and more.",
      "skills": "34 skills loaded with 297 tools. Click the Skills tab to browse them all.",
      "good morning": "Morning! What's the task?",
      "good night": "Night! Scheduled tasks keep running.",
      "list tools": "Click the Skills tab to see all 297 tools organized by skill.",
      "list skills": "Click the Skills tab. 34 skills loaded.",
      "who are you": "I'm Kate, your Kate AI agent. 34 skills, 297 tools. Local-first, no cloud. What do you need?",
      "worker status": "No workers running. Say 'spawn 3 workers' to start some.",
    };

    if (greetings[msg]) {
      this.stats.hits++;
      log.debug(`Quick response for: ${msg}`);
      return greetings[msg];
    }

    return null;
  }

  // ── Stats ────────────────────────────────────────────────

  getStats(): {
    hits: number;
    misses: number;
    hitRate: string;
    tokensSaved: number;
    cacheSize: number;
    promptCacheHits: number;
    summaries: number;
  } {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate: total > 0 ? `${((this.stats.hits / total) * 100).toFixed(1)}%` : "0%",
      cacheSize: this.responseCache.size,
      summaries: this.summaryCache.size,
    };
  }

  clear(): void {
    this.responseCache.clear();
    this.summaryCache.clear();
    this.promptCache = { systemPromptHash: null, toolsHash: null, lastToolDefs: null, lastSystemPrompt: null };
    log.info("Cache cleared");
  }
}

