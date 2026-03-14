import { z } from "zod";

// ── Identity ───────────────────────────────────────────────────
export interface AgentIdentity {
  name: string;
  personality: string;
  systemPrompt: string;
}

// ── Messages ───────────────────────────────────────────────────
export type Role = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  source: string;           // "telegram", "discord", "cli", etc.
  userId: string;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  messages: Message[];
  userId: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

// ── Tool / Skill system ────────────────────────────────────────
export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  result: string;
  success: boolean;
  error?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  tools: ToolDefinition[];
  execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string>;
  onLoad?(): Promise<void>;
  onUnload?(): Promise<void>;
}

export interface SkillContext {
  userId: string;
  source: string;
  memory: MemoryStore;
  config: KateConfig;
  log: Logger;
}

// ── Memory ─────────────────────────────────────────────────────
export interface MemoryEntry {
  id: string;
  key: string;
  value: string;
  category: string;       // "fact", "preference", "context", "task"
  userId: string;
  importance: number;      // 0-1
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
}

export interface MemoryStore {
  set(key: string, value: string, category: string, userId: string, importance?: number): Promise<void>;
  get(key: string, userId: string): Promise<MemoryEntry | null>;
  search(query: string, userId: string, limit?: number): Promise<MemoryEntry[]>;
  getByCategory(category: string, userId: string, limit?: number): Promise<MemoryEntry[]>;
  getRecent(userId: string, limit?: number): Promise<MemoryEntry[]>;
  delete(key: string, userId: string): Promise<void>;
  clear(userId: string): Promise<void>;
}

// ── Provider (LLM) ────────────────────────────────────────────
export interface ProviderMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ProviderOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  systemPrompt?: string;
}

export interface ProviderResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  model: string;
  finishReason: string;
}

export interface Provider {
  name: string;
  models: string[];
  defaultModel: string;
  chat(messages: ProviderMessage[], options?: ProviderOptions): Promise<ProviderResponse>;
  isAvailable(): Promise<boolean>;
}

// ── Integration (chat platforms) ───────────────────────────────
export interface Integration {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(userId: string, content: string): Promise<void>;
  onMessage(handler: (msg: Message) => Promise<void>): void;
}

// ── Config ─────────────────────────────────────────────────────
export const KateConfigSchema = z.object({
  agent: z.object({
    name: z.string().default("Kate"),
    personality: z.string().default("Professional, helpful, and proactive personal AI assistant."),
    systemPrompt: z.string().optional(),
  }).default({}),
  provider: z.object({
    default: z.enum(["ollama", "router", "anthropic", "openai"]).default("ollama"),
    anthropic: z.object({
      apiKey: z.string().optional(),
      model: z.string().default("claude-sonnet-4-20250514"),
    }).default({}),
    openai: z.object({
      apiKey: z.string().optional(),
      model: z.string().default("gpt-4o"),
    }).default({}),
    ollama: z.object({
      baseUrl: z.string().default("http://172.168.1.162:11434"),
      model: z.string().default("llama3.1"),
    }).default({}),
  }).default({}),
  integrations: z.object({
    telegram: z.object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      allowedUsers: z.array(z.string()).default([]),
    }).default({}),
    discord: z.object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      allowedUsers: z.array(z.string()).default([]),
    }).default({}),
  }).default({}),
  memory: z.object({
    enabled: z.boolean().default(true),
    dbPath: z.string().default("~/.aegis/memory.db"),
    maxEntries: z.number().default(10000),
  }).default({}),
  skills: z.object({
    directory: z.string().default("~/.aegis/skills"),
    builtin: z.array(z.string()).default(["shell", "files", "web", "memory", "browser", "scheduler", "pcb", "arduino", "workers", "skillforge", "router", "git", "codeanalysis", "packages", "monitoring", "apibuilder", "cicd", "autohealer", "agentcomm", "websearch", "github", "docs", "downloads", "apitester", "docker", "ssh", "database", "network", "backup", "mqtt", "services", "codegen", "installer", "events"]),
  }).default({}),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    file: z.string().optional(),
  }).default({}),
});

export type KateConfig = z.infer<typeof KateConfigSchema>;

// ── Logger ─────────────────────────────────────────────────────
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

