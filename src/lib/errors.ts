/**
 * Helpers for building structured tool errors.
 *
 * Tools should never throw raw exceptions to the MCP layer -- every failure
 * mode returns a `ToolEnvelope` with `ok: false` and a structured `error`.
 */
import { sanitizeInlinePathsDeep, sanitizeInlineText } from './inline-paths.js';
import type { ToolEnvelope, ToolError, ToolErrorCode } from '../types.js';

/**
 * Build an error envelope. The message, hint and details all pass through
 * the temp-path sanitiser here, so a tool that quotes a binary's stderr does
 * not have to remember to.
 */
export function err(
  code: ToolErrorCode,
  message: string,
  options?: { hint?: string; details?: unknown },
): ToolEnvelope<never> {
  const error: ToolError = { code, message: sanitizeInlineText(message) };
  if (options?.hint !== undefined) error.hint = sanitizeInlineText(options.hint);
  if (options?.details !== undefined) error.details = sanitizeInlinePathsDeep(options.details);
  return { ok: false, error };
}

export function ok<T>(data: T, warnings?: string[]): ToolEnvelope<T> {
  const envelope: ToolEnvelope<T> = { ok: true, data };
  if (warnings && warnings.length > 0) envelope.warnings = warnings;
  return envelope;
}

/**
 * Wrap an unknown thrown value into a structured error. Used as the
 * outermost catch in tool handlers.
 */
export function fromException(e: unknown): ToolEnvelope<never> {
  // Never place a raw stack trace in client-facing details: it leaks absolute
  // filesystem paths. Callers that need the stack should log it server-side.
  if (e instanceof Error) {
    return err('UNKNOWN_ERROR', e.message);
  }
  return err('UNKNOWN_ERROR', 'An unknown error occurred', { details: e });
}
