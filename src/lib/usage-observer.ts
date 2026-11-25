/**
 * Watches the MCP connection for usage stats: which app connected, which
 * tools were called, and how each call ended. It sits between the server and
 * its transport and passes every message through unchanged.
 *
 * Watching the messages rather than the tool handlers also sees the calls
 * that never reach a handler: arguments the SDK rejects against the schema,
 * a tool name that does not exist, and a call the client cancels.
 */
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

import { noteClient, noteToolCall, takeCrashSite } from './usage-stats.js';

/**
 * Codes for calls that ended without a result from a tool: arguments the SDK
 * rejected, a tool that does not exist, a JSON-RPC error instead of a result,
 * and an error result in no shape the server makes. A cancelled call is
 * counted as CANCELLED, one of the tools' own codes.
 */
export const CALL_CODES = [
  'INVALID_ARGUMENTS',
  'UNKNOWN_TOOL',
  'PROTOCOL_ERROR',
  'UNRECOGNIZED',
] as const;

type Id = string | number;
type Outcome = { code?: string; site?: string };

// Calls waiting for their result. A client that sends calls and never sees
// them through (it cancels, or the server never answers) cannot grow this
// past the cap; the oldest go first.
const MAX_PENDING = 256;

interface Message {
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

/**
 * How a tool result ended. The server's own results carry their error code
 * in the envelope; a result the SDK made itself says why in plain text. An
 * unexpected error also says where it was thrown (see CRASH_SITE).
 */
export function outcomeOf(result: Message['result'], site?: string): Outcome {
  if (!result || result['isError'] !== true) return {};
  const text = firstText(result);
  const code = envelopeCode(text);
  if (code !== undefined) {
    return site !== undefined && code === 'UNKNOWN_ERROR' ? { code, site } : { code };
  }
  if (/Input validation error|Invalid arguments for tool/i.test(text)) {
    return { code: 'INVALID_ARGUMENTS' };
  }
  if (/^(?:MCP error -?\d+: )?Tool \S+ (?:not found|disabled)/i.test(text)) {
    return { code: 'UNKNOWN_TOOL' };
  }
  return { code: 'UNRECOGNIZED' };
}

function firstText(result: Record<string, unknown>): string {
  const content = result['content'];
  if (!Array.isArray(content)) return '';
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : '';
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/;

function envelopeCode(text: string): string | undefined {
  if (!text.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; error?: { code?: unknown } };
    const code = parsed.error?.code;
    return parsed.ok === false && typeof code === 'string' && CODE_RE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The transport, watched. `isTool` says whether a name is one of the
 * server's tools; any other name is counted as `other`.
 */
export function observeToolCalls(inner: Transport, isTool: (name: string) => boolean): Transport {
  const pending = new Map<Id, string>();

  const toolName = (name: unknown): string =>
    typeof name === 'string' && isTool(name) ? name : 'other';

  const incoming = (raw: JSONRPCMessage): void => {
    const msg = raw as Message;
    if (msg.method === 'initialize') {
      const info = msg.params?.['clientInfo'] as { name?: unknown } | undefined;
      noteClient(typeof info?.name === 'string' ? info.name : undefined);
    } else if (msg.method === 'tools/call' && msg.id !== undefined) {
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
      pending.set(msg.id, toolName(msg.params?.['name']));
    } else if (msg.method === 'notifications/cancelled') {
      // A cancelled call gets no result at all.
      const id = msg.params?.['requestId'] as Id | undefined;
      const tool = id === undefined ? undefined : pending.get(id);
      if (id !== undefined && tool !== undefined) {
        pending.delete(id);
        noteToolCall(tool, { code: 'CANCELLED' });
      }
    }
  };

  const outgoing = (raw: JSONRPCMessage): void => {
    const msg = raw as Message;
    if (msg.id === undefined || msg.method !== undefined) return;
    const tool = pending.get(msg.id);
    if (tool === undefined) return;
    pending.delete(msg.id);
    const site = takeCrashSite(msg.id);
    noteToolCall(
      tool,
      msg.error !== undefined ? { code: 'PROTOCOL_ERROR' } : outcomeOf(msg.result, site),
    );
  };

  const outer: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
      // Counting never stands in the way of a message.
      try {
        outgoing(message);
      } catch {
        /* ignore */
      }
      return inner.send(message, options);
    },
    get sessionId() {
      return inner.sessionId;
    },
    setProtocolVersion: (version: string) => inner.setProtocolVersion?.(version),
  };

  inner.onclose = () => outer.onclose?.();
  inner.onerror = (error: Error) => outer.onerror?.(error);
  inner.onmessage = <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => {
    try {
      incoming(message);
    } catch {
      /* ignore */
    }
    outer.onmessage?.(message, extra);
  };
  return outer;
}
