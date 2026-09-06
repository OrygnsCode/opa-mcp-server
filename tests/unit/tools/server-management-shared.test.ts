/**
 * Direct tests for the server-management _shared error mapper.
 *
 * Covers the branches the per-tool tests don't explicitly hit:
 * non-404 HTTP errors, plain Error objects (not OpaClient-typed),
 * and non-Error throws (string, number, undefined).
 */
import { describe, expect, it } from 'vitest';

import {
  OpaAuthError,
  OpaHttpError,
  OpaTimeoutError,
  OpaUnreachableError,
  OpaUrlCredentialsError,
} from '../../../src/lib/opa-client.js';
import {
  mapOpaClientError,
  parseOpaDataPath,
} from '../../../src/tools/server-management/_shared.js';

describe('parseOpaDataPath', () => {
  it('converts dotted form to slash API path', () => {
    const result = parseOpaDataPath('users.alice');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apiPath).toBe('/v1/data/users/alice');
  });

  it('strips leading data. prefix', () => {
    const result = parseOpaDataPath('data.rbac.roles');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apiPath).toBe('/v1/data/rbac/roles');
  });

  it('strips leading slashes', () => {
    const result = parseOpaDataPath('/users/alice');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apiPath).toBe('/v1/data/users/alice');
  });

  it('rejects the root, which no data tool addresses through a path', () => {
    const result = parseOpaDataPath('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error?.code).toBe('INVALID_INPUT');
  });

  it('keeps a dot inside a key when the path is slash-separated', () => {
    // Splitting on both separators turned `example.com` into two segments and
    // read a different document than the one asked for.
    const result = parseOpaDataPath('hosts/example.com');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.segments).toEqual(['hosts', 'example.com']);
      expect(result.apiPath).toBe('/v1/data/hosts/example.com');
    }
  });

  it('reads a path with no slash as dotted', () => {
    const result = parseOpaDataPath('hosts.example.com');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.segments).toEqual(['hosts', 'example', 'com']);
  });

  it('takes array segments literally, separators and all', () => {
    const result = parseOpaDataPath(['labels', 'app.kubernetes.io/name']);
    expect(result.ok).toBe(true);
    // OPA decodes the segment, so the slash stays part of the key.
    if (result.ok) expect(result.apiPath).toBe('/v1/data/labels/app.kubernetes.io%2Fname');
  });

  it('encodes characters that would otherwise end the path', () => {
    const cases: Array<[string, string]> = [
      ['a?b', '/v1/data/k/a%3Fb'],
      ['a#b', '/v1/data/k/a%23b'],
      ['100%', '/v1/data/k/100%25'],
      ['a b', '/v1/data/k/a%20b'],
      ['caf\u00e9', '/v1/data/k/caf%C3%A9'],
    ];
    for (const [key, expected] of cases) {
      const result = parseOpaDataPath(['k', key]);
      expect(result.ok, key).toBe(true);
      if (result.ok) expect(result.apiPath, key).toBe(expected);
    }
  });

  it('rejects a literal .. segment', () => {
    const result = parseOpaDataPath('../../v1/config');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error?.message).toMatch(/traversal/);
  });

  it('rejects a .. segment supplied as an array element', () => {
    expect(parseOpaDataPath(['..', 'v1', 'config']).ok).toBe(false);
  });

  it('rejects an empty segment', () => {
    expect(parseOpaDataPath('users//alice').ok).toBe(false);
  });

  it('does not strip a prefix that merely starts with data', () => {
    const result = parseOpaDataPath('database/rows');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.segments).toEqual(['database', 'rows']);
  });

  it('strips a leading data/ root in slash form', () => {
    const result = parseOpaDataPath('data/rbac/roles');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apiPath).toBe('/v1/data/rbac/roles');
  });

  it('rejects percent-encoded single .. traversal (%2e%2e)', () => {
    // Segments are encoded before they reach the wire, so this could not
    // escape /v1/data/ any more; a caller writing it still means to traverse.
    const result = parseOpaDataPath('%2e%2e/v1/config');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects percent-encoded double .. traversal (%2e%2e/%2e%2e)', () => {
    const result = parseOpaDataPath('%2e%2e/%2e%2e/v1/config');
    expect(result.ok).toBe(false);
  });

  it('rejects uppercase percent-encoded .. traversal (%2E%2E)', () => {
    const result = parseOpaDataPath('%2E%2E/v1/config');
    expect(result.ok).toBe(false);
  });
});

describe('mapOpaClientError', () => {
  it('maps OpaUrlCredentialsError to OPA_URL_INVALID with the secret redacted', () => {
    const env = mapOpaClientError(
      new OpaUrlCredentialsError('http://alice:s3cret@opa.example.com'),
    );
    expect(env.error?.code).toBe('OPA_URL_INVALID');
    expect(JSON.stringify(env)).not.toContain('s3cret');
    expect(env.error?.hint).toMatch(/OPA_TOKEN/);
  });

  it('maps OpaTimeoutError to TIMEOUT, naming the limit, not to unreachable', () => {
    const env = mapOpaClientError(new OpaTimeoutError('http://opa.example.com', 15_000));
    expect(env.error?.code).toBe('TIMEOUT');
    expect(env.error?.message).toContain('15000 ms');
    expect(env.error?.hint).toMatch(/OPA_MCP_HTTP_TIMEOUT_MS/);
    expect(env.error?.hint).not.toMatch(/opa run --server/);
    expect(env.error?.details).toMatchObject({ url: 'http://opa.example.com', timeoutMs: 15_000 });
  });

  it('maps OpaUnreachableError with url + cause and helpful hint', () => {
    const err = new OpaUnreachableError('http://opa.example.com', new Error('refused'));
    const env = mapOpaClientError(err);
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
    expect(env.error?.message).toContain('http://opa.example.com');
    expect(env.error?.hint).toMatch(/curl/);
    const details = env.error?.details as { url?: string };
    expect(details.url).toBe('http://opa.example.com');
  });

  it('maps OpaAuthError to OPA_AUTH_FAILED with a token-related hint', () => {
    const env = mapOpaClientError(new OpaAuthError());
    expect(env.error?.code).toBe('OPA_AUTH_FAILED');
    expect(env.error?.hint).toMatch(/OPA_TOKEN/);
  });

  it('maps OpaHttpError 404 to the caller-supplied notFoundCode', () => {
    const env = mapOpaClientError(
      new OpaHttpError(404, { message: 'not found' }),
      'POLICY_NOT_FOUND',
    );
    expect(env.error?.code).toBe('POLICY_NOT_FOUND');
    const details = env.error?.details as { status?: number; body?: unknown };
    expect(details.status).toBe(404);
    expect(details.body).toEqual({ message: 'not found' });
  });

  it('maps OpaHttpError 404 to UNKNOWN_ERROR when no notFoundCode is provided', () => {
    const env = mapOpaClientError(new OpaHttpError(404, {}));
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('maps OpaHttpError 5xx to UNKNOWN_ERROR with status + body in details', () => {
    const env = mapOpaClientError(new OpaHttpError(500, { error: 'internal' }));
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toContain('HTTP 500');
    const details = env.error?.details as { status?: number; body?: unknown };
    expect(details.status).toBe(500);
    expect(details.body).toEqual({ error: 'internal' });
  });

  it('maps OpaHttpError 400/422 the same way (any non-401 non-404 non-2xx)', () => {
    const bad = mapOpaClientError(new OpaHttpError(400, 'bad request'));
    const unproc = mapOpaClientError(new OpaHttpError(422, 'unprocessable'));
    expect(bad.error?.code).toBe('UNKNOWN_ERROR');
    expect(unproc.error?.code).toBe('UNKNOWN_ERROR');
    expect((bad.error?.details as { status?: number }).status).toBe(400);
    expect((unproc.error?.details as { status?: number }).status).toBe(422);
  });

  it('wraps a plain Error with its message but does not leak a stack trace to the client', () => {
    const env = mapOpaClientError(new TypeError('something went wrong'));
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toBe('something went wrong');
    // The stack is logged server-side, never returned to the client (it would
    // leak absolute filesystem paths).
    expect(env.error?.details).toBeUndefined();
  });

  it('wraps a string throw with the value preserved in details', () => {
    const env = mapOpaClientError('oops a string was thrown');
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toBe('Unknown error');
    expect(env.error?.details).toEqual({ value: 'oops a string was thrown' });
  });

  it('wraps a number throw without crashing', () => {
    const env = mapOpaClientError(42);
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.details).toEqual({ value: 42 });
  });

  it('wraps undefined / null without crashing', () => {
    const undef = mapOpaClientError(undefined);
    expect(undef.error?.code).toBe('UNKNOWN_ERROR');
    expect(undef.error?.details).toEqual({ value: undefined });

    const nullEnv = mapOpaClientError(null);
    expect(nullEnv.error?.code).toBe('UNKNOWN_ERROR');
    expect(nullEnv.error?.details).toEqual({ value: null });
  });

  it('preserves an empty body on OpaHttpError', () => {
    const env = mapOpaClientError(new OpaHttpError(503, ''));
    const details = env.error?.details as { body?: unknown };
    expect(details.body).toBe('');
  });
});
