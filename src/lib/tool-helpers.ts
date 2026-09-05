/**
 * Helpers shared across tool implementations.
 *
 * Each tool follows the same shape -- validate input, call into a CLI
 * wrapper or HTTP client, map errors to a structured envelope, return
 * the formatted MCP result. The pieces here factor out the parts every
 * tool repeats so each tool file can stay focused on its own logic.
 */

/**
 * Matches the temp-file paths written by OpaCli.withTempSource and
 * RegalCli.withTempSource when handling inline source. Both now use
 * mkdtemp which produces a private directory; the file inside is always
 * named input.rego. Matches both Unix (/) and Windows (\) separators.
 */
export const INLINE_TEMP_PATH_PATTERN = /orygn-(?:opa|regal)-mcp-[^/\\]+[/\\]input\.rego$/i;

/**
 * Replace a file path that refers to one of our temp files with the
 * sentinel string `<inline>`. Returns the original string unchanged when
 * it does not match the pattern, so callers can unconditionally apply it
 * to all location.file values regardless of whether inline source was used.
 */
export function sanitizeInlinePath(file: string): string {
  return INLINE_TEMP_PATH_PATTERN.test(file) ? '<inline>' : file;
}

/**
 * Recursively rewrite every temp-file path -- in both string values and object
 * keys -- to the `<inline>` sentinel. OPA writes inline source to a temp file,
 * so trace (`explanation`), coverage, and profile output reference that path;
 * this normalizes the whole structure so callers never see an absolute temp
 * path. Only our own temp paths match the pattern, so real user file paths pass
 * through untouched.
 */
/**
 * The temp path as it appears inside a longer diagnostic, such as
 * `1 error occurred: /tmp/orygn-opa-mcp-x/input.rego:3: ...`. Everything
 * from the start of the path to the file name is replaced.
 */
const EMBEDDED_INLINE_TEMP_PATH =
  /(?:[A-Za-z]:)?[^\s"'`]*?orygn-(?:opa|regal)-mcp-[^\s/\\]+[/\\]input\.rego/gi;

/** Replace the temp path whether it is the whole string or sits inside one. */
export function sanitizeInlineText(text: string): string {
  if (INLINE_TEMP_PATH_PATTERN.test(text)) return '<inline>';
  return text.replace(EMBEDDED_INLINE_TEMP_PATH, '<inline>');
}

export function sanitizeInlinePathsDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeInlineText(value);
  if (Array.isArray(value)) return value.map(sanitizeInlinePathsDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[sanitizeInlinePath(key)] = sanitizeInlinePathsDeep(val);
    }
    return out;
  }
  return value;
}
import type { Config } from '../config.js';
import { err } from './errors.js';
import { logger } from './logger.js';
import { formatEnvelope, type McpToolResult } from './output.js';
import { validatePath } from './security.js';
import type { SpawnResult } from './subprocess.js';
import type { ToolEnvelope, ToolErrorCode } from '../types.js';

/**
 * Convert a subprocess outcome into a structured tool error envelope
 * for the cases that are universal across all CLI-backed tools:
 * binary missing, subprocess timed out. Returns `undefined` when the
 * subprocess exited normally (exitCode is a number) so the caller can
 * inspect the result.
 */
export function mapSubprocessFailure(
  result: SpawnResult,
  binary: 'opa' | 'regal' | 'conftest',
): ToolEnvelope<never> | undefined {
  if (result.aborted) {
    return err('CANCELLED', 'Tool execution was cancelled by the client.', {
      details: { durationMs: result.durationMs },
    });
  }
  // A timed-out process is killed, so it also reports a null exit code. Check
  // the timeout first, otherwise a slow command (e.g. `opa bench` on a large
  // policy) is misreported as a missing binary and sends the user hunting for
  // an install problem that does not exist.
  if (result.timedOut) {
    return err(
      'TIMEOUT',
      `${binary} subprocess exceeded the configured timeout (OPA_MCP_TIMEOUT_MS).`,
      {
        details: { durationMs: result.durationMs },
      },
    );
  }
  // Like the timeout above, an over-size process is killed and so also reports a
  // null exit code. Check it before the null-code branch, or a policy that
  // simply produced too much output is reported as a missing binary and sends
  // the user hunting for an install problem that does not exist.
  if (result.outputTruncated) {
    return err(
      'OUTPUT_TOO_LARGE',
      `${binary} produced more output than the capture limit (OPA_MCP_MAX_SUBPROCESS_BYTES) allows, and was stopped.`,
      {
        hint: 'Narrow the query, or drop `--explain full` in favour of a shallower explanation. Trace output grows with the square of the data iterated, so a comprehension over a large collection produces hundreds of megabytes from a small policy.',
        details: { durationMs: result.durationMs },
      },
    );
  }
  // The server's own kills are handled above. A signal that reaches here came
  // from outside it, most often the kernel's out-of-memory killer, and the
  // binary is installed and was running; sending the user to reinstall it
  // would be wrong.
  if (result.exitCode === null && result.signal) {
    return err(
      'SUBPROCESS_KILLED',
      `${binary} was terminated by ${result.signal} before it finished.`,
      {
        hint: 'The process was killed from outside the server, for example by the out-of-memory killer or a container limit. Check the host memory limits and system logs.',
        details: { signal: result.signal, durationMs: result.durationMs },
      },
    );
  }
  if (result.exitCode === null) {
    const code: ToolErrorCode =
      binary === 'opa'
        ? 'OPA_BINARY_NOT_FOUND'
        : binary === 'regal'
          ? 'REGAL_NOT_FOUND'
          : 'CONFTEST_NOT_FOUND';
    const hint =
      binary === 'opa'
        ? 'Install OPA (https://www.openpolicyagent.org/docs/latest/) or set OPA_BINARY to the absolute path of the binary.'
        : binary === 'regal'
          ? 'Install Regal (https://docs.styra.com/regal) or set REGAL_BINARY to the absolute path of the binary.'
          : 'Install Conftest (https://www.conftest.dev/) or set CONFTEST_BINARY to the absolute path of the binary.';
    return err(code, `${binary} binary unreachable: ${result.stderr || 'spawn failed'}`, { hint });
  }
  return undefined;
}

/**
 * Try to parse `text` as JSON. Returns `undefined` on failure so the
 * caller can fall back to a textual error envelope rather than throwing.
 */
export function tryParseJson<T = unknown>(text: string): T | undefined {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Validate a list of input paths against the configured allow-list.
 * Returns either an array of resolved absolute paths or a structured
 * error envelope on the first violation.
 */
export function validatePaths(
  paths: string[],
  config: Config,
  options: { mustExist?: boolean } = {},
): { ok: true; resolved: string[] } | { ok: false; error: ToolEnvelope<never> } {
  const resolved: string[] = [];
  for (const path of paths) {
    const result = validatePath(path, config.allowedPaths, options);
    if (!result.ok) {
      return { ok: false, error: result.error! };
    }
    if (result.resolved !== undefined) resolved.push(result.resolved);
  }
  return { ok: true, resolved };
}

/**
 * Run a tool body, automatically wrapping any thrown exception in a
 * `UNKNOWN_ERROR` envelope and serializing the result. Use this in
 * place of try/catch around every tool handler.
 */
export async function withToolEnvelope<T>(
  config: Config,
  body: () => Promise<ToolEnvelope<T>>,
): Promise<McpToolResult> {
  try {
    const envelope = await body();
    return formatEnvelope(envelope, config.maxResponseBytes);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'An unknown error occurred';
    // Log the full error (with stack) server-side, but never return a raw stack
    // trace to the client: it leaks absolute filesystem paths and is not
    // actionable. Non-Error throws keep their thrown value in details.
    logger.error('Unhandled tool error', {
      message,
      stack: e instanceof Error ? e.stack : undefined,
    });
    const details = e instanceof Error ? undefined : { value: e };
    return formatEnvelope(err('UNKNOWN_ERROR', message, { details }), config.maxResponseBytes);
  }
}
