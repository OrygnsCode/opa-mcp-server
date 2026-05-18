/**
 * Centralized configuration loaded from environment variables.
 *
 * Environment variables are the only configuration surface -- there is no
 * config file, no flags. This matches how MCP clients (Claude Desktop,
 * Cursor, VS Code) pass config via the `env` object in their JSON.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

const ConfigSchema = z.object({
  /** Base URL of a running OPA server (used by `opa_*` runtime tools). */
  opaUrl: z.string().url().default('http://localhost:8181'),

  /** Optional bearer token for OPA running with `--authentication=token`. */
  opaToken: z.string().optional(),

  /** Path to the `opa` binary. Defaults to `opa` on PATH. */
  opaBinary: z.string().default('opa'),

  /** Path to the `regal` binary. Defaults to `regal` on PATH. */
  regalBinary: z.string().default('regal'),

  /** Hard timeout in ms for any spawned subprocess (opa, regal). */
  subprocessTimeoutMs: z.coerce.number().int().positive().default(30_000),

  /** HTTP request timeout for OPA REST API calls. */
  httpTimeoutMs: z.coerce.number().int().positive().default(15_000),

  /**
   * Allow-listed root directories for file path inputs. Tools that accept
   * filesystem paths reject anything outside these roots. Empty by
   * default -- file-based tools refuse to read from disk until the
   * operator explicitly opts in via `OPA_MCP_ALLOWED_PATHS`.
   */
  allowedPaths: z.array(z.string()).default([]),

  /** Path to the log file. Defaults to OS tmpdir + orygn-opa-mcp.log. */
  logFile: z.string().default(join(tmpdir(), 'orygn-opa-mcp.log')),

  /** Log level for the file logger. */
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Maximum size in bytes for tool response payloads before truncation.
   * Larger payloads are truncated with `truncated: true` and a hint to
   * write to a file path the agent specifies.
   */
  maxResponseBytes: z.coerce.number().int().positive().default(100_000),
});

export type Config = z.infer<typeof ConfigSchema>;

function parseAllowedPaths(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

export function loadConfig(): Config {
  const allowedPaths = parseAllowedPaths(process.env['OPA_MCP_ALLOWED_PATHS']);

  const parsed = ConfigSchema.safeParse({
    opaUrl: process.env['OPA_URL'],
    opaToken: process.env['OPA_TOKEN'],
    opaBinary: process.env['OPA_BINARY'],
    regalBinary: process.env['REGAL_BINARY'],
    subprocessTimeoutMs: process.env['OPA_MCP_TIMEOUT_MS'],
    httpTimeoutMs: process.env['OPA_MCP_HTTP_TIMEOUT_MS'],
    allowedPaths,
    logFile: process.env['OPA_MCP_LOG_FILE'],
    logLevel: process.env['OPA_MCP_LOG_LEVEL'],
    maxResponseBytes: process.env['OPA_MCP_MAX_RESPONSE_BYTES'],
  });

  if (!parsed.success) {
    console.error('Invalid orygn-opa-mcp configuration:');
    console.error(JSON.stringify(parsed.error.format(), null, 2));
    process.exit(2);
  }

  return parsed.data;
}
