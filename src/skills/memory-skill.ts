import type { Skill, SkillContext } from "../core/types.js";

const memorySKill: Skill = {
  id: "builtin.memory",
  name: "Memory",
  description: "Store, recall, and search persistent memories about the user and context",
  version: "1.0.0",
  tools: [
    {
      name: "remember",
      description: "Store a new memory/fact about the user or context. Use this proactively when learning something important.",
      parameters: [
        { name: "key", type: "string", description: "Short identifier (e.g. 'user_name', 'favorite_language')", required: true },
        { name: "value", type: "string", description: "The information to remember", required: true },
        { name: "category", type: "string", description: "Category: fact, preference, context, task", required: true },
        { name: "importance", type: "number", description: "Importance 0-1 (default: 0.5)", required: false },
      ],
    },
    {
      name: "recall",
      description: "Search memories for relevant information. Use before answering questions that might involve prior context.",
      parameters: [
        { name: "query", type: "string", description: "What to search for in memory", required: true },
        { name: "limit", type: "number", description: "Max results (default: 5)", required: false },
      ],
    },
    {
      name: "forget",
      description: "Delete a specific memory by key",
      parameters: [
        { name: "key", type: "string", description: "The memory key to delete", required: true },
      ],
    },
    {
      name: "list_memories",
      description: "List memories by category or recent",
      parameters: [
        { name: "category", type: "string", description: "Filter by category (optional)", required: false },
        { name: "limit", type: "number", description: "Max results (default: 10)", required: false },
      ],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const { memory, userId } = ctx;

    switch (toolName) {
      case "remember": {
        const key = args.key as string;
        const value = args.value as string;
        const category = args.category as string || "fact";
        const importance = (args.importance as number) || 0.5;

        await memory.set(key, value, category, userId, importance);
        return `Remembered: ${key} = "${value}" [${category}, importance: ${importance}]`;
      }

      case "recall": {
        const query = args.query as string;
        const limit = (args.limit as number) || 5;

        const results = await memory.search(query, userId, limit);
        if (results.length === 0) return "No relevant memories found.";

        return results.map(m =>
          `[${m.category}] ${m.key}: ${m.value} (importance: ${m.importance})`
        ).join("\n");
      }

      case "forget": {
        const key = args.key as string;
        await memory.delete(key, userId);
        return `Deleted memory: ${key}`;
      }

      case "list_memories": {
        const category = args.category as string | undefined;
        const limit = (args.limit as number) || 10;

        const results = category
          ? await memory.getByCategory(category, userId, limit)
          : await memory.getRecent(userId, limit);

        if (results.length === 0) return "No memories found.";

        return results.map(m =>
          `[${m.category}] ${m.key}: ${m.value}`
        ).join("\n");
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },
};

export default memorySKill;

