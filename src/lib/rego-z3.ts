/**
 * Z3 singleton initialization.
 *
 * The z3-solver WASM module takes ~500ms to load and is initialized once,
 * unless it faults, in which case a fresh one replaces it (see getZ3).
 * Concurrent calls safely await the same promise. Each verification call
 * creates its own fresh Solver from the shared Context and releases it as it
 * finishes; variables are named the same way every call, so Z3 shares their
 * declarations instead of growing.
 *
 * A fresh Solver is NOT enough to make concurrent verification safe. The whole
 * Context lives in one single-threaded WASM heap, and `check()` is async, so two
 * overlapping solves interleave on that heap and corrupt each other: observed
 * symptoms were verdicts degrading to `inconclusive` and an allocator crash
 * inside the WASM module. Everything touching the Context must therefore run
 * under `withZ3Lock`.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { init } from 'z3-solver';
import type { init as Z3Init } from 'z3-solver';

// The Context function is generic on the context-name literal. We use
// `unknown` in the promise and cast on the way out to avoid TypeScript
// complaints about `Context<"main">` not being assignable to `Context<string>`.
export type Z3Context = ReturnType<Awaited<ReturnType<typeof Z3Init>>['Context']>;

type Z3Api = Awaited<ReturnType<typeof Z3Init>>;

/**
 * Ceiling on Z3's own allocations, in megabytes. Reached, Z3 raises an
 * ordinary exception that the engine turns into an inconclusive verdict.
 * Without it the WASM heap itself runs out, and that abort surfaces outside
 * every try/catch as an uncaughtException that ends the server.
 */
export const Z3_MEMORY_MAX_MB = 1024;

/**
 * The solver's own bound, checked at its checkpoints, where running out
 * degrades to an "unknown" answer. It sits well below the process ceiling on
 * purpose: at the same value the allocator's exception won the race, and an
 * allocation failing inside a destructor ends in an abort rather than an
 * error. Measured in review: equal caps aborted four times in four; a lower
 * solver bound answered "unknown" four times in four.
 */
export const Z3_SOLVER_MAX_MEMORY_MB = 768;

// Module-level singleton
let z3InitPromise: Promise<unknown> | null = null;
let z3Api: Z3Api | undefined;
/** Set once Z3 has failed outside a try/catch; it is not trusted again. */
let z3Unusable: string | undefined;
/** Number of Z3 critical sections currently running (0 or 1). */
let z3Depth = 0;
/** Rejects the section in flight; set while one is running. */
let poisonInFlight: ((e: Error) => void) | undefined;

/** Generation of the module in use; a finalizer from an earlier one is dropped. */
let z3Generation = 0;
/** Finalizers that arrived while a solve was running, to run once it is not. */
let deferredFinalizers: Array<() => void> = [];
/** Fresh modules this process may still bring up after a fault. */
let recoveriesLeft = 3;
/** Solves since a collection was last requested. */
let solvesSinceCollection = 0;
/** Ask for a collection this often; cheap against a small heap. */
const COLLECT_EVERY = 100;

/**
 * Z3's memory lives outside the JavaScript heap, so the collector that runs
 * z3-solver's finalizers feels no pressure from it: measured, 1500 solves
 * took a process from 59 MB to 950 MB with the JavaScript heap at 20 MB
 * throughout, until Z3's own ceiling was reached. Node exposes `gc` only
 * behind a flag, which can be set at runtime for a context created after it.
 */
const forceCollection: (() => void) | undefined = (() => {
  try {
    setFlagsFromString('--expose-gc');
    return runInNewContext('gc') as () => void;
  } catch {
    return undefined;
  }
})();

/**
 * Bring up z3-solver with its finalizers routed through this module.
 *
 * z3-solver frees every AST, solver and model from one FinalizationRegistry,
 * built inside its createApi, whose callbacks run on the main thread whenever
 * the collector gets to them. A solve runs on a worker over the same shared
 * memory, and a callback landing mid-solve raced it on Z3's allocator and
 * faulted the heap (measured: a collection forced mid-solve crashed inside a
 * hundred solves; the same collection while the worker was idle ran 1500
 * clean). So a finalizer that arrives while a section is open waits for the
 * section to close, and one from a module that has since faulted is dropped.
 * The global is wrapped only for the duration of init().
 */
async function initModule(): Promise<Z3Api> {
  const Real = globalThis.FinalizationRegistry;
  const generation = z3Generation;
  class DeferringRegistry extends Real<unknown> {
    constructor(callback: (held: unknown) => void) {
      super((held: unknown) => {
        if (generation !== z3Generation) return;
        if (z3Depth > 0) deferredFinalizers.push(() => callback(held));
        else callback(held);
      });
    }
  }
  const g = globalThis as unknown as { FinalizationRegistry: unknown };
  g.FinalizationRegistry = DeferringRegistry;
  try {
    return await init();
  } finally {
    g.FinalizationRegistry = Real;
  }
}

/** Run the finalizers held back during a solve; only called with the worker idle. */
function runDeferredFinalizers(): void {
  const run = deferredFinalizers;
  deferredFinalizers = [];
  for (const finalizer of run) finalizer();
}

/**
 * Return the shared Z3 Context, initializing WASM on first call.
 * Safe to call from concurrent async paths.
 */
export async function getZ3(): Promise<Z3Context> {
  if (z3Unusable !== undefined) {
    if (recoveriesLeft === 0) {
      throw new Error(
        `Z3 is unavailable in this process after repeated failures (${z3Unusable}). Restart the server to verify again.`,
      );
    }
    // The heap that faulted cannot be trusted, so bring up a fresh module.
    // Every init() is a new WASM instance with its own memory and worker
    // (measured: two live side by side, independent, ~100 ms each), so
    // nothing is shared with the one that faulted; its finalizers are
    // dropped by generation.
    recoveriesLeft--;
    z3Generation++;
    deferredFinalizers = [];
    z3Unusable = undefined;
    z3InitPromise = null;
    z3Api = undefined;
  }
  if (z3InitPromise === null) {
    z3InitPromise = initModule().then((api) => {
      api.setParam('memory_max_size', Z3_MEMORY_MAX_MB);
      z3Api = api;
      return api.Context('main');
    });
  }
  return z3InitPromise as Promise<Z3Context>;
}

/** Read back a Z3 global parameter, after initialisation. */
export async function getZ3Param(name: string): Promise<string | null> {
  await getZ3();
  return z3Api?.getParam(name) ?? null;
}

/** Whether a Z3 critical section is running right now. */
export function isZ3Busy(): boolean {
  return z3Depth > 0;
}

/**
 * Give up on the Z3 module in use. Called when it failed outside a try/catch:
 * the heap it lives in cannot be trusted. The next call brings up a fresh
 * module, a bounded number of times per process.
 */
export function markZ3Unusable(reason: string): void {
  z3Unusable = reason;
  // A heap abort arrives from the WASM worker and leaves the solve's promise
  // unsettled for good. Settle it here, so the section releases the lock and
  // the calls queued behind it are answered instead of hanging.
  poisonInFlight?.(new Error(`Z3 became unusable during the solve (${reason}).`));
}

/**
 * Whether an error message is one of the two this module produces once Z3
 * has been given up on. The engine passes such a message through to the
 * caller verbatim, since a restart is the one thing they can do about it.
 */
export function isZ3UnavailableMessage(detail: string): boolean {
  return /Z3 (is unavailable|became unusable)/.test(detail);
}

/**
 * Whether a failure is the solve in flight being cut short by a fault, which
 * a fresh module can answer: the engine retries such a call once.
 */
export function isZ3RecoverableMessage(detail: string): boolean {
  return /Z3 became unusable during the solve/.test(detail);
}

/** How many fresh modules this process may still bring up after a fault. */
export function z3RecoveriesLeft(): number {
  return recoveriesLeft;
}

/**
 * For tests: what z3-solver's finalizers go through. Runs at once when no
 * section is open, otherwise once the open one closes.
 */
export function enqueueFinalizerForTesting(finalizer: () => void): void {
  if (z3Depth > 0) deferredFinalizers.push(finalizer);
  else finalizer();
}

/**
 * Whether an uncaught error is the WASM heap giving out, rather than some
 * unrelated failure that happened while a solve was running.
 */
export function isZ3Failure(e: unknown): boolean {
  // A WebAssembly.RuntimeError is named just that; the global is not in this
  // project's compiler libs, so the name is the check.
  if (e instanceof Error && e.name === 'RuntimeError') return true;
  const message = e instanceof Error ? e.message : String(e);
  return /Aborted\(|memory access out of bounds|out of memory|unreachable executed/i.test(message);
}

/**
 * Tail of the queue of pending Z3 critical sections. Each acquirer waits on the
 * current tail and installs its own completion as the new tail, so sections run
 * in call order with no overlap.
 */
let z3LockTail: Promise<void> = Promise.resolve();

/**
 * Run `fn` with exclusive access to the shared Z3 Context.
 *
 * Serializes rather than parallelizes: an MCP client is free to issue several
 * rego_verify calls at once, and letting them into the WASM heap together
 * crashes it. Solve times are in the tens of milliseconds, so queueing is
 * cheaper than the alternative of one Context per call, which would re-pay the
 * WASM init cost every time.
 */
export async function withZ3Lock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const predecessor = z3LockTail;
  z3LockTail = predecessor.then(() => mine);
  await predecessor;
  z3Depth++;
  const poisoned = new Promise<never>((_resolve, reject) => {
    poisonInFlight = reject;
  });
  try {
    return await Promise.race([fn(), poisoned]);
  } finally {
    poisonInFlight = undefined;
    z3Depth--;
    if (z3Depth === 0) {
      // The worker is idle: whatever the collector noticed mid-solve can be
      // freed now, and it is a safe moment to ask for the next collection.
      runDeferredFinalizers();
      if (forceCollection !== undefined && ++solvesSinceCollection >= COLLECT_EVERY) {
        solvesSinceCollection = 0;
        forceCollection();
      }
    }
    release();
  }
}

/**
 * Reset the singleton - intended for test teardown only.
 * Do NOT call in production paths; re-init is expensive.
 */
export function resetZ3ForTesting(): void {
  z3InitPromise = null;
  z3Api = undefined;
  z3Unusable = undefined;
  z3Depth = 0;
  poisonInFlight = undefined;
  z3LockTail = Promise.resolve();
  z3Generation++;
  deferredFinalizers = [];
  recoveriesLeft = 3;
  solvesSinceCollection = 0;
}
