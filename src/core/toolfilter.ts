import type { ToolDefinition } from "./types.js";

const SKILL_KEYWORDS: Record<string, string[]> = {
  "builtin.shell":       ["run", "command", "execute", "bash", "terminal", "script", "install", "sudo", "process", "kill", "service"],
  "builtin.files":       ["file", "read", "write", "create", "directory", "folder", "list", "search", "find", "save", "delete", "copy", "move"],
  "builtin.web":         ["fetch", "url", "http", "website"],
  "builtin.websearch":   ["search", "google", "find", "look up", "lookup", "what is", "who is", "how to", "latest", "news"],
  "builtin.github":      ["github", "repo", "repository", "code search", "trending", "readme", "release", "star", "fork"],
  "builtin.docs":        ["docs", "documentation", "wiki", "api spec", "openapi", "swagger", "read docs", "manual"],
  "builtin.memory":      ["remember", "recall", "forget", "memory", "memories", "what do you know"],
  "builtin.browser":     ["browse", "browser", "click", "screenshot", "navigate", "page", "form", "scrape", "login"],
  "builtin.scheduler":   ["schedule", "cron", "every hour", "every minute", "reminder", "recurring", "timer", "task"],
  "builtin.pcb":         ["pcb", "circuit", "schematic", "board", "kicad", "gerber", "bom", "netlist", "component"],
  "builtin.arduino":     ["arduino", "esp32", "esp", "firmware", "sketch", "upload", "compile", "serial", "blink", "sensor", "mqtt", "wifi", "zigbee", "ble", "i2c", "spi"],
  "builtin.workers":     ["worker", "spawn", "parallel", "batch", "scale", "distribute", "concurrent"],
  "builtin.skillforge":  ["skill", "plugin", "create skill", "make skill", "forge", "custom tool", "new skill", "build skill"],
  "builtin.router":      ["router", "model", "benchmark", "route", "fast model", "slow model", "switch model", "multi-model"],
  "builtin.git":         ["git", "commit", "push", "pull", "branch", "merge", "clone", "diff", "stash", "pr ", "issue", "blame"],
  "builtin.codeanalysis":["lint", "security scan", "audit", "complexity", "todo", "duplicate", "secrets", "vulnerability", "code quality"],
  "builtin.packages":    ["npm", "pip", "apt", "install package", "dependency", "module", "upgrade", "outdated"],
  "builtin.monitoring":  ["monitor", "health", "cpu", "memory", "disk", "process", "uptime", "network", "log", "service", "alert", "system info", "status"],
  "builtin.apibuilder":  ["api create", "rest api", "endpoint", "express", "server", "scaffold api"],
  "builtin.cicd":        ["cicd", "ci/cd", "pipeline", "deploy", "docker", "github actions", "workflow", "dockerfile", "compose"],
  "builtin.autohealer":  ["heal", "fix", "diagnose", "broken", "error", "repair", "scan problem"],
  "builtin.agentcomm":   ["comm", "message bus", "channel", "broadcast", "subscribe", "inbox", "agent talk"],
  "builtin.downloads":   ["download", "grab", "fetch file", "release", "archive", "extract", "zip", "tar", "clone repo"],
  "builtin.apitester":   ["test api", "postman", "curl", "http request", "benchmark api", "collection", "api test"],
  "builtin.docker":      ["docker", "container", "image", "compose", "volume", "build image", "registry", "dockerfile"],
  "builtin.ssh":         ["ssh", "remote", "server", "scp", "tunnel", "port forward", "remote command"],
  "builtin.database":    ["database", "sql", "query", "sqlite", "postgres", "mysql", "table", "schema", "db"],
  "builtin.network":     ["network", "scan", "port", "ping", "dns", "trace", "whois", "speed", "bandwidth", "wake", "iot", "subnet", "ip", "mac"],
  "builtin.backup":      ["backup", "restore", "archive", "snapshot", "copy config"],
  "builtin.mqtt":        ["mqtt", "publish", "subscribe", "broker", "zigbee", "z2m", "zigbee2mqtt", "home assistant", "homeassistant", "iot"],
  "builtin.services":    ["systemd", "service", "systemctl", "daemon", "boot", "enable service", "unit file", "journalctl"],
  "builtin.codegen":     ["generate", "scaffold", "boilerplate", "template", "nginx", "dockerfile", "makefile", "gitignore", "new project", "create project"],
  "builtin.installer":   ["install", "clone", "find repo", "from github", "my repo", "et-bus", "etbus", "project", "integrate", "mantiz"],
  "builtin.partpicker": ["part", "component", "resistor", "capacitor", "sensor", "bom", "lcsc", "mouser", "digikey", "datasheet", "pick part", "need for", "parts do", "parts for", "what parts", "zigbee", "esp32"],
  "builtin.selfimprove": ["improve", "review", "gap", "optimize", "learn", "mistake", "self", "better", "fix yourself", "what went wrong", "analyze errors"],
  "builtin.events":      ["event", "event bus", "subscribe", "trigger", "rule", "automation", "when this", "fire", "react"],
  "builtin.eventbus":    ["event", "rule", "trigger", "react", "chain", "bus", "fire event"],
  "builtin.evolve":      ["evolve", "evolution", "self-fix", "learn", "error pattern", "self-review", "self-heal"],
  "builtin.heartbeat":   ["heartbeat", "health check", "briefing", "daily", "proactive", "threshold", "alert"],
};

const ALWAYS_INCLUDE = ["builtin.shell", "builtin.files", "builtin.memory", "builtin.websearch"];

// Smart intent patterns — catches natural language better than keywords
const INTENT_PATTERNS: Array<{ pattern: RegExp; skills: string[] }> = [
  { pattern: /what parts|parts? (do i |for |need|list)|bom|bill of material|component/i, skills: ["builtin.partpicker"] },
  { pattern: /search (for|github|web|online|find)|look up|look for|find (me |some )?/i, skills: ["builtin.websearch", "builtin.github"] },
  { pattern: /clone|download|install|from github|my repo/i, skills: ["builtin.installer", "builtin.github", "builtin.downloads"] },
  { pattern: /docker|container|compose|image/i, skills: ["builtin.docker"] },
  { pattern: /ssh|remote|server (at|on)|connect to/i, skills: ["builtin.ssh"] },
  { pattern: /mqtt|publish|subscribe|zigbee2mqtt|home assistant|ha /i, skills: ["builtin.mqtt"] },
  { pattern: /scan (my |the )?network|find devices|what.s on my network|ping|portscan/i, skills: ["builtin.network"] },
  { pattern: /backup|restore|snapshot/i, skills: ["builtin.backup"] },
  { pattern: /pcb|schematic|board design|kicad|gerber/i, skills: ["builtin.pcb", "builtin.partpicker"] },
  { pattern: /esp32|arduino|firmware|sensor|compile|upload|sketch|part|component|bom/i, skills: ["builtin.arduino", "builtin.partpicker"] },
  { pattern: /agent|delegate|team|specialist/i, skills: ["builtin.multiagent"] },
  { pattern: /event|trigger|rule|automat/i, skills: ["builtin.events"] },
  { pattern: /proxmox|pve|vm|virtual machine|node|cluster|snapshot|backup vm/i, skills: ["builtin.proxmox"] },
  { pattern: /improve|review|gap|optimize|learn from|mistake|fix yourself|what went wrong|analyze error/i, skills: ["builtin.selfimprove"] },
  { pattern: /worker|spawn|parallel|batch/i, skills: ["builtin.workers"] },
  { pattern: /service|systemd|systemctl|boot|daemon/i, skills: ["builtin.services"] },
  { pattern: /database|sql|query|table/i, skills: ["builtin.database"] },
  { pattern: /git |commit|push|pull|branch|merge|pr |issue/i, skills: ["builtin.git"] },
  { pattern: /docker|container/i, skills: ["builtin.docker"] },
  { pattern: /security|vulnerabilit|audit|lint|scan code/i, skills: ["builtin.codeanalysis"] },
  { pattern: /schedule|cron|every \d|reminder|timer/i, skills: ["builtin.scheduler"] },
  { pattern: /create (a |new )?(project|app|api|skill)/i, skills: ["builtin.codegen", "builtin.skillforge", "builtin.apibuilder"] },
  { pattern: /cpu|memory|disk|health|status|uptime|process/i, skills: ["builtin.monitoring"] },
  { pattern: /what do you know|remember|recall|my (name|github|network)/i, skills: ["builtin.memory"] },
  { pattern: /alternative|equivalent|replace|substitute/i, skills: ["builtin.partpicker"] },
  { pattern: /datasheet|spec sheet|data sheet/i, skills: ["builtin.partpicker", "builtin.websearch"] },
  { pattern: /price|cost|cheap|expensive|how much/i, skills: ["builtin.partpicker"] },
];

// Force these skills for matching keywords — ALWAYS include all their tools
const FORCE_SKILLS: Array<{words: string[]; skillId: string}> = [
  { words: ["proxmox", "pve", "vm", "virtual machine", "node", "cluster", "snapshot"], skillId: "builtin.proxmox" },
  { words: ["arduino", "sketch", "esp32", "esp8266", "compile", "upload", "library", "board"], skillId: "builtin.arduino" },
  { words: ["docker", "container", "image"], skillId: "builtin.docker" },
  { words: ["mqtt", "publish", "subscribe"], skillId: "builtin.mqtt" },
  { words: ["etbus", "et-bus", "device"], skillId: "builtin.etbus" },
  { words: ["git", "commit", "push", "clone", "repo"], skillId: "builtin.git" },
  { words: ["part", "component", "bom", "lcsc"], skillId: "builtin.partpicker" },
  { words: ["network", "scan", "ping", "ip"], skillId: "builtin.network" },
  { words: ["ssh", "remote"], skillId: "builtin.ssh" },
  { words: ["worker", "spawn", "batch"], skillId: "builtin.workers" },
  { words: ["agent", "delegate", "team"], skillId: "builtin.multiagent" },
  { words: ["memory", "remember", "recall", "what do you know"], skillId: "builtin.memory" },
  { words: ["file", "read", "write", "list", "directory", "folder"], skillId: "builtin.files" },
  { words: ["shell", "command", "run", "execute"], skillId: "builtin.shell" },
];

export function filterTools(
  allTools: ToolDefinition[],
  skillToolMap: Map<string, ToolDefinition[]>,
  message: string,
): ToolDefinition[] {
  const msg = message.toLowerCase();
  const matched = new Set<string>(ALWAYS_INCLUDE);

  // 1. Intent matching first (smarter, catches natural language)
  for (const intent of INTENT_PATTERNS) {
    if (intent.pattern.test(message)) {
      intent.skills.forEach(s => matched.add(s));
    }
  }

  // 2. Keyword matching as fallback
  for (const [skillId, keywords] of Object.entries(SKILL_KEYWORDS)) {
    for (const kw of keywords) {
      if (msg.includes(kw)) {
        matched.add(skillId);
        break;
      }
    }
  }

  // Generic fallback — add web search and monitoring
  if (matched.size <= ALWAYS_INCLUDE.length) {
    matched.add("builtin.websearch");
    matched.add("builtin.monitoring");
  }

  const filtered: ToolDefinition[] = [];
  for (const skillId of matched) {
    const tools = skillToolMap.get(skillId);
    if (tools) filtered.push(...tools);
  }

  // Force-include skills based on keywords
    const msgLow = message.toLowerCase();
    for (const fs of FORCE_SKILLS) {
      if (fs.words.some(w => msgLow.includes(w))) {
        for (const tool of allTools) {
          if (tool.skillId === fs.skillId && !filtered.find((t: any) => t.name === tool.name)) {
            filtered.push(tool);
          }
        }
      }
    }
    return filtered.length > 0 ? filtered : allTools;
}

