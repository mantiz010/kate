import { createLogger } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const log = createLogger("learner");
const LEARN_FILE = path.join(os.homedir(), ".kate", "learnings.json");

interface Learning {
  id: string;
  type: "success" | "failure" | "preference" | "pattern";
  tool: string;
  input: string;
  outcome: string;
  lesson: string;
  timestamp: number;
  useCount: number;
}

let learnings: Learning[] = [];

function load() {
  try { if (fs.existsSync(LEARN_FILE)) learnings = JSON.parse(fs.readFileSync(LEARN_FILE, "utf-8")); } catch {}
}

function save() {
  const d = path.dirname(LEARN_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(LEARN_FILE, JSON.stringify(learnings.slice(-500), null, 2));
}

export function recordSuccess(tool: string, input: string, result: string) {
  load();
  learnings.push({
    id: "l-" + Date.now(),
    type: "success",
    tool, input: input.slice(0, 200), outcome: result.slice(0, 200),
    lesson: "Tool " + tool + " works for: " + input.slice(0, 80),
    timestamp: Date.now(), useCount: 1,
  });
  save();
}

export function recordFailure(tool: string, input: string, error: string) {
  load();
  // Check if we already know this failure
  const existing = learnings.find(l => l.type === "failure" && l.tool === tool && l.outcome === error.slice(0, 100));
  if (existing) {
    existing.useCount++;
    existing.timestamp = Date.now();
  } else {
    learnings.push({
      id: "l-" + Date.now(),
      type: "failure",
      tool, input: input.slice(0, 200), outcome: error.slice(0, 200),
      lesson: "AVOID: " + tool + " fails when: " + error.slice(0, 80),
      timestamp: Date.now(), useCount: 1,
    });
  }
  save();
}

export function getRelevantLessons(message: string, limit = 5): string[] {
  load();
  if (learnings.length === 0) return [];

  const msg = message.toLowerCase();
  const scored = learnings.map(l => {
    let score = 0;
    const words = msg.split(/\s+/);
    for (const w of words) {
      if (w.length < 3) continue;
      if (l.input.toLowerCase().includes(w)) score += 2;
      if (l.tool.toLowerCase().includes(w)) score += 3;
      if (l.lesson.toLowerCase().includes(w)) score += 1;
    }
    // Boost failures (more important to avoid mistakes)
    if (l.type === "failure") score *= 1.5;
    // Boost recent
    const age = (Date.now() - l.timestamp) / 86400000;
    if (age < 1) score *= 2;
    else if (age < 7) score *= 1.5;
    // Boost frequently hit
    score += Math.min(l.useCount, 5) * 0.5;
    return { learning: l, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(s => {
    if (s.learning.type === "failure") return "WARNING: " + s.learning.lesson;
    return "TIP: " + s.learning.lesson;
  });
}

export function getStats(): { total: number; successes: number; failures: number; topTools: string[] } {
  load();
  const toolCount: Record<string, number> = {};
  let successes = 0, failures = 0;
  for (const l of learnings) {
    if (l.type === "success") successes++;
    if (l.type === "failure") failures++;
    toolCount[l.tool] = (toolCount[l.tool] || 0) + 1;
  }
  const topTools = Object.entries(toolCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => t + "(" + c + ")");
  return { total: learnings.length, successes, failures, topTools };
}

export function getLearnings(): Learning[] { load(); return learnings; }
