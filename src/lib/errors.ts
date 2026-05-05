/**
 * Helpers for building structured tool errors.
 *
 * Tools should never throw raw exceptions to the MCP layer — every failure
 * mode returns a `ToolEnvelope` with `ok: false` and a structured `error`.
 */
import type { ToolEnvelope, ToolError, ToolErrorCode } from '../types.js';

export function err(
  code: ToolErrorCode,
  message: string,
  options?: { hint?: string; details?: unknown },
): ToolEnvelope<never> {
  const error: ToolError = { code, message };
  if (options?.hint !== undefined) error.hint = options.hint;
  if (options?.details !== undefined) error.details = options.details;
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
  if (e instanceof Error) {
    return err('UNKNOWN_ERROR', e.message, { details: { stack: e.stack } });
  }
  return err('UNKNOWN_ERROR', 'An unknown error occurred', { details: e });
}
