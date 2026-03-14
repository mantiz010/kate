import type { Skill, SkillContext } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const log = createLogger("history");
const HISTORY_DIR = path.join(os.homedir(), ".aegis", "conversations");

interface ConvMessage { role: string; content: string; timestamp: number; }
interface Conversation { id: string; title: string; source: string; userId: string; messages: ConvMessage[]; created: number; updated: number; }

function ensureDir() { if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true }); }

function getConvPath(id: string) { return path.join(HISTORY_DIR, `${id}.json`); }

function loadConv(id: string): Conversation | null {
  const p = getConvPath(id);
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null; } catch { return null; }
}

function saveConv(conv: Conversation) {
  ensureDir();
  fs.writeFileSync(getConvPath(conv.id), JSON.stringify(conv, null, 2));
}

function listConvs(): Array<{ id: string; title: string; messages: number; updated: number }> {
  ensureDir();
  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json"));
  return files.map(f => {
    try {
      const conv = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf-8"));
      return { id: conv.id, title: conv.title, messages: conv.messages?.length || 0, updated: conv.updated || 0 };
    } catch { return null; }
  }).filter(Boolean).sort((a: any, b: any) => b.updated - a.updated) as any;
}

// Generate title from first user message
function autoTitle(messages: ConvMessage[]): string {
  const first = messages.find(m => m.role === "user");
  if (!first) return "Untitled";
  return first.content.slice(0, 50).replace(/\n/g, " ") + (first.content.length > 50 ? "..." : "");
}

// ── Public API for agent to call ──────────────────────────────
export function saveMessage(convId: string, role: string, content: string, source: string, userId: string) {
  ensureDir();
  let conv = loadConv(convId);
  if (!conv) {
    conv = { id: convId, title: "", source, userId, messages: [], created: Date.now(), updated: Date.now() };
  }
  conv.messages.push({ role, content, timestamp: Date.now() });
  conv.updated = Date.now();
  if (!conv.title) conv.title = autoTitle(conv.messages);
  saveConv(conv);
}

export function getConversation(convId: string): Conversation | null {
  return loadConv(convId);
}

const history: Skill = {
  id: "builtin.history",
  name: "Conversations",
  description: "Persistent conversation history — survives restarts, searchable, exportable. Never lose context again.",
  version: "1.0.0",
  tools: [
    { name: "history_list", description: "List recent conversations", parameters: [
      { name: "limit", type: "number", description: "Max conversations (default: 20)", required: false },
    ]},
    { name: "history_view", description: "View a specific conversation", parameters: [
      { name: "id", type: "string", description: "Conversation ID", required: true },
      { name: "last", type: "number", description: "Show only last N messages", required: false },
    ]},
    { name: "history_search", description: "Search across all conversations", parameters: [
      { name: "query", type: "string", description: "Search text", required: true },
      { name: "limit", type: "number", description: "Max results (default: 10)", required: false },
    ]},
    { name: "history_export", description: "Export a conversation to markdown file", parameters: [
      { name: "id", type: "string", description: "Conversation ID", required: true },
      { name: "output", type: "string", description: "Output file path", required: true },
    ]},
    { name: "history_delete", description: "Delete a conversation", parameters: [
      { name: "id", type: "string", description: "Conversation ID", required: true },
    ]},
    { name: "history_stats", description: "Show conversation statistics", parameters: [] },
    { name: "history_resume", description: "Load context from a previous conversation for the current session", parameters: [
      { name: "id", type: "string", description: "Conversation ID to resume", required: true },
    ]},
    { name: "history_clear_all", description: "Delete ALL conversation history", parameters: [
      { name: "confirm", type: "boolean", description: "Must be true", required: true },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    ensureDir();

    switch (toolName) {
      case "history_list": {
        const limit = (args.limit as number) || 20;
        const convs = listConvs().slice(0, limit);
        if (convs.length === 0) return "No conversation history.";
        return convs.map(c => {
          const time = new Date(c.updated).toLocaleString();
          return `  [${c.id}] ${c.title}\n    Messages: ${c.messages} | Updated: ${time}`;
        }).join("\n\n");
      }

      case "history_view": {
        const conv = loadConv(args.id as string);
        if (!conv) return `Conversation not found: ${args.id}`;
        const last = args.last as number;
        const msgs = last ? conv.messages.slice(-last) : conv.messages;
        return [
          `Conversation: ${conv.title}`,
          `ID: ${conv.id} | Messages: ${conv.messages.length} | Created: ${new Date(conv.created).toLocaleString()}`,
          "",
          ...msgs.map(m => {
            const t = new Date(m.timestamp).toLocaleTimeString();
            return `[${t}] ${m.role}: ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`;
          }),
        ].join("\n");
      }

      case "history_search": {
        const query = (args.query as string).toLowerCase();
        const limit = (args.limit as number) || 10;
        const results: Array<{ convId: string; title: string; message: string; role: string; time: number }> = [];

        for (const file of fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json"))) {
          try {
            const conv: Conversation = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), "utf-8"));
            for (const msg of conv.messages) {
              if (msg.content.toLowerCase().includes(query)) {
                results.push({
                  convId: conv.id, title: conv.title,
                  message: msg.content.slice(0, 100), role: msg.role, time: msg.timestamp,
                });
                if (results.length >= limit) break;
              }
            }
          } catch {}
          if (results.length >= limit) break;
        }

        if (results.length === 0) return `No results for: ${query}`;
        return results.map(r => {
          const t = new Date(r.time).toLocaleString();
          return `  [${r.convId}] ${r.title}\n    ${r.role} (${t}): ${r.message}`;
        }).join("\n\n");
      }

      case "history_export": {
        const conv = loadConv(args.id as string);
        if (!conv) return `Conversation not found: ${args.id}`;
        const output = (args.output as string).replace("~", os.homedir());

        const md = [
          `# ${conv.title}`,
          `Created: ${new Date(conv.created).toLocaleString()}`,
          `Messages: ${conv.messages.length}`,
          "",
          ...conv.messages.map(m => {
            const t = new Date(m.timestamp).toLocaleTimeString();
            const label = m.role === "user" ? "**You**" : "**Kate**";
            return `### ${label} (${t})\n\n${m.content}\n`;
          }),
        ].join("\n");

        fs.writeFileSync(output, md);
        return `Exported: ${output} (${md.length} chars)`;
      }

      case "history_delete": {
        const p = getConvPath(args.id as string);
        if (fs.existsSync(p)) { fs.unlinkSync(p); return `Deleted: ${args.id}`; }
        return `Not found: ${args.id}`;
      }

      case "history_stats": {
        const convs = listConvs();
        const totalMsgs = convs.reduce((a, c) => a + c.messages, 0);
        const totalSize = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json")).reduce((a, f) => a + fs.statSync(path.join(HISTORY_DIR, f)).size, 0);
        return [
          "Conversation History Stats",
          `  Conversations: ${convs.length}`,
          `  Total messages: ${totalMsgs}`,
          `  Storage: ${(totalSize / 1024).toFixed(1)}KB`,
          `  Oldest: ${convs.length > 0 ? new Date(convs[convs.length - 1].updated).toLocaleString() : "—"}`,
          `  Newest: ${convs.length > 0 ? new Date(convs[0].updated).toLocaleString() : "—"}`,
        ].join("\n");
      }

      case "history_resume": {
        const conv = loadConv(args.id as string);
        if (!conv) return `Not found: ${args.id}`;
        const last = conv.messages.slice(-10);
        const summary = last.map(m => `${m.role}: ${m.content.slice(0, 80)}`).join("\n");
        return `Loaded conversation: ${conv.title}\n\nRecent context:\n${summary}\n\nYou can continue from where you left off.`;
      }

      case "history_clear_all": {
        if (!(args.confirm as boolean)) return "Set confirm=true.";
        const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json"));
        for (const f of files) fs.unlinkSync(path.join(HISTORY_DIR, f));
        return `Deleted ${files.length} conversations.`;
      }

      default: return `Unknown: ${toolName}`;
    }
  },
};
export default history;

