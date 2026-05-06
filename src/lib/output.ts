/**
 * Format a tool envelope for MCP transport.
 *
 * The MCP SDK expects `{ content: [{ type: 'text', text: string }] }`.
 * We serialize the envelope as JSON and apply size-based truncation.
 */
import type { ToolEnvelope } from '../types.js';

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function formatEnvelope<T>(envelope: ToolEnvelope<T>, maxBytes: number): McpToolResult {
  let serialized = JSON.stringify(envelope, null, 2);

  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
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
    }
    serialized = JSON.stringify(truncatedEnvelope, null, 2);
  }

  return {
    content: [{ type: 'text', text: serialized }],
    isError: !envelope.ok,
  };
}
