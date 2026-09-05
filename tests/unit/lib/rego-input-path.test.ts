import { describe, expect, it } from 'vitest';

import { parseInputPath, renderInputPath } from '../../../src/lib/rego-input-path.js';

describe('input path rendering', () => {
  it('writes identifiers with dots and anything else with a quoted index', () => {
    expect(renderInputPath(['user', 'role'])).toBe('input.user.role');
    expect(renderInputPath(['a.b'])).toBe('input["a.b"]');
    expect(renderInputPath(['labels', 'app.kubernetes.io/name'])).toBe(
      'input.labels["app.kubernetes.io/name"]',
    );
    expect(renderInputPath(['x', 'a"b'])).toBe('input.x["a\\"b"]');
    expect(renderInputPath([])).toBe('input');
  });

  it('never renders two different segment lists the same way', () => {
    expect(renderInputPath(['a.b'])).not.toBe(renderInputPath(['a', 'b']));
    expect(renderInputPath(['a__b'])).not.toBe(renderInputPath(['a', 'b']));
  });

  it('parses its own rendering back, escapes included', () => {
    const lists = [['user', 'role'], ['a.b'], ['labels', 'app.kubernetes.io/name'], ['x', 'a"b']];
    for (const segs of lists) {
      expect(parseInputPath(renderInputPath(segs))).toEqual(segs);
    }
  });

  it('still reads a plain dotted path', () => {
    expect(parseInputPath('input.user.role')).toEqual(['user', 'role']);
  });
});
