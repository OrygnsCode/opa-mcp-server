/**
 * The Z3 singleton: memory cap, busy flag and the give-up switch that the
 * server's uncaughtException handler flips.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  Z3_MEMORY_MAX_MB,
  Z3_SOLVER_MAX_MEMORY_MB,
  deferredFinalizersForTesting,
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

/** A forced collection, without leaving the flag set for the rest of the run. */
async function exposeGc(): Promise<() => void> {
  const { setFlagsFromString } = await import('node:v8');
  const { runInNewContext } = await import('node:vm');
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  setFlagsFromString('--no-expose-gc');
  return gc;
}

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
    const overflow = (frames: string) => {
      const e = new RangeError('Maximum call stack size exceeded');
      e.stack = `RangeError: Maximum call stack size exceeded${frames}`;
      return e;
    };
    expect(
      isZ3Failure(overflow('\n    at check (/x/node_modules/z3-solver/build/z3-built.js:9:1)')),
    ).toBe(true);
    expect(isZ3Failure(overflow('\n    at walk (/x/src/lib/rego-ast-walker.ts:9:1)'))).toBe(false);
    // No frames to read: the conservative answer.
    expect(isZ3Failure(overflow(''))).toBe(true);
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

  it("routes z3-solver's own finalizers through the section, and puts the global back", async () => {
    const Real = globalThis.FinalizationRegistry;
    resetZ3ForTesting();
    const pending = getZ3();
    // An unrelated registry built while z3-solver initialises must not take
    // the wrap: it gets the real behaviour, and z3-solver's is still wrapped.
    const decoyFired: string[] = [];
    const decoy = new FinalizationRegistry<string>((held) => decoyFired.push(held));
    const Z3 = await pending;
    expect(globalThis.FinalizationRegistry).toBe(Real);
    // Make garbage Z3 objects inside a section and collect while it is open:
    // their frees must queue rather than run.
    const gc = await exposeGc();
    let queuedInside = 0;
    let decoyInside = 0;
    await withZ3Lock(async () => {
      // Registered from its own frame so nothing on this one keeps it alive.
      (() => decoy.register({}, 'decoy-held'))();
      for (let i = 0; i < 2000; i++) Z3.Real.const(`g${i}`).add(1);
      gc();
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 20 && decoyFired.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      queuedInside = deferredFinalizersForTesting();
      decoyInside = decoyFired.length;
    });
    // The decoy's callback ran at once; z3-solver's waited for the section.
    expect(decoyInside).toBe(1);
    expect(queuedInside).toBeGreaterThan(0);
    // The section closed with the worker idle, and they ran.
    expect(deferredFinalizersForTesting()).toBe(0);
  }, 30_000);

  it("still wraps z3-solver's registry when the host keeps no stack frames", async () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    resetZ3ForTesting();
    const Z3 = await getZ3().finally(() => {
      Error.stackTraceLimit = limit;
    });
    const gc = await exposeGc();
    let queuedInside = 0;
    await withZ3Lock(async () => {
      for (let i = 0; i < 2000; i++) Z3.Real.const(`h${i}`).add(1);
      gc();
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      queuedInside = deferredFinalizersForTesting();
    });
    expect(queuedInside).toBeGreaterThan(0);
    expect(deferredFinalizersForTesting()).toBe(0);
  }, 30_000);

  it('does not wedge the lock when a deferred finalizer throws', async () => {
    await withZ3Lock(async () => {
      enqueueFinalizerForTesting(() => {
        throw new Error('a free that fails');
      });
      await Promise.resolve();
    });
    // The next section still acquires.
    const ran = await withZ3Lock(() => Promise.resolve('ran'));
    expect(ran).toBe('ran');
  });

  it('drops the deferred finalizers the moment the module is given up on', async () => {
    await getZ3();
    await withZ3Lock(async () => {
      enqueueFinalizerForTesting(() => {
        throw new Error('must never run against the dead heap');
      });
      expect(deferredFinalizersForTesting()).toBe(1);
      markZ3Unusable('test fault');
      expect(deferredFinalizersForTesting()).toBe(0);
      await Promise.resolve();
    }).catch(() => undefined);
    expect(deferredFinalizersForTesting()).toBe(0);
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
