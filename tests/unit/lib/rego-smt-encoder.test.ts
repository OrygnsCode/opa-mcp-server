import { describe, expect, it } from 'vitest';

import { z3String } from '../../../src/lib/rego-smt-encoder.js';

describe('z3String', () => {
  it('escapes every backslash so Z3 stores it as a character', () => {
    const bs = String.fromCharCode(92);
    const calls: string[] = [];
    const Z3 = { String: { val: (v: string) => (calls.push(v), v) } } as unknown as Parameters<
      typeof z3String
    >[0];
    z3String(Z3, `a${bs}u{41}${bs}${bs}b`);
    expect(calls).toEqual([`a${bs}u{5c}u{41}${bs}u{5c}${bs}u{5c}b`]);
  });
});
