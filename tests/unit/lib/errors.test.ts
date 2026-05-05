import { describe, expect, it } from 'vitest';
import { err, fromException, ok } from '../../../src/lib/errors.js';

describe('ok()', () => {
  it('returns a success envelope with the given data', () => {
    const envelope = ok({ value: 42 });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ value: 42 });
    expect(envelope.error).toBeUndefined();
    expect(envelope.warnings).toBeUndefined();
  });

  it('omits the warnings field when no warnings are passed', () => {
    const envelope = ok('payload');
    expect('warnings' in envelope).toBe(false);
  });

  it('omits the warnings field when an empty array is passed', () => {
    const envelope = ok('payload', []);
    expect('warnings' in envelope).toBe(false);
  });

  it('includes warnings when provided', () => {
    const envelope = ok('payload', ['stale-cache']);
    expect(envelope.warnings).toEqual(['stale-cache']);
  });
});

describe('err()', () => {
  it('returns a failure envelope with the given code and message', () => {
    const envelope = err('INVALID_INPUT', 'missing field "policy"');
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toEqual({
      code: 'INVALID_INPUT',
      message: 'missing field "policy"',
    });
    expect(envelope.data).toBeUndefined();
  });

  it('includes hint and details when provided', () => {
    const envelope = err('PATH_NOT_ALLOWED', 'outside allow-list', {
      hint: 'add the directory to OPA_MCP_ALLOWED_PATHS',
      details: { attempted: '/etc/passwd' },
    });
    expect(envelope.error?.hint).toBe('add the directory to OPA_MCP_ALLOWED_PATHS');
    expect(envelope.error?.details).toEqual({ attempted: '/etc/passwd' });
  });

  it('omits hint and details when not provided', () => {
    const envelope = err('TIMEOUT', 'subprocess timed out after 30s');
    expect('hint' in (envelope.error ?? {})).toBe(false);
    expect('details' in (envelope.error ?? {})).toBe(false);
  });
});

describe('fromException()', () => {
  it('wraps an Error with its message and stack', () => {
    const e = new Error('boom');
    const envelope = fromException(e);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('UNKNOWN_ERROR');
    expect(envelope.error?.message).toBe('boom');
    expect(envelope.error?.details).toMatchObject({ stack: expect.any(String) });
  });

  it('wraps a non-Error throw with a generic message', () => {
    const envelope = fromException('something bad');
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('UNKNOWN_ERROR');
    expect(envelope.error?.message).toBe('An unknown error occurred');
    expect(envelope.error?.details).toBe('something bad');
  });

  it('wraps null without throwing', () => {
    const envelope = fromException(null);
    expect(envelope.error?.details).toBeNull();
  });
});
