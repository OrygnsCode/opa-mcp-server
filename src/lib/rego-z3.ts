/**
 * Z3 singleton initialization.
 *
 * The z3-solver WASM module takes ~500ms to load and must only be
 * initialized once per process. Concurrent calls safely await the
 * same promise. Each verification call creates its own fresh Solver
 * from the shared Context, so contexts never accumulate stale state.
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
 * Reset the singleton - intended for test teardown only.
 * Do NOT call in production paths; re-init is expensive.
 */
export function resetZ3ForTesting(): void {
  z3InitPromise = null;
}
