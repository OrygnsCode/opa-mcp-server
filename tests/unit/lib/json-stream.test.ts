import { describe, expect, it } from 'vitest';

import { parseJsonValues } from '../../../src/lib/json-stream.js';

describe('parseJsonValues', () => {
  it('reads a single array', () => {
    expect(parseJsonValues('[1, 2, 3]')).toEqual([[1, 2, 3]]);
  });

  it('reads concatenated pretty-printed arrays, which is what opa test --count prints', () => {
    const text = '[\n  {"name": "a"}\n]\n[\n  {"name": "a"}\n]\n';
    expect(parseJsonValues(text)).toEqual([[{ name: 'a' }], [{ name: 'a' }]]);
  });

  it('reads concatenated objects', () => {
    expect(parseJsonValues('{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('is not fooled by brackets inside strings', () => {
    const text = '[{"msg": "a ] and a } and a \\" quote"}]';
    expect(parseJsonValues(text)).toEqual([[{ msg: 'a ] and a } and a " quote' }]]);
  });

  it('is not fooled by an escaped backslash before a quote', () => {
    const text = String.raw`[{"path": "C:\\"}]`;
    expect(parseJsonValues(text)).toEqual([[{ path: 'C:\\' }]]);
  });

  it('returns nothing for text that holds no JSON value', () => {
    expect(parseJsonValues('')).toEqual([]);
    expect(parseJsonValues('not json at all')).toEqual([]);
  });

  it('skips a malformed value and keeps the rest', () => {
    // The first array is unbalanced inside, so only the second survives.
    expect(parseJsonValues('[1, 2,]\n[3]')).toEqual([[3]]);
  });

  it('ignores a stray closing bracket rather than throwing', () => {
    expect(parseJsonValues(']]}[1]')).toEqual([[1]]);
  });

  it('handles values separated by arbitrary whitespace', () => {
    expect(parseJsonValues('  [1]\r\n\r\n  [2]  ')).toEqual([[1], [2]]);
  });
});
