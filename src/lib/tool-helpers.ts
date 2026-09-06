/**
 * Helpers shared across tool implementations.
 *
 * Each tool follows the same shape -- validate input, call into a CLI
 * wrapper or HTTP client, map errors to a structured envelope, return
 * the formatted MCP result. The pieces here factor out the parts every
 * tool repeats so each tool file can stay focused on its own logic.
 */

import type { Config } from '../config.js';
import { err } from './errors.js';
import { logger } from './logger.js';
import { formatEnvelope, type McpToolResult } from './output.js';
import { validatePath } from './security.js';
import type { SpawnResult } from './subprocess.js';
import type { ToolEnvelope, ToolErrorCode } from '../types.js';

export {
  INLINE_TEMP_PATH_PATTERN,
  sanitizeInlinePath,
  sanitizeInlinePathsDeep,
  sanitizeInlineText,
} from './inline-paths.js';

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
 * Parse the last top-level JSON object in `text`, for a command that prints
 * one document per run (`opa test --coverage --count N`). Strings are
 * honoured, so a brace inside a file name does not end a document. Returns
 * `undefined` when there is none. `accept` narrows it to the last object of
 * the shape wanted, so trace text that happens to hold braces is skipped.
 */
export function lastJsonObject<T = unknown>(
  text: string,
  accept: (parsed: unknown) => boolean = () => true,
): T | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let last: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      // A stray closing brace must not put every later object out of reach.
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        const candidate = tryParseJson(text.slice(start, i + 1));
        if (candidate !== undefined && accept(candidate)) last = text.slice(start, i + 1);
        start = -1;
      }
    }
  }
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last) as T;
  } catch {
    return undefined;
  }
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
