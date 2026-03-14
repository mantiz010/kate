import type { Logger as ILogger } from "./types.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

export function createLogger(name: string, level: Level = "info"): ILogger {
  const minLevel = LEVELS[level];

  function log(lvl: Level, msg: string, ...args: unknown[]) {
    if (LEVELS[lvl] < minLevel) return;
    const ts = new Date().toISOString().slice(11, 19);
    const prefix = `${COLORS[lvl]}${ts} [${lvl.toUpperCase().padEnd(5)}]${RESET} ${BOLD}${name}${RESET}`;
    console.log(`${prefix} ${msg}`, ...args);
  }

  return {
    debug: (msg, ...args) => log("debug", msg, ...args),
    info: (msg, ...args) => log("info", msg, ...args),
    warn: (msg, ...args) => log("warn", msg, ...args),
    error: (msg, ...args) => log("error", msg, ...args),
  };
}

