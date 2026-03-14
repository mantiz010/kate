# Kate

A personal AI assistant that runs on your machine. Private, extensible, professional.

## What It Does

Kate is an AI agent that lives on your computer and connects to your chat apps. It can run shell commands, manage files, remember context across conversations, and extend itself through a skill/plugin system.

Think of it as your personal Jarvis — no cloud lock-in, no meme branding, just a solid tool.

## Quick Start

```bash
# Install
npm install -g aegis-ai

# First-time setup (configures API keys, integrations)
aegis onboard

# Start chatting
aegis
```

## Features

**Multi-Provider AI** — Anthropic Claude, OpenAI GPT, or local models via Ollama. Switch providers anytime.

**Persistent Memory** — Remembers facts, preferences, and context about you across sessions. SQLite-backed, fast keyword search with relevance scoring.

**Tool Use / Agentic** — The AI can call tools in a loop to accomplish multi-step tasks. Shell commands, file operations, web requests, memory management — all built in.

**Chat Integrations** — Telegram, Discord out of the box. Talk to your assistant from any device. Access control built in.

**Skill System** — Extend with custom skills. Drop a JS module in `~/.aegis/skills/` and it's available immediately. Skills can even be written by the AI itself.

**CLI-First** — Clean terminal interface. Also runs as a background daemon for chat-only mode.

## Architecture

```
src/
├── core/
│   ├── types.ts          # All types, schemas, interfaces
│   ├── agent.ts          # Core agent loop (message → think → act → respond)
│   ├── config.ts         # YAML config + .env loader
│   └── logger.ts         # Structured logging
├── providers/
│   ├── anthropic.ts      # Claude provider with tool use
│   ├── openai.ts         # GPT provider with function calling
│   └── registry.ts       # Provider registry + fallback
├── memory/
│   └── store.ts          # SQLite persistent memory + in-memory fallback
├── skills/
│   ├── manager.ts        # Skill loader + registry
│   ├── shell.ts          # Run commands, execute scripts
│   ├── files.ts          # Read/write/search files
│   ├── web.ts            # HTTP requests, web scraping
│   └── memory-skill.ts   # AI-accessible memory tools
├── integrations/
│   ├── cli/              # Interactive terminal
│   ├── telegram/         # Telegram bot
│   └── discord/          # Discord bot
├── app.ts                # Bootstrap + wiring
└── cli.ts                # CLI commands (start, onboard, config, skills)
```

## Configuration

Config lives in `~/.aegis/`:

```
~/.aegis/
├── config.yaml    # Main configuration
├── .env           # API keys (gitignored)
├── memory.db      # SQLite memory database
└── skills/        # Custom skill plugins
```

### config.yaml

```yaml
agent:
  name: Kate
  personality: Professional, helpful, and proactive personal AI assistant.

provider:
  default: anthropic
  anthropic:
    model: claude-sonnet-4-20250514
  openai:
    model: gpt-4o

integrations:
  telegram:
    enabled: true
    allowedUsers: ["your_username"]
  discord:
    enabled: false

memory:
  enabled: true
  maxEntries: 10000

skills:
  builtin: [shell, files, web, memory]
```

### Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=123456:ABC...
DISCORD_BOT_TOKEN=MTIz...
```

## Commands

```bash
aegis                  # Start interactive CLI (default)
aegis start --all      # CLI + all integrations
aegis start --daemon   # Background mode (integrations only)
aegis onboard          # First-time setup wizard
aegis config           # Show current configuration
aegis skills           # List loaded skills and tools
```

## Writing Custom Skills

Create a directory in `~/.aegis/skills/your-skill/index.js`:

```javascript
export default {
  id: "custom.example",
  name: "Example",
  description: "An example custom skill",
  version: "1.0.0",
  tools: [
    {
      name: "greet",
      description: "Generate a greeting",
      parameters: [
        { name: "name", type: "string", description: "Name to greet", required: true },
      ],
    },
  ],
  async execute(toolName, args, ctx) {
    if (toolName === "greet") {
      return `Hello, ${args.name}! This is a custom skill.`;
    }
    return "Unknown tool";
  },
};
```

## Development

```bash
git clone https://github.com/yourusername/aegis.git
cd aegis
npm install
npm run dev    # Watch mode with tsx
npm run build  # Compile TypeScript
npm test       # Run tests
```

## Comparison with OpenClaw

| Feature | Kate | OpenClaw |
|---------|-------|----------|
| Language | TypeScript | TypeScript |
| Branding | Professional | Lobster memes |
| Provider support | Claude, GPT, Ollama | Claude, GPT, Ollama |
| Memory | SQLite + relevance scoring | SQLite |
| Tool use | Native agentic loop | Native |
| Integrations | Telegram, Discord, CLI | Telegram, Discord, WhatsApp, Signal, iMessage |
| Skill system | Drop-in JS modules | Drop-in modules |
| Config | YAML + .env | YAML + .env |

## Roadmap

- [ ] WhatsApp integration (via WhatsApp Business API)
- [ ] Browser automation (Playwright)
- [ ] Scheduled tasks / cron
- [ ] Vector memory (embeddings-based search)
- [ ] Heartbeat system (proactive check-ins)
- [ ] Web dashboard
- [ ] Voice input/output
- [ ] Multi-agent support

## License

MIT

