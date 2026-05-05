/**
 * File-only logger.
 *
 * Stdout is reserved for MCP protocol traffic — writing anywhere else
 * would corrupt the JSON-RPC stream. This logger appends to a file with
 * level filtering, and never touches stdout.
 *
 * Usage: `logger.info('message', { context })`
 */
import { appendFileSync } from 'node:fs';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface LoggerState {
  file: string;
  minLevel: Level;
}

// Lazy-initialized so config can be loaded first.
let state: LoggerState | undefined;

export function initLogger(file: string, level: Level): void {
  state = { file, minLevel: level };
}

function write(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  // Pre-init logs are silently dropped. Only the entry point should produce
  // logs before initLogger runs, and that's a tiny window.
  if (!state) return;
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[state.minLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx ? { ctx } : {}),
  };
  try {
    appendFileSync(state.file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Logging must never throw. If the log file is unreachable, drop the
    // line silently — better than crashing the server.
  }
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>): void => {
    write('debug', msg, ctx);
  },
  info: (msg: string, ctx?: Record<string, unknown>): void => {
    write('info', msg, ctx);
  },
  warn: (msg: string, ctx?: Record<string, unknown>): void => {
    write('warn', msg, ctx);
  },
  error: (msg: string, ctx?: Record<string, unknown>): void => {
    write('error', msg, ctx);
  },
};
