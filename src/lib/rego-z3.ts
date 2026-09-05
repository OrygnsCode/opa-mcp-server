/**
 * Z3 singleton initialization.
 *
 * The z3-solver WASM module takes ~500ms to load and must only be
 * initialized once per process. Concurrent calls safely await the
 * same promise. Each verification call creates its own fresh Solver
 * from the shared Context, so contexts never accumulate stale state.
 *
 * A fresh Solver is NOT enough to make concurrent verification safe. The whole
 * Context lives in one single-threaded WASM heap, and `check()` is async, so two
 * overlapping solves interleave on that heap and corrupt each other: observed
 * symptoms were verdicts degrading to `inconclusive` and an allocator crash
 * inside the WASM module. Everything touching the Context must therefore run
 * under `withZ3Lock`.
 */
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

/**
 * Return the shared Z3 Context, initializing WASM on first call.
 * Safe to call from concurrent async paths.
 */
export async function getZ3(): Promise<Z3Context> {
  if (z3Unusable !== undefined) {
    throw new Error(
      `Z3 is unavailable in this process after an earlier failure (${z3Unusable}). Restart the server to verify again.`,
    );
  }
  if (z3InitPromise === null) {
    z3InitPromise = init().then((api) => {
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
 * Give up on Z3 for the rest of the process. Called when it failed outside a
 * try/catch: the heap it lives in cannot be trusted, and re-initialising it
 * would put the next call on the same heap.
 */
export function markZ3Unusable(reason: string): void {
  z3Unusable = reason;
  // A heap abort arrives from the WASM worker and leaves the solve's promise
  // unsettled for good. Settle it here, so the section releases the lock and
  // the calls queued behind it are answered instead of hanging.
  poisonInFlight?.(new Error(`Z3 became unusable during the solve (${reason}).`));
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
}
