/**
 * Subprocess wrapper used by `opa-cli.ts` and `regal-cli.ts`.
 *
 * - Uses argv arrays only (never shell strings) -- prevents injection.
 * - Hard timeout per invocation, defaulting to config.subprocessTimeoutMs.
 * - Captures stdout / stderr / exit code separately.
 * - Optional stdin payload for piping source code.
 */
import { spawn } from 'node:child_process';

export interface SpawnOptions {
  /** Argument vector passed directly to the binary. */
  args: string[];
  /** Optional stdin payload (e.g., Rego source). */
  stdin?: string;
  /** Working directory for the child process. */
  cwd?: string;
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
  /** Extra environment variables to merge into process.env. */
  env?: Record<string, string>;
  /** External cancellation signal from the MCP client. */
  signal?: AbortSignal;
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
}

/**
 * Run a binary and return its captured output. Never throws -- failures
 * are reflected in `exitCode` / `timedOut`.
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
    };
  }

  return await new Promise<SpawnResult>((resolvePromise) => {
    const child = spawn(binary, opts.args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      shell: false,
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
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

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (e) => {
      clearTimers();
      resolvePromise({
        exitCode: null,
        stdout: '',
        stderr: e.message,
        timedOut: false,
        aborted,
        durationMs: Date.now() - start,
      });
    });

    child.on('close', (code) => {
      clearTimers();
      resolvePromise({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        aborted,
        durationMs: Date.now() - start,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}
