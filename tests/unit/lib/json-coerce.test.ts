import { describe, expect, it } from 'vitest';

import { coerceJsonArg } from '../../../src/lib/json-coerce.js';

describe('coerceJsonArg', () => {
  it('re-parses a stringified JSON object into an object', () => {
    expect(coerceJsonArg('{"role":"admin","n":42}')).toEqual({ role: 'admin', n: 42 });
  });

  it('re-parses a stringified JSON array into an array', () => {
    expect(coerceJsonArg('["alice","bob"]')).toEqual(['alice', 'bob']);
  });

  it('returns an already-structured object or array unchanged (idempotent)', () => {
    const obj = { a: 1 };
    expect(coerceJsonArg(obj)).toBe(obj);
    const arr = [1, 2];
    expect(coerceJsonArg(arr)).toBe(arr);
  });

  it('leaves a non-JSON string as-is', () => {
    expect(coerceJsonArg('hello world')).toBe('hello world');
    expect(coerceJsonArg('{not valid json')).toBe('{not valid json');
  });

  it('never retypes scalar JSON strings (a genuine string argument is preserved)', () => {
    expect(coerceJsonArg('42')).toBe('42');
    expect(coerceJsonArg('true')).toBe('true');
    expect(coerceJsonArg('null')).toBe('null');
    expect(coerceJsonArg('"quoted"')).toBe('"quoted"');
  });

  it('passes through non-string scalars untouched', () => {
    expect(coerceJsonArg(42)).toBe(42);
    expect(coerceJsonArg(true)).toBe(true);
    expect(coerceJsonArg(undefined)).toBeUndefined();
    expect(coerceJsonArg(null)).toBeNull();
  });
});
