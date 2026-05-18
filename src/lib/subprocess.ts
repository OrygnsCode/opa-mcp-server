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
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Time spent in milliseconds. */
  durationMs: number;
}

/**
 * Run a binary and return its captured output. Never throws -- failures
 * are reflected in `exitCode` / `timedOut`.
 */
export async function runBinary(binary: string, opts: SpawnOptions): Promise<SpawnResult> {
  const start = Date.now();

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
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // SIGKILL escalation if SIGTERM is ignored.
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2_000);
    }, opts.timeoutMs);

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
