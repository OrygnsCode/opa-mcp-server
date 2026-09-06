/**
 * Centralized configuration loaded from environment variables.
 *
 * Environment variables are the only configuration surface -- there is no
 * config file, no flags. This matches how MCP clients (Claude Desktop,
 * Cursor, VS Code) pass config via the `env` object in their JSON.
 */
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, win32 } from 'node:path';

import { z } from 'zod';

import { resolveOpaBinary } from './lib/resolve-binary.js';

import { DEFAULT_MAX_OUTPUT_BYTES } from './lib/subprocess.js';

/**
 * A `*_BINARY` value: a bare command name, looked up on PATH by the spawn,
 * or an absolute path. A relative path would resolve against wherever the
 * client happened to launch the server, which the README has always said is
 * refused; the schema now says so too.
 */
/**
 * Whether a `*_BINARY` value is acceptable on `platform`: a bare command
 * name, looked up on PATH by the spawn, or an absolute path. A relative path
 * would resolve against wherever the client happened to launch the server.
 * On Windows a path with a leading separator and no drive counts as absolute
 * to `isAbsolute`, yet it resolves against the current drive, the same hazard
 * as the drive-relative `C:regal.exe`; a UNC path starts with two separators
 * and is fine.
 */
export function isBinarySpec(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (value === '.' || value === '..') return false;
  if (!/[\\/]/.test(value) && !/^[A-Za-z]:/.test(value)) return true;
  if (platform === 'win32' && /^[\\/](?![\\/])/.test(value)) return false;
  return (platform === 'win32' ? win32 : posix).isAbsolute(value);
}

const binarySchema = (name: string) =>
  z
    .string()
    .refine((v) => isBinarySpec(v), {
      message: 'must be a bare command name found on PATH, or an absolute path',
    })
    .default(name);

/**
 * Node clamps a timer of 2^31 ms or more to 1 ms, with only a process warning.
 * A large value reads as "effectively no timeout" and produced the opposite:
 * every subprocess and every HTTP call timed out immediately.
 */
const MAX_TIMER_MS = 2_147_483_647;
const TIMER_TOO_LARGE =
  'Timeout must be below 2147483647 ms (about 24 days). Node clamps anything larger to 1 ms, which times out every call immediately.';

const ConfigSchema = z.object({
  /** Base URL of a running OPA server (used by `opa_*` runtime tools). */
  opaUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
      message: 'OPA_URL must use the http or https scheme.',
    })
    .default('http://localhost:8181'),

  /** Optional bearer token for OPA running with `--authentication=token`. */
  opaToken: z.string().optional(),

  /** Path to the `opa` binary. Defaults to `opa` on PATH. */
  opaBinary: binarySchema('opa'),

  /** Path to the `regal` binary. Defaults to `regal` on PATH. */
  regalBinary: binarySchema('regal'),

  /** Path to the `conftest` binary. Defaults to `conftest` on PATH. */
  conftestBinary: binarySchema('conftest'),

  /** Hard timeout in ms for any spawned subprocess (opa, regal). */
  subprocessTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_MS, TIMER_TOO_LARGE)
    .default(30_000),

  /** HTTP request timeout for OPA REST API calls. */
  httpTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_MS, TIMER_TOO_LARGE)
    .default(15_000),

  /**
   * Allow-listed root directories for file path inputs. Tools that accept
   * filesystem paths reject anything outside these roots. Empty by
   * default -- file-based tools refuse to read from disk until the
   * operator explicitly opts in via `OPA_MCP_ALLOWED_PATHS`.
   */
  allowedPaths: z
    .array(
      // A relative root is resolved against the server's working directory,
      // which for a stdio server is wherever the client happened to launch it.
      // The same configuration would then permit different directories on
      // different machines, so it is refused rather than guessed at, which is
      // what the documentation has always said happens.
      z.string().refine(isAbsolute, {
        message: 'must be an absolute path',
      }),
    )
    .default([]),

  /** Path to the log file. Defaults to OS tmpdir + orygn-opa-mcp.log. */
  logFile: z.string().default(join(tmpdir(), 'orygn-opa-mcp.log')),

  /** Log level for the file logger. */
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Maximum size in bytes for tool response payloads before truncation.
   * Larger payloads are truncated with `truncated: true` and a hint to
   * write to a file path the agent specifies.
   */
  maxResponseBytes: z.coerce
    .number()
    .int()
    // The smallest complete envelope is under 300 bytes; a cap that cannot
    // hold one is refused rather than exceeded.
    .min(512, { message: 'must be at least 512' })
    .default(100_000),

  /**
   * Maximum bytes captured from a subprocess's stdout and stderr, each counted
   * separately. On overflow the stream is clamped and the child is killed.
   *
   * This is a memory bound, distinct from `maxResponseBytes`, which trims the
   * response after the output has already been read into the heap. A capture
   * past V8's max string length cannot be decoded at all, and the throw would
   * land in an async callback where no tool can catch it.
   */
  maxSubprocessBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(
      DEFAULT_MAX_OUTPUT_BYTES * 8,
      'OPA_MCP_MAX_SUBPROCESS_BYTES is too large to decode safely; keep it well under 512 MiB.',
    )
    .default(DEFAULT_MAX_OUTPUT_BYTES),
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

const ENV_VAR_NAMES: Record<string, string> = {
  opaUrl: 'OPA_URL',
  opaToken: 'OPA_TOKEN',
  opaBinary: 'OPA_BINARY',
  regalBinary: 'REGAL_BINARY',
  conftestBinary: 'CONFTEST_BINARY',
  subprocessTimeoutMs: 'OPA_MCP_TIMEOUT_MS',
  httpTimeoutMs: 'OPA_MCP_HTTP_TIMEOUT_MS',
  allowedPaths: 'OPA_MCP_ALLOWED_PATHS',
  logFile: 'OPA_MCP_LOG_FILE',
  logLevel: 'OPA_MCP_LOG_LEVEL',
  maxResponseBytes: 'OPA_MCP_MAX_RESPONSE_BYTES',
  maxSubprocessBytes: 'OPA_MCP_MAX_SUBPROCESS_BYTES',
};

/**
 * Read an environment variable, treating an empty or blank value as unset.
 *
 * A shell that expands an unset variable leaves an empty string behind, and
 * `OPA_BINARY=""` was taken as a real path: it is not the literal default
 * `opa`, so binary resolution skipped the bundled build and every tool call
 * tried to spawn nothing. Blank means "not configured" for every variable here.
 */
function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function loadConfig(): Config {
  const allowedPaths = parseAllowedPaths(process.env['OPA_MCP_ALLOWED_PATHS']);

  const parsed = ConfigSchema.safeParse({
    opaUrl: env('OPA_URL'),
    opaToken: env('OPA_TOKEN'),
    opaBinary: env('OPA_BINARY'),
    regalBinary: env('REGAL_BINARY'),
    conftestBinary: env('CONFTEST_BINARY'),
    subprocessTimeoutMs: env('OPA_MCP_TIMEOUT_MS'),
    httpTimeoutMs: env('OPA_MCP_HTTP_TIMEOUT_MS'),
    allowedPaths,
    logFile: env('OPA_MCP_LOG_FILE'),
    logLevel: env('OPA_MCP_LOG_LEVEL'),
    maxResponseBytes: env('OPA_MCP_MAX_RESPONSE_BYTES'),
    maxSubprocessBytes: env('OPA_MCP_MAX_SUBPROCESS_BYTES'),
  });

  if (!parsed.success) {
    console.error('opa-mcp: invalid configuration');
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      const envVar =
        typeof field === 'string' && field in ENV_VAR_NAMES
          ? ENV_VAR_NAMES[field]
          : String(field ?? 'unknown');
      console.error(`  ${envVar}: ${issue.message}`);
    }
    console.error("Run 'opa-mcp --help' for configuration options.");
    process.exit(2);
  }

  const config = parsed.data;
  // Turn the configured binary name into a concrete path: an explicit
  // OPA_BINARY is kept as-is, otherwise we prefer `opa` on PATH and fall
  // back to the bundled platform binary. See lib/resolve-binary.ts.
  config.opaBinary = resolveOpaBinary(config.opaBinary);
  return config;
}
