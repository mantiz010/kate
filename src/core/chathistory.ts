import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HISTORY_DIR = path.join(os.homedir(), ".kate", "history");
const MAX_SESSIONS = 50;
const MAX_MSGS_PER_SESSION = 100;

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  tools?: number;
}

interface ChatSession {
  id: string;
  messages: ChatMessage[];
  created: number;
  updated: number;
  title: string;
}

function ensureDir() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

export function saveMessage(sessionId: string, role: "user" | "assistant", content: string, tools = 0): void {
  ensureDir();
  const file = path.join(HISTORY_DIR, sessionId + ".json");
  let session: ChatSession;

  try {
    session = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    session = { id: sessionId, messages: [], created: Date.now(), updated: Date.now(), title: "" };
  }

  session.messages.push({ role, content: content.slice(0, 2000), timestamp: Date.now(), tools });
  session.updated = Date.now();

  // Set title from first user message
  if (!session.title && role === "user") {
    session.title = content.slice(0, 80);
  }

  // Trim old messages
  if (session.messages.length > MAX_MSGS_PER_SESSION) {
    session.messages = session.messages.slice(-MAX_MSGS_PER_SESSION);
  }

  fs.writeFileSync(file, JSON.stringify(session));
}

export function getSession(sessionId: string): ChatSession | null {
  const file = path.join(HISTORY_DIR, sessionId + ".json");
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

export function listSessions(limit = 20): Array<{ id: string; title: string; updated: number; messageCount: number }> {
  ensureDir();
  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json"));
  const sessions = files.map(f => {
    try {
      const s: ChatSession = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf-8"));
      return { id: s.id, title: s.title, updated: s.updated, messageCount: s.messages.length };
    } catch { return null; }
  }).filter(Boolean) as Array<{ id: string; title: string; updated: number; messageCount: number }>;

  sessions.sort((a, b) => b.updated - a.updated);

  // Clean up old sessions
  if (sessions.length > MAX_SESSIONS) {
    for (const old of sessions.slice(MAX_SESSIONS)) {
      try { fs.unlinkSync(path.join(HISTORY_DIR, old.id + ".json")); } catch {}
    }
  }

  return sessions.slice(0, limit);
}

export function searchHistory(query: string, limit = 10): Array<{ sessionId: string; title: string; matches: string[] }> {
  ensureDir();
  const q = query.toLowerCase();
  const results: Array<{ sessionId: string; title: string; matches: string[] }> = [];

  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json"));
  for (const f of files) {
    try {
      const s: ChatSession = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf-8"));
      const matches = s.messages
        .filter(m => m.content.toLowerCase().includes(q))
        .map(m => m.content.slice(0, 100));
      if (matches.length > 0) {
        results.push({ sessionId: s.id, title: s.title, matches: matches.slice(0, 3) });
      }
    } catch {}
  }

  results.sort((a, b) => b.matches.length - a.matches.length);
  return results.slice(0, limit);
}
