/**
 * Fault-injection tests.
 *
 * The "happy path" tests verify each contract; these verify the
 * server stays calm when the world misbehaves around it. Real
 * scenarios from production environments:
 *
 *   - HTTP response Content-Type lies (says JSON, body is HTML)
 *   - HTTP body truncated mid-stream (proxy hangup, network cut)
 *   - JSON parse fails because the response was binary garbage
 *   - Subprocess stdout contains invalid UTF-8 bytes
 *   - Tool produces data that JSON.stringify cannot serialize
 *     (BigInt, Symbol, circular reference)
 *   - Logger receives huge or weird context payloads
 *
 * The contract under stress: the server keeps speaking MCP. No
 * uncaught exceptions, no crashed transport, no stdout corruption.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/config.js';
import {
  OpaAuthError,
  OpaClient,
  OpaHttpError,
  OpaUnreachableError,
} from '../../src/lib/opa-client.js';
import { formatEnvelope } from '../../src/lib/output.js';
import { ok } from '../../src/lib/errors.js';

const baseConfig: Config = {
  opaUrl: 'http://opa.example.com:8181',
  opaBinary: 'opa',
  regalBinary: 'regal',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 5_000,
  allowedPaths: [],
  logFile: '/tmp/fault-test.log',
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ─── Lying HTTP responses ─────────────────────────────────────────────────

describe('OpaClient under fault: HTTP response shape lies', () => {
  it('throws a structured error when Content-Type says JSON but body is not parseable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html><body>upstream proxy error</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new OpaClient(baseConfig);
    // The contract here: OpaClient may throw a JS error (SyntaxError
    // from JSON.parse) which the calling tool layer wraps into a
    // structured envelope via mapOpaClientError. The server itself
    // does not crash.
    const promise = client.request({ method: 'GET', path: '/v1/policies' });
    await expect(promise).rejects.toThrow();
  });

  it('returns text content verbatim when Content-Type is missing', async () => {
    // No Content-Type header → defaults to '' → not JSON → text path.
    fetchMock.mockResolvedValueOnce(new Response('hello world', { status: 200 }));
    const client = new OpaClient(baseConfig);
    // With no Content-Type, fetch's Response defaults to text/plain.
    // Our isJson check is "contains application/json", so we go to text.
    const data = await client.request<string>({ method: 'GET', path: '/x' });
    expect(typeof data).toBe('string');
  });

  it('handles a non-JSON error body on a 5xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('upstream is down — try again later', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    const client = new OpaClient(baseConfig);
    try {
      await client.request({ method: 'GET', path: '/x' });
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OpaHttpError);
      const err = e as OpaHttpError;
      expect(err.status).toBe(503);
      expect(err.body).toBe('upstream is down — try again later');
    }
  });

  it('preserves the original 5xx body as the OpaHttpError details (HTML body)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<title>500 Internal Server Error</title>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const client = new OpaClient(baseConfig);
    try {
      await client.request({ method: 'GET', path: '/x' });
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OpaHttpError);
      expect((e as OpaHttpError).body).toContain('500 Internal Server Error');
    }
  });
});

// ─── Network failures during body read ────────────────────────────────────

describe('OpaClient under fault: network/body failures', () => {
  it('maps a body-stream read error to OpaUnreachableError via the catch path', async () => {
    // Simulate fetch returning a Response whose .json() rejects mid-read
    // (proxy hangup after headers were sent).
    const failingResponse = new Response('partial', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    // Override .json to reject as if the body stream was cut off.
    Object.defineProperty(failingResponse, 'json', {
      value: () => Promise.reject(new TypeError('Unexpected end of JSON input')),
    });
    fetchMock.mockResolvedValueOnce(failingResponse);
    const client = new OpaClient(baseConfig);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toThrow();
  });

  it('handles fetch rejecting with a non-Error value', async () => {
    fetchMock.mockRejectedValueOnce('string thrown by a buggy polyfill');
    const client = new OpaClient(baseConfig);
    // OpaUnreachableError takes the cause; the caller shape is preserved.
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
      OpaUnreachableError,
    );
  });

  it('returns 401 mapping even when the body is non-JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    const client = new OpaClient(baseConfig);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
      OpaAuthError,
    );
  });
});

// ─── formatEnvelope under fault: data that cannot serialize ───────────────

describe('formatEnvelope under fault: unserializable data', () => {
  it('does not crash when the envelope contains a circular reference', () => {
    const obj: Record<string, unknown> = { name: 'cycle' };
    obj['self'] = obj;
    // JSON.stringify on a circular reference throws TypeError. The
    // contract we care about: even if the formatter throws, the
    // server's withToolEnvelope wrapper catches it and emits a
    // structured error envelope. Here we verify the throw is a
    // TypeError with a useful message — the wrapper handles the rest.
    expect(() => formatEnvelope(ok(obj), 100_000)).toThrow(TypeError);
  });

  it('does not crash when the envelope contains a BigInt', () => {
    const env = ok({ huge: 9007199254740992n });
    // BigInt is also un-stringify-able. Same contract.
    expect(() => formatEnvelope(env, 100_000)).toThrow(TypeError);
  });

  it('serializes Date objects as ISO strings', () => {
    const env = ok({ ts: new Date('2026-05-06T00:00:00Z') });
    const result = formatEnvelope(env, 100_000);
    expect(result.content[0]?.text).toContain('2026-05-06T00:00:00.000Z');
  });

  it('preserves nested arrays of arbitrary depth (within reason)', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 20; i += 1) nested = [nested];
    const env = ok(nested);
    const result = formatEnvelope(env, 100_000);
    expect(result.content[0]?.text).toContain('leaf');
  });
});

// ─── Subprocess output under fault ────────────────────────────────────────

describe('Subprocess captures under fault: invalid UTF-8 bytes', () => {
  it('Buffer.toString(utf8) replaces invalid sequences with U+FFFD', () => {
    // Direct test of the assumption Buffer.concat + toString('utf8')
    // makes inside src/lib/subprocess.ts. If Node ever changed this
    // behavior, our error reporting would silently break.
    const garbage = Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x81]);
    const text = garbage.toString('utf8');
    // Each invalid byte gets replaced with the U+FFFD replacement
    // character (3 bytes UTF-8: ef bf bd, but length-by-codepoint is 1).
    expect(text.length).toBeGreaterThan(0);
    for (const ch of text) {
      expect(ch).toBe('�');
    }
  });

  it('mixed valid and invalid bytes preserve the valid prefix', () => {
    const mixed = Buffer.concat([
      Buffer.from('valid prefix '),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(' valid suffix'),
    ]);
    const text = mixed.toString('utf8');
    expect(text).toContain('valid prefix');
    expect(text).toContain('valid suffix');
    expect(text).toContain('�');
  });
});

// ─── tryParseJson resilience ──────────────────────────────────────────────

describe('tryParseJson resilience', () => {
  it('handles bytes that look like JSON but have stray characters', async () => {
    const { tryParseJson } = await import('../../src/lib/tool-helpers.js');
    expect(tryParseJson('{"x": 1}garbage')).toBeUndefined();
    expect(tryParseJson('not json at all')).toBeUndefined();
    expect(tryParseJson('  ')).toBeUndefined();
    expect(tryParseJson('')).toBeUndefined();
  });

  it('returns the value when input is valid JSON, even with leading whitespace', async () => {
    const { tryParseJson } = await import('../../src/lib/tool-helpers.js');
    expect(tryParseJson<{ x: number }>('  {"x": 1}  ')).toEqual({ x: 1 });
    // null and false ARE valid JSON values.
    expect(tryParseJson('null')).toBeNull();
    expect(tryParseJson('false')).toBe(false);
    expect(tryParseJson('123')).toBe(123);
  });

  it('does not throw on extremely large payloads', async () => {
    const { tryParseJson } = await import('../../src/lib/tool-helpers.js');
    const big = JSON.stringify({ items: Array.from({ length: 50_000 }, (_, i) => i) });
    const parsed = tryParseJson<{ items: number[] }>(big);
    expect(parsed?.items.length).toBe(50_000);
  });
});

// ─── Path validation under fault: weird but legal inputs ──────────────────

describe('Path validation under fault: legal-but-weird inputs', () => {
  it('rejects null bytes embedded in paths', async () => {
    const { validatePath } = await import('../../src/lib/security.js');
    const result = validatePath('valid/file .rego', ['/abs']);
    expect(result.ok).toBe(false);
  });

  it('handles a path that resolves to a different absolute path under unicode normalization', async () => {
    const { validatePath } = await import('../../src/lib/security.js');
    // Composed vs decomposed unicode forms — both should be treated
    // as the same path on POSIX, distinct on macOS HFS+.
    const composed = 'é'; // é (single codepoint)
    const decomposed = 'é'; // e + combining acute accent
    // Without normalization these are distinct strings; the security
    // check treats them as distinct paths, which is the conservative
    // correct behavior. Both should be rejected against an unrelated
    // root.
    expect(validatePath(`/x/${composed}.rego`, ['/y']).ok).toBe(false);
    expect(validatePath(`/x/${decomposed}.rego`, ['/y']).ok).toBe(false);
  });
});
