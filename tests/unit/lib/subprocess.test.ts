/**
 * Deterministic unit tests for runBinary.
 *
 * The integration suite under tests/integration/subprocess-timeout
 * exercises the timeout flow with real child processes — slow but
 * authentic. These tests use vi.useFakeTimers() and a mocked spawn
 * to drive the timer logic step by step, so the SIGTERM-then-SIGKILL
 * escalation is verified branch-by-branch.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

import { runBinary } from '../../../src/lib/subprocess.js';

const mockSpawn = vi.mocked(spawn);

interface FakeStream extends EventEmitter {
  on(event: string, listener: (...args: unknown[]) => void): this;
}

interface FakeStdin extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  stdin: FakeStdin;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter() as FakeStream;
  child.stderr = new EventEmitter() as FakeStream;
  // A real ChildProcess.stdin is a Writable, so it emits events like the other
  // two streams. Modelling it as a bare object hid the fact that runBinary can
  // legitimately subscribe to it.
  const stdin = new EventEmitter() as FakeStdin;
  stdin.write = vi.fn();
  stdin.end = vi.fn();
  child.stdin = stdin;
  child.kill = vi.fn(() => true);
  child.killed = false;
  return child;
}

beforeEach(() => {
  mockSpawn.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runBinary — happy path', () => {
  it('captures stdout, stderr, exitCode for a normal exit', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['version'], timeoutMs: 5_000 });

    // Emit stdout in chunks, then exit cleanly.
    child.stdout.emit('data', Buffer.from('Version: 0.69.0\n'));
    child.stderr.emit('data', Buffer.from(''));
    child.emit('close', 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Version: 0.69.0\n');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes args, cwd, and env through to spawn', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', {
      args: ['eval', 'data.x'],
      timeoutMs: 5_000,
      cwd: '/abs/work',
      env: { CUSTOM: 'value' },
    });
    child.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'opa',
      ['eval', 'data.x'],
      expect.objectContaining({
        cwd: '/abs/work',
        env: expect.objectContaining({ CUSTOM: 'value' }),
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it('writes stdin and ends the stream when stdin is provided', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', {
      args: ['fmt', '-'],
      timeoutMs: 5_000,
      stdin: 'package x',
    });
    child.emit('close', 0);
    await promise;

    expect(child.stdin.write).toHaveBeenCalledWith('package x');
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it('ends stdin even when no stdin is provided (closes the input stream)', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['version'], timeoutMs: 5_000 });
    child.emit('close', 0);
    await promise;

    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });
});

describe('runBinary — error handling', () => {
  it('reports exitCode null and the error message when spawn emits "error"', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('/nonexistent', { args: [], timeoutMs: 5_000 });
    child.emit('error', new Error('spawn ENOENT'));

    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toBe('spawn ENOENT');
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('reports the captured stderr when child exits non-zero', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['check', 'bad.rego'], timeoutMs: 5_000 });
    child.stderr.emit('data', Buffer.from('check error\n'));
    child.emit('close', 1);

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('check error\n');
  });

  it('concatenates multiple stdout / stderr chunks correctly', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['x'], timeoutMs: 5_000 });
    child.stdout.emit('data', Buffer.from('chunk-1 '));
    child.stdout.emit('data', Buffer.from('chunk-2 '));
    child.stdout.emit('data', Buffer.from('chunk-3'));
    child.stderr.emit('data', Buffer.from('err-A '));
    child.stderr.emit('data', Buffer.from('err-B'));
    child.emit('close', 0);

    const result = await promise;
    expect(result.stdout).toBe('chunk-1 chunk-2 chunk-3');
    expect(result.stderr).toBe('err-A err-B');
  });
});

describe('runBinary — timeout escalation (deterministic)', () => {
  it('does not fire SIGTERM before the timeout elapses', () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    // Fire-and-forget: we observe side effects on the child, not the
    // returned promise. The dangling promise is harmless under fake
    // timers since it will never resolve before the test ends.
    void runBinary('opa', { args: ['hang'], timeoutMs: 1_000 });

    // 999 ms — still under the boundary.
    vi.advanceTimersByTime(999);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('fires SIGTERM exactly at the timeout boundary', () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    void runBinary('opa', { args: ['hang'], timeoutMs: 1_000 });

    vi.advanceTimersByTime(1_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates to SIGKILL 2 seconds after SIGTERM if the child is still alive', () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    void runBinary('opa', { args: ['ignore-sigterm'], timeoutMs: 1_000 });

    // Reach SIGTERM.
    vi.advanceTimersByTime(1_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Child traps SIGTERM — it stays alive (killed === false). 2s later
    // the inner timer fires SIGKILL.
    vi.advanceTimersByTime(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it('does NOT send SIGKILL if the child died after SIGTERM (killed=true)', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['cooperative'], timeoutMs: 1_000 });

    vi.advanceTimersByTime(1_000); // SIGTERM
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Cooperative child exits in response to SIGTERM.
    child.killed = true;
    child.emit('close', null);

    // Advance past the 2s SIGKILL window — the guard `if (!child.killed)`
    // should keep SIGKILL from being sent.
    vi.advanceTimersByTime(2_000);
    expect(child.kill).toHaveBeenCalledTimes(1);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('cancels the kill timer chain when the child closes before the deadline', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['fast'], timeoutMs: 5_000 });

    // Child finishes before the timeout fires.
    vi.advanceTimersByTime(100);
    child.emit('close', 0);

    // Even if we advance well past the original deadline, no kill is
    // sent because the timer was cleared.
    vi.advanceTimersByTime(10_000);
    expect(child.kill).not.toHaveBeenCalled();

    const result = await promise;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('cancels timers on spawn-error path too', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['x'], timeoutMs: 1_000 });
    child.emit('error', new Error('spawn EACCES'));

    // Even after the original deadline plus the SIGKILL window passes,
    // no kills are sent because the error path cleared timers.
    vi.advanceTimersByTime(5_000);
    expect(child.kill).not.toHaveBeenCalled();

    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('EACCES');
  });
});

describe('runBinary — AbortSignal cancellation', () => {
  it('returns aborted=true immediately if the signal is already aborted before spawn', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runBinary('opa', {
      args: ['hang'],
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    // spawn should never have been called
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('kills the child and resolves with aborted=true when signal fires mid-run', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const controller = new AbortController();
    const promise = runBinary('opa', {
      args: ['hang'],
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    // Child is running -- abort mid-flight.
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Child responds to SIGTERM.
    child.emit('close', null);

    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
  });
});

describe('runBinary — output cap', () => {
  it('captures normally and reports no truncation when under the limit', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['eval'], timeoutMs: 5_000, maxOutputBytes: 100 });
    child.stdout.emit('data', Buffer.from('a'.repeat(50)));
    child.emit('close', 0);

    const result = await promise;
    expect(result.stdout).toHaveLength(50);
    expect(result.outputTruncated).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('clamps a single oversized chunk to exactly the limit and kills the child', async () => {
    // The realistic shape: `opa eval --format json` marshals its whole result in
    // memory and writes it in one burst, so the cap has to bite inside the very
    // first chunk. A running total that only rejects the *next* chunk never runs.
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['eval'], timeoutMs: 5_000, maxOutputBytes: 100 });
    child.stdout.emit('data', Buffer.from('x'.repeat(10_000)));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null);

    const result = await promise;
    expect(result.stdout).toHaveLength(100);
    expect(result.outputTruncated).toBe(true);
  });

  it('accumulates across chunks and stops at the boundary', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['eval'], timeoutMs: 5_000, maxOutputBytes: 10 });
    child.stdout.emit('data', Buffer.from('abcd'));
    child.stdout.emit('data', Buffer.from('efgh'));
    child.stdout.emit('data', Buffer.from('ijkl'));
    child.emit('close', null);

    const result = await promise;
    expect(result.stdout).toBe('abcdefghij');
    expect(result.outputTruncated).toBe(true);
  });

  it('ignores further chunks once the limit is passed', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['eval'], timeoutMs: 5_000, maxOutputBytes: 4 });
    child.stdout.emit('data', Buffer.from('aaaaaaaa'));
    child.stdout.emit('data', Buffer.from('bbbbbbbb'));
    child.stdout.emit('data', Buffer.from('cccccccc'));
    child.emit('close', null);

    const result = await promise;
    expect(result.stdout).toBe('aaaa');
    // One kill for the overflow, not one per subsequent chunk.
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('caps stderr independently of stdout', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['eval'], timeoutMs: 5_000, maxOutputBytes: 5 });
    child.stdout.emit('data', Buffer.from('ok'));
    child.stderr.emit('data', Buffer.from('yyyyyyyyyy'));
    child.emit('close', null);

    const result = await promise;
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('yyyyy');
    expect(result.outputTruncated).toBe(true);
  });

  it('treats output landing exactly on the limit as complete, not truncated', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['eval'], timeoutMs: 5_000, maxOutputBytes: 8 });
    child.stdout.emit('data', Buffer.from('12345678'));
    child.emit('close', 0);

    const result = await promise;
    expect(result.stdout).toBe('12345678');
    // Nothing was lost, so reporting truncation here would send the agent
    // chasing a limit it never actually hit.
    expect(result.outputTruncated).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('overflows on the following chunk when the limit was exactly reached', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['eval'], timeoutMs: 5_000, maxOutputBytes: 8 });
    child.stdout.emit('data', Buffer.from('12345678'));
    child.stdout.emit('data', Buffer.from('9'));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null);

    const result = await promise;
    expect(result.stdout).toBe('12345678');
    expect(result.outputTruncated).toBe(true);
  });

  it('applies a default limit when the caller supplies none', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['version'], timeoutMs: 5_000 });
    child.stdout.emit('data', Buffer.from('Version: 1.19.0'));
    child.emit('close', 0);

    const result = await promise;
    expect(result.stdout).toBe('Version: 1.19.0');
    expect(result.outputTruncated).toBe(false);
  });
});

describe('runBinary — the close handler cannot take the process down', () => {
  it('resolves once even when both error and close fire', async () => {
    // Killing a child mid-write is the ordinary route to both events. A second
    // resolve would silently discard a result rather than crash, but the guard
    // keeps which-one-wins deterministic.
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['eval'], timeoutMs: 5_000 });
    child.emit('error', new Error('EPIPE'));
    child.emit('close', null);

    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toBe('EPIPE');
  });

  it('survives an EPIPE on the stdout stream after a kill', async () => {
    // Without a listener this is an unhandled 'error' event, which would take
    // the whole server down -- the exact failure the cap exists to prevent.
    const child = makeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = runBinary('opa', { args: ['eval'], timeoutMs: 5_000, maxOutputBytes: 4 });
    child.stdout.emit('data', Buffer.from('aaaaaaaa'));
    expect(() => child.stdout.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(() => child.stderr.emit('error', new Error('EPIPE'))).not.toThrow();
    child.emit('close', null);

    const result = await promise;
    expect(result.outputTruncated).toBe(true);
  });
});
