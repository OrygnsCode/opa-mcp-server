/**
 * Subprocess wrapper used by `opa-cli.ts`, `regal-cli.ts` and `conftest-cli.ts`.
 *
 * - Uses argv arrays only (never shell strings) -- prevents injection.
 * - Hard timeout per invocation, defaulting to config.subprocessTimeoutMs.
 * - Captures stdout / stderr / exit code separately, each capped in bytes.
 * - Passes a minimal environment to the child, never the server's own.
 * - Optional stdin payload for piping source code.
 */
import { spawn } from 'node:child_process';

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
    });

    const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const stdout = new CappedBuffer(limit);
    const stderr = new CappedBuffer(limit);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killChild = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2_000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, opts.timeoutMs);

    if (opts.signal) {
      opts.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          killChild();
        },
        { once: true },
      );
    }

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
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
      resolvePromise(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.push(chunk)) killChild();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.push(chunk)) killChild();
    });

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
      });
    });

    child.on('close', (code) => {
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
        });
      }
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}
