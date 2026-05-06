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
  OpaUnreachableError,
} from '../../../src/lib/opa-client.js';
import { mapOpaClientError } from '../../../src/tools/server-management/_shared.js';

describe('mapOpaClientError', () => {
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
    const env = mapOpaClientError(
      new OpaHttpError(500, { error: 'internal' }),
    );
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

  it('wraps a plain Error (not an OpaClient subclass) with its message and stack', () => {
    const env = mapOpaClientError(new TypeError('something went wrong'));
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toBe('something went wrong');
    const details = env.error?.details as { stack?: string };
    expect(typeof details.stack).toBe('string');
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
