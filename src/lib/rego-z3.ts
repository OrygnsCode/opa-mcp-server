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

// Module-level singleton
let z3InitPromise: Promise<unknown> | null = null;

/**
 * Return the shared Z3 Context, initializing WASM on first call.
 * Safe to call from concurrent async paths.
 */
export async function getZ3(): Promise<Z3Context> {
  if (z3InitPromise === null) {
    z3InitPromise = init().then(({ Context }) => Context('main'));
  }
  return z3InitPromise as Promise<Z3Context>;
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
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Reset the singleton - intended for test teardown only.
 * Do NOT call in production paths; re-init is expensive.
 */
export function resetZ3ForTesting(): void {
  z3InitPromise = null;
  z3LockTail = Promise.resolve();
}
