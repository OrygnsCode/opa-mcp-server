/**
 * Format a tool envelope for MCP transport.
 *
 * The MCP SDK expects `{ content: [{ type: 'text', text: string }] }`.
 * We serialize the envelope as JSON and apply size-based truncation.
 */
import type { ToolEnvelope, ToolError } from '../types.js';

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

const DETAILS_DROPPED = {
  __truncated: true,
  message: 'Error details exceeded maxResponseBytes and were dropped.',
};

/**
 * Cut `text` so that `measure(text)` stays within `budget`, measured after
 * serialisation, since JSON escaping can more than double a string of
 * newlines or control characters. A binary search on the byte length, so the
 * cost is logarithmic in the message size.
 */
function cutToFit(text: string, measure: (candidate: string) => number, budget: number): string {
  const suffix = ' [truncated]';
  const raw = Buffer.from(text, 'utf8');
  let lo = 0;
  let hi = raw.length;
  let best = '';
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = raw.subarray(0, mid).toString('utf8') + suffix;
    if (measure(candidate) <= budget) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function formatEnvelope<T>(envelope: ToolEnvelope<T>, maxBytes: number): McpToolResult {
  let serialized = JSON.stringify(envelope, null, 2);

  if (bytes(serialized) > maxBytes) {
    const truncatedEnvelope: ToolEnvelope<T> = {
      ...envelope,
      truncated: true,
    };
    if (truncatedEnvelope.ok && truncatedEnvelope.data !== undefined) {
      truncatedEnvelope.data = {
        __truncated: true,
        message:
          'Response exceeded maxResponseBytes. Re-run with narrower scope, or write the output to a file path you specify.',
      } as T;
      serialized = JSON.stringify(truncatedEnvelope, null, 2);
    } else if (!truncatedEnvelope.ok && truncatedEnvelope.error !== undefined) {
      // An error has to stay readable, but the cap is a cap, and it is
      // measured on the serialised text: JSON escaping can double a message
      // of newlines. Shrink the least useful field first and only as far as
      // needed: the details (a subprocess's stderr, a diagnostic list), then
      // the warnings, then the hint, and the message last.
      const error: ToolError = { ...truncatedEnvelope.error };
      truncatedEnvelope.error = error;
      const size = (): number => bytes(JSON.stringify(truncatedEnvelope, null, 2));
      const fits = (): boolean => size() <= maxBytes;

      if (!fits() && error.details !== undefined) {
        const kept = error.details;
        error.details = DETAILS_DROPPED;
        // Dropping them is only worth it when it helps; a tiny exit code
        // next to a huge message stays.
        if (
          size() >=
          bytes(
            JSON.stringify({ ...truncatedEnvelope, error: { ...error, details: kept } }, null, 2),
          )
        ) {
          error.details = kept;
        }
      }
      if (!fits() && truncatedEnvelope.warnings !== undefined) {
        truncatedEnvelope.warnings = ['[warnings dropped: response exceeded maxResponseBytes]'];
      }
      if (!fits() && error.hint !== undefined) {
        const others = (): number => {
          const probe = { ...truncatedEnvelope, error: { ...error, hint: '' } };
          return bytes(JSON.stringify(probe, null, 2));
        };
        error.hint = cutToFit(error.hint, (c) => others() + bytes(JSON.stringify(c)) - 2, maxBytes);
      }
      if (!fits()) {
        const others = (): number => {
          const probe = { ...truncatedEnvelope, error: { ...error, message: '' } };
          return bytes(JSON.stringify(probe, null, 2));
        };
        error.message = cutToFit(
          error.message,
          (c) => others() + bytes(JSON.stringify(c)) - 2,
          maxBytes,
        );
      }
      serialized = JSON.stringify(truncatedEnvelope, null, 2);
    } else {
      serialized = JSON.stringify(truncatedEnvelope, null, 2);
    }
  }

  return {
    content: [{ type: 'text', text: serialized }],
    isError: !envelope.ok,
  };
}
