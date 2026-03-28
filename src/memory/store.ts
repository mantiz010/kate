import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import type { MemoryStore, MemoryEntry, Logger } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import path from "node:path";
import fs from "node:fs";

export class SQLiteMemory implements MemoryStore {
  private db: any;
  private log: Logger;

  constructor(dbPath: string) {
    this.log = createLogger("memory");

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Lazy-load better-sqlite3
    this.initDb(dbPath);
  }

  private initDb(dbPath: string) {
    try {
      // Dynamic import workaround for better-sqlite3
      const Database = require("better-sqlite3");
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'fact',
          user_id TEXT NOT NULL,
          importance REAL NOT NULL DEFAULT 0.5,
          created_at INTEGER NOT NULL,
          last_accessed INTEGER NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key, user_id);
        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category, user_id);
        CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
        CREATE INDEX IF NOT EXISTS idx_memories_recent ON memories(last_accessed DESC);
      `);

      this.log.info(`Memory database initialized: ${dbPath}`);
    } catch (err) {
      this.log.warn("SQLite not available, falling back to in-memory store");
      this.db = null;
    }
  }

  async set(key: string, value: string, category: string, userId: string, importance = 0.5): Promise<void> {
    if (!this.db) return;

    const now = Date.now();
    const id = `mem_${now}_${Math.random().toString(36).slice(2, 8)}`;

    this.db.prepare(`
      INSERT INTO memories (id, key, value, category, user_id, importance, created_at, last_accessed, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        value = excluded.value,
        importance = excluded.importance,
        last_accessed = excluded.last_accessed
    `).run(id, key, value, category, userId, importance, now, now);
  }

  async get(key: string, userId: string): Promise<MemoryEntry | null> {
    if (!this.db) return null;

    const row = this.db.prepare(
      "SELECT * FROM memories WHERE key = ? AND user_id = ? ORDER BY last_accessed DESC LIMIT 1"
    ).get(key, userId);

    if (!row) return null;

    // Bump access
    this.db.prepare(
      "UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?"
    ).run(Date.now(), row.id);

    return this.rowToEntry(row);
  }

  async search(query: string, userId: string, limit = 10): Promise<MemoryEntry[]> {
    if (!this.db) return [];
    const stopWords = new Set(["what","does","my","the","a","an","is","are","do","how","which","where","when","who","have","has","can","will","about","your","this","that","with","for","and","or","in","on","to","of","it","i","me","we","you"]);
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !stopWords.has(t));
    if (terms.length === 0) return [];
    const conditions = terms.map(() => "(LOWER(key) LIKE ? OR LOWER(value) LIKE ?)").join(" OR ");
    const params: string[] = [];
    for (const term of terms) { params.push(`%${term}%`, `%${term}%`); }
    params.push(userId);
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE ${conditions} AND user_id = ? ORDER BY importance DESC LIMIT ?
    `).all(...params, limit * 3) as any[];
    const queryLower = query.toLowerCase();
    const scored = rows.map(r => {
      const keyLower = (r.key || "").toLowerCase();
      const valLower = (r.value || "").toLowerCase();
      let score = r.importance * 0.3;
      if (keyLower.includes(queryLower)) score += 2.0;
      if (valLower.includes(queryLower)) score += 1.5;
      for (const term of terms) {
        if (keyLower.includes(term)) score += 0.5;
        if (valLower.includes(term)) score += 0.3;
        if (keyLower.split(/\s+/).includes(term)) score += 0.3;
      }
      const daysSince = (Date.now() - r.last_accessed) / 86400000;
      score += 0.2 / (1 + daysSince);
      score += Math.min(r.access_count, 10) / 10 * 0.2;
      return { row: r, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => this.rowToEntry(s.row));
  }
  async getByCategory(category: string, userId: string, limit = 20): Promise<MemoryEntry[]> {
    if (!this.db) return [];

    const rows = this.db.prepare(
      "SELECT * FROM memories WHERE category = ? AND user_id = ? ORDER BY importance DESC, last_accessed DESC LIMIT ?"
    ).all(category, userId, limit);

    return rows.map((r: any) => this.rowToEntry(r));
  }

  async getRecent(userId: string, limit = 20): Promise<MemoryEntry[]> {
    if (!this.db) return [];

    const rows = this.db.prepare(
      "SELECT * FROM memories WHERE user_id = ? ORDER BY last_accessed DESC LIMIT ?"
    ).all(userId, limit);

    return rows.map((r: any) => this.rowToEntry(r));
  }

  async delete(key: string, userId: string): Promise<void> {
    if (!this.db) return;
    this.db.prepare("DELETE FROM memories WHERE key = ? AND user_id = ?").run(key, userId);
  }

  async clear(userId: string): Promise<void> {
    if (!this.db) return;
    this.db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
    this.log.info(`Cleared all memories for user: ${userId}`);
  }

  getStats(userId: string): { total: number; categories: Record<string, number> } {
    if (!this.db) return { total: 0, categories: {} };

    const total = this.db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE user_id = ?"
    ).get(userId)?.count || 0;

    const cats = this.db.prepare(
      "SELECT category, COUNT(*) as count FROM memories WHERE user_id = ? GROUP BY category"
    ).all(userId);

    const categories: Record<string, number> = {};
    for (const cat of cats) categories[(cat as any).category] = (cat as any).count;

    return { total, categories };
  }

  private rowToEntry(row: any): MemoryEntry {
    return {
      id: row.id,
      key: row.key,
      value: row.value,
      category: row.category,
      userId: row.user_id,
      importance: row.importance,
      createdAt: row.created_at,
      lastAccessed: row.last_accessed,
      accessCount: row.access_count,
    };
  }
}

// ── Fallback in-memory store ───────────────────────────────────
export class InMemoryStore implements MemoryStore {
  private store = new Map<string, MemoryEntry>();

  async set(key: string, value: string, category: string, userId: string, importance = 0.5) {
    const id = `${userId}:${key}`;
    this.store.set(id, {
      id, key, value, category, userId, importance,
      createdAt: Date.now(), lastAccessed: Date.now(), accessCount: 0,
    });
  }

  async get(key: string, userId: string) {
    return this.store.get(`${userId}:${key}`) || null;
  }

  async search(query: string, userId: string, limit = 10) {
    const q = query.toLowerCase();
    return [...this.store.values()]
      .filter(e => e.userId === userId && (e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)))
      .slice(0, limit);
  }

  async getByCategory(category: string, userId: string, limit = 20) {
    return [...this.store.values()]
      .filter(e => e.userId === userId && e.category === category)
      .slice(0, limit);
  }

  async getRecent(userId: string, limit = 20) {
    return [...this.store.values()]
      .filter(e => e.userId === userId)
      .sort((a, b) => b.lastAccessed - a.lastAccessed)
      .slice(0, limit);
  }

  async delete(key: string, userId: string) { this.store.delete(`${userId}:${key}`); }
  async clear(userId: string) {
    for (const [k, v] of this.store) if (v.userId === userId) this.store.delete(k);
  }
}

