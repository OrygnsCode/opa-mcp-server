/**
 * Format a tool envelope for MCP transport.
 *
 * The MCP SDK expects `{ content: [{ type: 'text', text: string }] }`.
 * We serialize the envelope as compact JSON and apply size-based truncation.
 * Indentation roughly tripled the size of a nested payload, so a large result
 * hit the cap at a third of what it held, and cost the reader tokens.
 */
import type { ToolEnvelope, ToolError } from '../types.js';

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

const WARNINGS_DROPPED = '[warnings dropped: response exceeded maxResponseBytes]';

/**
 * Shrink a success payload that is over the response cap, keeping what
 * matters most, such as the result while a trace is cut. Given the data and a
 * test for whether a candidate fits, it returns a candidate that fits, or
 * undefined to fall back to replacing the data with a marker.
 */
export type Shrink<T> = (data: T, fits: (candidate: T) => boolean) => T | undefined;

/**
 * The longest prefix of `items` whose payload `make(prefix)` fits, found by
 * binary search, or undefined when not even the empty prefix fits.
 */
export function fitPrefix<I, D>(
  items: readonly I[],
  make: (prefix: I[]) => D,
  fits: (candidate: D) => boolean,
): D | undefined {
  let lo = 0;
  let hi = items.length;
  let best: D | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = make(items.slice(0, mid));
    if (fits(candidate)) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

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

export function formatEnvelope<T>(
  envelope: ToolEnvelope<T>,
  maxBytes: number,
  shrink?: Shrink<T>,
): McpToolResult {
  let serialized = JSON.stringify(envelope);

  if (bytes(serialized) > maxBytes) {
    const fullSize = bytes(serialized);
    // The cap is measured on the serialised text, since JSON escaping can
    // double a message of newlines. Shrink the least useful field first and
    // only as far as needed: a success's data, an error's details, then the
    // warnings, then the hint, and the message last. A field is replaced
    // only when the replacement is actually smaller.
    const t: ToolEnvelope<T> = { ...envelope, truncated: true };
    const size = (): number => bytes(JSON.stringify(t));
    const fits = (): boolean => size() <= maxBytes;
    const replaceIfSmaller = (apply: () => void, revert: () => void): void => {
      const before = size();
      apply();
      if (size() >= before) revert();
    };

    if (t.ok && t.data !== undefined) {
      const kept = t.data;
      const shrunk = shrink?.(
        kept,
        (candidate) => bytes(JSON.stringify({ ...t, data: candidate })) <= maxBytes,
      );
      if (shrunk !== undefined) t.data = shrunk;
      if (!fits()) {
        t.data = kept;
        replaceIfSmaller(
          () => {
            t.data = {
              __truncated: true,
              message: `The response was ${fullSize} bytes, over the ${maxBytes}-byte cap (OPA_MCP_MAX_RESPONSE_BYTES). Narrow the query, the input or the paths, or raise the cap.`,
            } as T;
          },
          () => {
            t.data = kept;
          },
        );
      }
    }

    const error: ToolError | undefined =
      !t.ok && t.error !== undefined ? { ...t.error } : undefined;
    if (error !== undefined) t.error = error;

    if (error !== undefined && !fits() && error.details !== undefined) {
      const kept = error.details;
      replaceIfSmaller(
        () => {
          error.details = DETAILS_DROPPED;
        },
        () => {
          error.details = kept;
        },
      );
    }
    if (!fits() && t.warnings !== undefined) {
      const kept = t.warnings;
      replaceIfSmaller(
        () => {
          t.warnings = [WARNINGS_DROPPED];
        },
        () => {
          t.warnings = kept;
        },
      );
    }
    if (error !== undefined && !fits() && error.hint !== undefined) {
      const others = (): number => bytes(JSON.stringify({ ...t, error: { ...error, hint: '' } }));
      error.hint = cutToFit(error.hint, (c) => others() + bytes(JSON.stringify(c)) - 2, maxBytes);
    }
    if (error !== undefined && !fits()) {
      const others = (): number =>
        bytes(JSON.stringify({ ...t, error: { ...error, message: '' } }));
      error.message = cutToFit(
        error.message,
        (c) => others() + bytes(JSON.stringify(c)) - 2,
        maxBytes,
      );
    }
    serialized = JSON.stringify(t);
  }

  return {
    content: [{ type: 'text', text: serialized }],
    isError: !envelope.ok,
  };
}
