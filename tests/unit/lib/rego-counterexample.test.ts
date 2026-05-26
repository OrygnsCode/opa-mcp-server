/**
 * Unit tests for rego-counterexample.ts.
 *
 * These tests use real Z3 to build a SAT model, then verify that
 * extractCounterexample correctly converts Z3 variable values to
 * a nested JSON object with the right structure and types.
 */
import { describe, expect, it } from 'vitest';
import { init } from 'z3-solver';

import {
  extractCounterexample,
  formatCounterexample,
} from '../../../src/lib/rego-counterexample.js';
import type { Z3Sort } from '../../../src/lib/rego-type-inferencer.js';

// Shared Z3 context - initialized once for the whole suite.
// Vitest runs each test file in a worker, so this is safe.
 
let Z3: any;

async function getZ3(): Promise<ReturnType<Awaited<ReturnType<typeof init>>['Context']>> {
  if (!Z3) {
    const { Context } = await init();
    Z3 = Context('test');
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return Z3;
}

describe('extractCounterexample - string var', () => {
  it('extracts a string value from a Z3 model', async () => {
    const Z3 = await getZ3();
    const roleVar = Z3.String.const('input__user__role');
    const solver = new Z3.Solver();
    solver.add(Z3.Eq(roleVar, Z3.String.val('admin')));

    expect(await solver.check()).toBe('sat');
    const model = solver.model();

    const inputVars = new Map([
      [
        'input.user.role',
        roleVar,
      ],
    ]);
    const sorts = new Map<string, Z3Sort>([['input.user.role', 'string']]);

    const ce = extractCounterexample(model, inputVars, sorts);
    expect(ce).toEqual({ user: { role: 'admin' } });
  });

  it('extracts empty string correctly', async () => {
    const Z3 = await getZ3();
    const v = Z3.String.const('input__x');
    const solver = new Z3.Solver();
    solver.add(Z3.Eq(v, Z3.String.val('')));
    expect(await solver.check()).toBe('sat');
    const model = solver.model();

    const inputVars = new Map([['input.x', v as never]]);
    const sorts = new Map<string, Z3Sort>([['input.x', 'string']]);
    const ce = extractCounterexample(model, inputVars, sorts);
    expect(ce).toEqual({ x: '' });
  });
});

describe('extractCounterexample - int var', () => {
  it('extracts an integer value from a Z3 model', async () => {
    const Z3 = await getZ3();
    const ageVar = Z3.Int.const('input__user__age');
    const solver = new Z3.Solver();
    solver.add(Z3.Eq(ageVar, Z3.Int.val(42)));
    expect(await solver.check()).toBe('sat');
    const model = solver.model();

    const inputVars = new Map([['input.user.age', ageVar as never]]);
    const sorts = new Map<string, Z3Sort>([['input.user.age', 'int']]);
    const ce = extractCounterexample(model, inputVars, sorts);
    expect(ce).toEqual({ user: { age: 42 } });
  });

  it('extracts negative integer correctly', async () => {
    const Z3 = await getZ3();
    const v = Z3.Int.const('input__n');
    const solver = new Z3.Solver();
    solver.add(Z3.Eq(v, Z3.Int.val(-7)));
    expect(await solver.check()).toBe('sat');
    const model = solver.model();

    const inputVars = new Map([['input.n', v as never]]);
    const sorts = new Map<string, Z3Sort>([['input.n', 'int']]);
    const ce = extractCounterexample(model, inputVars, sorts);
    expect(ce).toEqual({ n: -7 });
  });
});

describe('extractCounterexample - bool var', () => {
  it('extracts true from a Z3 model', async () => {
    const Z3 = await getZ3();
    const v = Z3.Bool.const('input__verified');
    const solver = new Z3.Solver();
    solver.add(Z3.Eq(v, Z3.Bool.val(true)));
    expect(await solver.check()).toBe('sat');
    const model = solver.model();

    const inputVars = new Map([['input.verified', v as never]]);
    const sorts = new Map<string, Z3Sort>([['input.verified', 'bool']]);
    const ce = extractCounterexample(model, inputVars, sorts);
    expect(ce).toEqual({ verified: true });
  });

  it('extracts false from a Z3 model', async () => {
    const Z3 = await getZ3();
    const v = Z3.Bool.const('input__active');
    const solver = new Z3.Solver();
    solver.add(Z3.Eq(v, Z3.Bool.val(false)));
    expect(await solver.check()).toBe('sat');
    const model = solver.model();

    const inputVars = new Map([['input.active', v as never]]);
    const sorts = new Map<string, Z3Sort>([['input.active', 'bool']]);
    const ce = extractCounterexample(model, inputVars, sorts);
    expect(ce).toEqual({ active: false });
  });
});

describe('extractCounterexample - nested paths', () => {
  it('builds nested object for multi-segment paths', async () => {
    const Z3 = await getZ3();
    const roleVar = Z3.String.const('input__user__role');
    const deptVar = Z3.String.const('input__user__dept');
    const actionVar = Z3.String.const('input__action');
    const solver = new Z3.Solver();
    solver.add(Z3.Eq(roleVar, Z3.String.val('admin')));
    solver.add(Z3.Eq(deptVar, Z3.String.val('eng')));
    solver.add(Z3.Eq(actionVar, Z3.String.val('read')));
    expect(await solver.check()).toBe('sat');
    const model = solver.model();

    const inputVars = new Map<string, never>([
      ['input.user.role', roleVar as never],
      ['input.user.dept', deptVar as never],
      ['input.action', actionVar as never],
    ]);
    const sorts = new Map<string, Z3Sort>([
      ['input.user.role', 'string'],
      ['input.user.dept', 'string'],
      ['input.action', 'string'],
    ]);
    const ce = extractCounterexample(model, inputVars, sorts);
    expect(ce).toEqual({
      user: { role: 'admin', dept: 'eng' },
      action: 'read',
    });
  });
});

describe('formatCounterexample', () => {
  it('wraps the counterexample in an input key', () => {
    const ce = { user: { role: 'viewer' }, action: 'write' };
    const formatted = formatCounterexample(ce);
    const parsed = JSON.parse(formatted);
    expect(parsed).toEqual({ input: ce });
  });

  it('produces pretty-printed JSON', () => {
    const ce = { role: 'admin' };
    const formatted = formatCounterexample(ce);
    // Pretty-printed has newlines
    expect(formatted).toContain('\n');
  });
});
