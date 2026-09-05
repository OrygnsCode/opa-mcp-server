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
    } else if (!truncatedEnvelope.ok && truncatedEnvelope.error !== undefined) {
      // An error has to stay readable, but the cap is a cap: the details go
      // first, since they carry the bulk (a subprocess's stderr, a parsed
      // diagnostic list), and the message is cut only when that is not
      // enough. An oversize error used to be re-serialised whole with the
      // flag set, which made the documented hard cap a soft one.
      const error: ToolError = { ...truncatedEnvelope.error };
      if (error.details !== undefined) {
        error.details = {
          __truncated: true,
          message: 'Error details exceeded maxResponseBytes and were dropped.',
        };
      }
      truncatedEnvelope.error = error;
      if (bytes(JSON.stringify(truncatedEnvelope, null, 2)) > maxBytes) {
        const suffix = ' [message truncated]';
        const overhead = bytes(
          JSON.stringify({ ...truncatedEnvelope, error: { ...error, message: suffix } }, null, 2),
        );
        const room = Math.max(0, maxBytes - overhead);
        error.message =
          Buffer.from(error.message, 'utf8').subarray(0, room).toString('utf8') + suffix;
        truncatedEnvelope.error = error;
      }
    }
    serialized = JSON.stringify(truncatedEnvelope, null, 2);
  }

  return {
    content: [{ type: 'text', text: serialized }],
    isError: !envelope.ok,
  };
}
