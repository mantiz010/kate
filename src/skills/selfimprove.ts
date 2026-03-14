import type { Skill, SkillContext } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const log = createLogger("selfimprove");
const KATE_DIR = path.join(os.homedir(), ".kate");
const LEARN_FILE = path.join(KATE_DIR, "learnings.json");
const GAPS_FILE = path.join(KATE_DIR, "capability-gaps.json");

interface Gap {
  id: string;
  description: string;
  detectedFrom: string;
  suggestedTool: string;
  status: "open" | "fixed" | "wontfix";
  created: number;
}

let gaps: Gap[] = [];
function loadGaps() { try { if (fs.existsSync(GAPS_FILE)) gaps = JSON.parse(fs.readFileSync(GAPS_FILE, "utf-8")); } catch {} }
function saveGaps() { if (!fs.existsSync(KATE_DIR)) fs.mkdirSync(KATE_DIR, { recursive: true }); fs.writeFileSync(GAPS_FILE, JSON.stringify(gaps, null, 2)); }

const selfimprove: Skill = {
  id: "builtin.selfimprove",
  name: "Self-Improve",
  description: "Kate reviews her own errors, identifies capability gaps, creates new tools to fill them, and improves over time. Self-evolution engine.",
  version: "1.0.0",
  tools: [
    { name: "self_review", description: "Review recent errors and failures, identify patterns, suggest improvements", parameters: [] },
    { name: "self_gaps", description: "List identified capability gaps — things Kate can't do yet but should", parameters: [] },
    { name: "self_add_gap", description: "Record a capability gap — something Kate should be able to do", parameters: [
      { name: "description", type: "string", description: "What Kate can't do", required: true },
      { name: "suggestedTool", type: "string", description: "Tool name that would fix this", required: false },
    ]},
    { name: "self_fix_gap", description: "Create a new tool/skill to fix an identified gap", parameters: [
      { name: "gapId", type: "string", description: "Gap ID to fix, or 'auto' to pick the most important", required: true },
    ]},
    { name: "self_analyze", description: "Analyze what tools Kate uses most, least, and which fail often", parameters: [] },
    { name: "self_optimize", description: "Suggest optimizations: remove unused tools, merge similar ones, add missing ones", parameters: [] },
    { name: "self_create_tool", description: "Kate creates a new tool for herself based on a need she identifies", parameters: [
      { name: "name", type: "string", description: "Tool/skill name", required: true },
      { name: "description", type: "string", description: "What it does", required: true },
      { name: "reason", type: "string", description: "Why Kate needs this", required: true },
      { name: "tools", type: "string", description: "JSON array of tool definitions", required: true },
    ]},
    { name: "self_learn", description: "Kate writes a lesson to remember for future tasks", parameters: [
      { name: "lesson", type: "string", description: "What Kate learned", required: true },
      { name: "context", type: "string", description: "When this applies", required: true },
    ]},
    { name: "self_status", description: "Show Kate's self-improvement stats: learnings, gaps fixed, tools created", parameters: [] },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    loadGaps();

    switch (toolName) {
      case "self_review": {
        let learnings: any[] = [];
        try { if (fs.existsSync(LEARN_FILE)) learnings = JSON.parse(fs.readFileSync(LEARN_FILE, "utf-8")); } catch {}

        if (learnings.length === 0) return "No learnings recorded yet. Use Kate more and errors will be tracked automatically.";

        const failures = learnings.filter(l => l.type === "failure");
        const successes = learnings.filter(l => l.type === "success");

        // Find patterns in failures
        const failTools: Record<string, number> = {};
        const failReasons: Record<string, number> = {};
        for (const f of failures) {
          failTools[f.tool] = (failTools[f.tool] || 0) + 1;
          const reason = f.outcome.slice(0, 60);
          failReasons[reason] = (failReasons[reason] || 0) + 1;
        }

        const topFailTools = Object.entries(failTools).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const topReasons = Object.entries(failReasons).sort((a, b) => b[1] - a[1]).slice(0, 5);

        const lines = [
          "Self-Review Report",
          "==================",
          "",
          "Total learnings: " + learnings.length,
          "Successes: " + successes.length,
          "Failures: " + failures.length,
          "Success rate: " + (successes.length > 0 ? Math.round(successes.length / learnings.length * 100) : 0) + "%",
          "",
        ];

        if (topFailTools.length > 0) {
          lines.push("Most failing tools:");
          topFailTools.forEach(([t, c]) => lines.push("  " + t + ": " + c + " failures"));
          lines.push("");
        }

        if (topReasons.length > 0) {
          lines.push("Common failure reasons:");
          topReasons.forEach(([r, c]) => lines.push("  " + r + " (" + c + "x)"));
          lines.push("");
        }

        // Auto-detect gaps
        const newGaps: string[] = [];
        for (const [tool, count] of topFailTools) {
          if (count >= 3) {
            const existing = gaps.find(g => g.suggestedTool === tool);
            if (!existing) {
              const gap: Gap = {
                id: "gap-" + Date.now() + "-" + Math.random().toString(36).slice(2, 4),
                description: tool + " fails frequently (" + count + " times). Needs fixing or replacement.",
                detectedFrom: "self_review",
                suggestedTool: tool + "_improved",
                status: "open",
                created: Date.now(),
              };
              gaps.push(gap);
              newGaps.push(gap.description);
            }
          }
        }

        if (newGaps.length > 0) {
          saveGaps();
          lines.push("New gaps identified:");
          newGaps.forEach(g => lines.push("  ! " + g));
          lines.push("");
        }

        lines.push("Recommendations:");
        if (failures.length > successes.length * 0.3) lines.push("  - High failure rate. Review tool configurations.");
        if (topFailTools.some(([t]) => t === "search")) lines.push("  - Web search failing often. Search engines may be blocked.");
        if (topFailTools.some(([t]) => t.includes("skill_create"))) lines.push("  - Skill creation failing. Model may need clearer tool format.");
        if (failures.length === 0) lines.push("  - No failures! Kate is performing well.");

        return lines.join("\n");
      }

      case "self_gaps": {
        if (gaps.length === 0) return "No gaps identified. Run self_review to analyze errors, or self_add_gap to record one manually.";
        return "Capability Gaps (" + gaps.filter(g => g.status === "open").length + " open):\n\n" + gaps.map(g =>
          (g.status === "open" ? "🔴" : g.status === "fixed" ? "🟢" : "⚪") + " [" + g.id + "] " + g.description + "\n  Suggested: " + g.suggestedTool + " | Status: " + g.status
        ).join("\n\n");
      }

      case "self_add_gap": {
        const gap: Gap = {
          id: "gap-" + Date.now().toString(36),
          description: args.description as string,
          detectedFrom: "manual",
          suggestedTool: (args.suggestedTool as string) || "unknown",
          status: "open",
          created: Date.now(),
        };
        gaps.push(gap);
        saveGaps();
        return "Gap recorded: " + gap.description + "\nID: " + gap.id + "\nUse self_fix_gap to create a tool that fixes this.";
      }

      case "self_fix_gap": {
        const gapId = args.gapId as string;
        let gap: Gap | undefined;

        if (gapId === "auto") {
          gap = gaps.find(g => g.status === "open");
        } else {
          gap = gaps.find(g => g.id === gapId);
        }

        if (!gap) return "Gap not found. Use self_gaps to list them.";

        return "Gap identified: " + gap.description + "\n\nTo fix this, Kate should create a new skill:\n\n" +
          "Use self_create_tool with:\n" +
          "  name: " + gap.suggestedTool + "\n" +
          "  description: Fix for - " + gap.description + "\n" +
          "  reason: Auto-detected from self_review\n" +
          "  tools: [appropriate tool definitions]\n\n" +
          "Or use skill_create to build it directly.";
      }

      case "self_analyze": {
        let learnings: any[] = [];
        try { if (fs.existsSync(LEARN_FILE)) learnings = JSON.parse(fs.readFileSync(LEARN_FILE, "utf-8")); } catch {}

        const toolUse: Record<string, { success: number; fail: number }> = {};
        for (const l of learnings) {
          if (!toolUse[l.tool]) toolUse[l.tool] = { success: 0, fail: 0 };
          if (l.type === "success") toolUse[l.tool].success++;
          else toolUse[l.tool].fail++;
        }

        const sorted = Object.entries(toolUse).sort((a, b) => (b[1].success + b[1].fail) - (a[1].success + a[1].fail));

        const lines = ["Tool Usage Analysis", "===================", ""];

        if (sorted.length === 0) return "No tool usage data yet. Kate needs to do more tasks first.";

        lines.push("Most used:");
        sorted.slice(0, 10).forEach(([t, s]) => {
          const total = s.success + s.fail;
          const rate = Math.round(s.success / total * 100);
          lines.push("  " + t + ": " + total + " calls (" + rate + "% success)");
        });

        lines.push("");
        lines.push("Least reliable:");
        const unreliable = sorted.filter(([, s]) => s.fail > 0).sort((a, b) => {
          const rateA = a[1].fail / (a[1].success + a[1].fail);
          const rateB = b[1].fail / (b[1].success + b[1].fail);
          return rateB - rateA;
        });
        unreliable.slice(0, 5).forEach(([t, s]) => {
          lines.push("  " + t + ": " + s.fail + " failures / " + (s.success + s.fail) + " total");
        });

        lines.push("");
        lines.push("Never used (may need better trigger keywords):");
        const usedTools = new Set(sorted.map(([t]) => t));
        const allSkillFiles = fs.readdirSync(path.join(os.homedir(), "kate", "src", "skills"))
          .filter(f => f.endsWith(".ts") && f !== "manager.ts").map(f => f.replace(".ts", ""));
        // This is approximate since we track tools not skills

        return lines.join("\n");
      }

      case "self_optimize": {
        let learnings: any[] = [];
        try { if (fs.existsSync(LEARN_FILE)) learnings = JSON.parse(fs.readFileSync(LEARN_FILE, "utf-8")); } catch {}

        const suggestions: string[] = ["Optimization Suggestions", "========================", ""];

        // Check for repeated failures
        const failPatterns: Record<string, number> = {};
        for (const l of learnings.filter(l => l.type === "failure")) {
          const key = l.tool + ":" + l.outcome.slice(0, 40);
          failPatterns[key] = (failPatterns[key] || 0) + 1;
        }

        for (const [pattern, count] of Object.entries(failPatterns)) {
          if (count >= 3) {
            const [tool, error] = pattern.split(":");
            suggestions.push("1. " + tool + " keeps failing with: " + error);
            suggestions.push("   Fix: Create an improved version or add error handling");
            suggestions.push("");
          }
        }

        // Check for tools that could be merged
        suggestions.push("2. Consider merging similar tools:");
        suggestions.push("   - search + gh_search_repos → unified search");
        suggestions.push("   - fetch_page + docs_read → unified fetcher");
        suggestions.push("");

        // Check for missing capabilities
        suggestions.push("3. Missing capabilities to add:");
        if (!gaps.find(g => g.description.includes("image"))) suggestions.push("   - Image generation / screenshot analysis");
        if (!gaps.find(g => g.description.includes("email"))) suggestions.push("   - Email sending / notifications");
        if (!gaps.find(g => g.description.includes("calendar"))) suggestions.push("   - Calendar / time management");
        suggestions.push("");

        suggestions.push("4. Performance:");
        suggestions.push("   - " + learnings.length + " learnings stored");
        suggestions.push("   - " + gaps.filter(g => g.status === "open").length + " open gaps");
        suggestions.push("   - Consider: self_fix_gap to address open issues");

        return suggestions.join("\n");
      }

      case "self_create_tool": {
        const name = args.name as string;
        const description = args.description as string;
        const reason = args.reason as string;

        // Use skill_create through the context
        const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const toolsJson = args.tools as string;

        // Log the self-improvement
        log.info("Kate creating tool for herself: " + name + " because: " + reason);

        // Create via skillforge
        const result = await ctx.log.info("Self-creating skill: " + name);

        // Mark any related gap as fixed
        const relatedGap = gaps.find(g => g.status === "open" && (g.suggestedTool.includes(safeName) || g.description.toLowerCase().includes(name.toLowerCase())));
        if (relatedGap) {
          relatedGap.status = "fixed";
          saveGaps();
        }

        return "Kate wants to create: " + name + "\nReason: " + reason + "\nDescription: " + description + "\n\nUse skill_create to build it:\n  skill_create name=\"" + safeName + "\" description=\"" + description + "\" tools='" + toolsJson + "'";
      }

      case "self_learn": {
        const lesson = args.lesson as string;
        const context = args.context as string;

        let learnings: any[] = [];
        try { if (fs.existsSync(LEARN_FILE)) learnings = JSON.parse(fs.readFileSync(LEARN_FILE, "utf-8")); } catch {}

        learnings.push({
          id: "l-" + Date.now(),
          type: "pattern",
          tool: "self",
          input: context.slice(0, 200),
          outcome: lesson.slice(0, 200),
          lesson: lesson,
          timestamp: Date.now(),
          useCount: 0,
        });

        if (!fs.existsSync(KATE_DIR)) fs.mkdirSync(KATE_DIR, { recursive: true });
        fs.writeFileSync(LEARN_FILE, JSON.stringify(learnings.slice(-500), null, 2));

        return "Lesson recorded: " + lesson + "\nApplies when: " + context;
      }

      case "self_status": {
        let learnings: any[] = [];
        try { if (fs.existsSync(LEARN_FILE)) learnings = JSON.parse(fs.readFileSync(LEARN_FILE, "utf-8")); } catch {}

        const customSkills = fs.existsSync(path.join(KATE_DIR, "skills"))
          ? fs.readdirSync(path.join(KATE_DIR, "skills"), { withFileTypes: true }).filter(d => d.isDirectory()).length
          : 0;

        return [
          "Kate Self-Improvement Status",
          "============================",
          "",
          "Learnings: " + learnings.length + " (" + learnings.filter(l => l.type === "success").length + " successes, " + learnings.filter(l => l.type === "failure").length + " failures, " + learnings.filter(l => l.type === "pattern").length + " patterns)",
          "Capability gaps: " + gaps.length + " total (" + gaps.filter(g => g.status === "open").length + " open, " + gaps.filter(g => g.status === "fixed").length + " fixed)",
          "Custom skills created: " + customSkills,
          "",
          "Use self_review for detailed analysis",
          "Use self_gaps to see what needs fixing",
          "Use self_optimize for improvement suggestions",
        ].join("\n");
      }

      default: return "Unknown: " + toolName;
    }
  },
};

export default selfimprove;
