/**
 * The Z3 singleton: memory cap, busy flag and the give-up switch that the
 * server's uncaughtException handler flips.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  Z3_MEMORY_MAX_MB,
  Z3_SOLVER_MAX_MEMORY_MB,
  enqueueFinalizerForTesting,
  getZ3,
  getZ3Param,
  isZ3Busy,
  isZ3Failure,
  markZ3Unusable,
  resetZ3ForTesting,
  withZ3Lock,
  z3RecoveriesLeft,
} from '../../../src/lib/rego-z3.js';

afterEach(() => {
  resetZ3ForTesting();
});

describe('rego-z3', () => {
  it('caps Z3 memory when it initialises', async () => {
    await getZ3();
    expect(await getZ3Param('memory_max_size')).toBe(String(Z3_MEMORY_MAX_MB));
  }, 30_000);

  it('knows when a critical section is running', async () => {
    expect(isZ3Busy()).toBe(false);
    await withZ3Lock(async () => {
      expect(isZ3Busy()).toBe(true);
      return Promise.resolve();
    });
    expect(isZ3Busy()).toBe(false);
  });

  it('clears the busy flag when the section throws', async () => {
    await expect(withZ3Lock(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(isZ3Busy()).toBe(false);
  });

  it('keeps the solver bound below the process ceiling', () => {
    expect(Z3_SOLVER_MAX_MEMORY_MB).toBeLessThan(Z3_MEMORY_MAX_MB);
  });

  it('settles a section in flight when Z3 is marked unusable, and the lock drains', async () => {
    // A heap abort leaves the solve's promise unsettled forever; without the
    // poison this call and every call queued behind it hung, and the busy
    // flag stayed up so every later uncaught error was swallowed too.
    const stuck = withZ3Lock(() => new Promise<never>(() => undefined));
    const queued = withZ3Lock(() => Promise.resolve('after'));
    // The section enters after its await on the queue; give it that tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isZ3Busy()).toBe(true);
    markZ3Unusable('heap abort');
    await expect(stuck).rejects.toThrow(/heap abort/);
    await expect(queued).resolves.toBe('after');
    expect(isZ3Busy()).toBe(false);
  });

  it('recognises a WASM fault and nothing else', () => {
    expect(isZ3Failure(new Error('Aborted(native code called abort())'))).toBe(true);
    expect(isZ3Failure(new Error('memory access out of bounds'))).toBe(true);
    expect(isZ3Failure(new Error('out of memory'))).toBe(true);
    expect(isZ3Failure(new Error('connect ECONNREFUSED 127.0.0.1:8181'))).toBe(false);
    expect(isZ3Failure(new TypeError('fetch failed'))).toBe(false);
  });

  it('brings up a fresh module after a fault, three times, then refuses', async () => {
    const first = await getZ3();
    expect(z3RecoveriesLeft()).toBe(3);
    markZ3Unusable('test fault');
    const second = await getZ3();
    expect(second).not.toBe(first);
    expect(z3RecoveriesLeft()).toBe(2);
    // The fresh module solves.
    const x = second.Real.const('x');
    const solver = new second.Solver();
    solver.add(x.gt(5), x.lt(6));
    expect(await solver.check()).toBe('sat');
    solver.release();
    markZ3Unusable('again');
    await getZ3();
    markZ3Unusable('and again');
    await getZ3();
    expect(z3RecoveriesLeft()).toBe(0);
    markZ3Unusable('one too many');
    await expect(getZ3()).rejects.toThrow(/repeated failures/);
  });

  it('holds a finalizer that arrives mid-section until the section closes', async () => {
    const order: string[] = [];
    await withZ3Lock(async () => {
      enqueueFinalizerForTesting(() => order.push('finalizer'));
      order.push('solving');
      await Promise.resolve();
      order.push('solved');
    });
    expect(order).toEqual(['solving', 'solved', 'finalizer']);
    // With no section open it runs at once.
    enqueueFinalizerForTesting(() => order.push('idle'));
    expect(order.at(-1)).toBe('idle');
  });
});
