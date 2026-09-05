/**
 * Subprocess wrapper used by `opa-cli.ts`, `regal-cli.ts` and `conftest-cli.ts`.
 *
 * - Uses argv arrays only (never shell strings) -- prevents injection.
 * - Hard timeout per invocation, defaulting to config.subprocessTimeoutMs.
 * - Captures stdout / stderr / exit code separately, each capped in bytes.
 * - Passes a minimal environment to the child, never the server's own.
 * - Optional stdin payload for piping source code.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { buildChildEnv } from './child-env.js';

/**
 * Per-stream capture ceiling.
 *
 * Two independent reasons this has to exist. A `Buffer` can hold far more than
 * a string can, so `Buffer.concat(...).toString('utf8')` throws once the capture
 * passes V8's max string length (536,870,888 bytes on Node 24) -- and it throws
 * inside an async 'close' handler, where nothing upstream can catch it. And well
 * before that limit the pipeline copies the payload several times over (chunks,
 * string, parsed object, sanitized clone), so a large capture costs multiples of
 * its own size in resident memory.
 *
 * 32 MiB sits far above what any of the wrapped commands produce in normal use
 * and far below the point where either problem bites. Override with
 * OPA_MCP_MAX_SUBPROCESS_BYTES.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface SpawnOptions {
  /** Argument vector passed directly to the binary. */
  args: string[];
  /** Optional stdin payload (e.g., Rego source). */
  stdin?: string;
  /** Working directory for the child process. */
  cwd?: string;
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
  /**
   * Extra environment variables for the child, merged over the minimal base
   * environment. The child never inherits the server's own `process.env`: a
   * policy can read its interpreter's environment through `opa.runtime().env`,
   * so anything passed here is readable by evaluated Rego. Pass secrets only
   * when the command genuinely needs them.
   */
  env?: Record<string, string>;
  /** External cancellation signal from the MCP client. */
  signal?: AbortSignal;
  /**
   * Maximum bytes to capture from stdout and from stderr, each counted
   * separately. On overflow the stream is clamped and the child is killed.
   */
  maxOutputBytes?: number;
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the process was killed due to client cancellation. */
  aborted: boolean;
  /** Time spent in milliseconds. */
  durationMs: number;
  /**
   * True when either stream hit `maxOutputBytes` and the child was killed.
   * Optional so the many hand-built SpawnResult fixtures in the test suite stay
   * valid; absent means "not truncated".
   */
  outputTruncated?: boolean;
  /**
   * The signal that ended the child, when one did. Set for the server's own
   * kills (timeout, cancellation, output cap) and for kills from outside it,
   * such as the kernel's out-of-memory killer. Optional for the same reason as
   * `outputTruncated`.
   */
  signal?: NodeJS.Signals | null;
}

/**
 * How long to wait for the stdio pipes to close once the child has exited.
 *
 * The child's own output is complete at 'exit'; 'close' follows when every
 * holder of the pipes is gone. A grandchild that inherited them, which is the
 * ordinary shape of a wrapper script around the binary, keeps 'close' from
 * ever firing, and a result that waits for it never settles.
 */
const PIPE_DRAIN_GRACE_MS = 1_000;

/** Grace between SIGTERM and SIGKILL. */
const KILL_ESCALATION_MS = 2_000;

/**
 * Signal the child, and on POSIX its whole process group, so a grandchild
 * started by a wrapper script dies with it. The child is spawned as a group
 * leader for this purpose; when the group is already gone, or the platform
 * has no groups, fall back to the child alone.
 */
function signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
  // The group is addressed by the child's pid, which the kernel may hand to
  // an unrelated process once the child has been reaped. Past that point only
  // the handle is safe to use, and Node's kill on a dead handle is a no-op.
  const unreaped = child.exitCode === null && child.signalCode === null;
  if (unreaped && process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      // ESRCH or EPERM: no group to signal. The child itself may still be there.
    }
  }
  child.kill(sig);
}

/** Children that have been spawned and have not settled yet. */
const liveChildren = new Set<ChildProcess>();

/**
 * Signal every child still running. A child sits in its own process group on
 * POSIX, so a signal that stops the server does not reach it on its own; the
 * server calls this on the way out. Returns how many were signalled.
 */
export function terminateChildren(sig: NodeJS.Signals = 'SIGTERM'): number {
  let n = 0;
  for (const child of liveChildren) {
    signalTree(child, sig);
    n++;
  }
  return n;
}

/** Accumulates a stream's chunks up to a byte ceiling. */
class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  /** Returns true when this chunk pushed the stream past its limit. */
  push(chunk: Buffer): boolean {
    if (this.overflowed) return false;

    const remaining = this.limit - this.bytes;
    // `<=` so output that lands exactly on the limit and then ends is a
    // complete capture, not a truncated one. If more follows, the next chunk
    // finds `remaining === 0` and overflows there instead.
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      return false;
    }

    // The whole payload can arrive as a single chunk -- `opa eval --format json`
    // marshals its result in memory and writes it in one burst at exit -- so the
    // offending chunk has to be clamped here. A running total that only rejects
    // the *next* chunk would never get a turn.
    if (remaining > 0) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.bytes += remaining;
    }
    this.overflowed = true;
    return true;
  }

  get didOverflow(): boolean {
    return this.overflowed;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.bytes).toString('utf8');
  }
}

/**
 * Run a binary and return its captured output. Never throws -- failures are
 * reflected in `exitCode` / `timedOut` / `outputTruncated`.
 */
export async function runBinary(binary: string, opts: SpawnOptions): Promise<SpawnResult> {
  const start = Date.now();

  if (opts.signal?.aborted) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
      durationMs: 0,
      outputTruncated: false,
    };
  }

  return await new Promise<SpawnResult>((resolvePromise) => {
    const child = spawn(binary, opts.args, {
      cwd: opts.cwd,
      env: buildChildEnv(opts.env),
      shell: false,
      windowsHide: true,
      // A process group of its own on POSIX, so a kill reaches a grandchild
      // as well. See signalTree.
      detached: process.platform !== 'win32',
    });

    const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const stdout = new CappedBuffer(limit);
    const stderr = new CappedBuffer(limit);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    /** Set once 'exit' has fired: the child is gone, only its pipes remain. */
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    liveChildren.add(child);

    // Whether the child has actually ended. `child.killed` is not that: Node
    // sets it as soon as a signal was sent, whether or not the child obeyed,
    // so a guard on it never escalated and a child that trapped SIGTERM hung
    // the call for good.
    const alive = (): boolean => child.exitCode === null && child.signalCode === null;

    const killChild = (): void => {
      if (settled) return;
      signalTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (alive()) signalTree(child, 'SIGKILL');
      }, KILL_ESCALATION_MS);
    };

    const timer = setTimeout(() => {
      // The child is already gone and only the drain is pending: settle from
      // what was captured. Calling that a timeout would be wrong.
      if (exited) {
        finishFromCapture();
        return;
      }
      timedOut = true;
      killChild();
    }, opts.timeoutMs);

    // Once the child has exited there is nothing to cancel, and a listener
    // left behind after settling would signal a pid the kernel may have
    // handed to someone else. rego_test_multiroot passes one signal through
    // a whole sequence of runs, so the listener has to go when the run does.
    const onAbort = (): void => {
      if (settled || exited) return;
      aborted = true;
      killChild();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
    };

    /**
     * Resolve at most once. 'error' and 'close' can both fire -- killing a child
     * mid-write is the ordinary way to reach that -- and a second resolve would
     * silently discard whichever result came second.
     */
    const settle = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      liveChildren.delete(child);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise(result);
    };

    /**
     * Build the result from the capture and let go of the pipes. Used once the
     * child has exited but something it left behind still holds its stdio.
     */
    const finishFromCapture = (): void => {
      if (settled || !exited) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(exited.code, exited.signal);
    };

    // (Re)start the wait for 'close'. Bytes can still be sitting in the pipe
    // at 'exit', and on a loaded machine the reads that deliver them may
    // queue behind an expired timer; each chunk that arrives pushes the
    // grace out again, and the deadline above bounds the whole thing.
    const armDrain = (): void => {
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(finishFromCapture, PIPE_DRAIN_GRACE_MS);
    };

    const onData = (buf: CappedBuffer, chunk: Buffer): void => {
      const overflowed = buf.push(chunk);
      if (exited) {
        // Nothing left to kill; a writer that outlived the child is either
        // done, or has just been cut off by the cap.
        if (overflowed) finishFromCapture();
        else armDrain();
        return;
      }
      if (overflowed) killChild();
    };
    child.stdout?.on('data', (chunk: Buffer) => onData(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => onData(stderr, chunk));

    // Killing a child mid-write can surface an EPIPE on the pipe. Without a
    // listener that is an unhandled 'error' event, which would take the whole
    // server down -- the exact failure mode this cap exists to prevent.
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.stdin?.on('error', () => undefined);

    child.on('error', (e) => {
      settle({
        exitCode: null,
        stdout: '',
        stderr: e.message,
        timedOut: false,
        aborted,
        durationMs: Date.now() - start,
        outputTruncated: false,
        signal: null,
      });
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      // Decoding runs here, in an async callback whose throw would escape every
      // try/catch upstream and reach the process as an uncaughtException. The
      // byte cap is what makes that unreachable; this is the belt to its braces.
      try {
        settle({
          exitCode: code,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
          aborted,
          durationMs: Date.now() - start,
          outputTruncated: stdout.didOverflow || stderr.didOverflow,
          signal,
        });
      } catch (e) {
        settle({
          exitCode: null,
          stdout: '',
          stderr: e instanceof Error ? e.message : 'failed to decode subprocess output',
          timedOut,
          aborted,
          durationMs: Date.now() - start,
          outputTruncated: true,
          signal,
        });
      }
    };

    // 'close' carries the complete output and is the normal way to finish.
    // 'exit' starts a short grace for it: when the pipes are still held open
    // by something the child left behind, the result is built from what was
    // captured and the server's ends of the pipes are released.
    child.on('exit', (code, signal) => {
      // A spawn failure settles on 'error' and may still be followed by 'exit'.
      if (settled) return;
      exited = { code, signal };
      armDrain();
    });
    child.on('close', (code, signal) => finish(code, signal));

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}
