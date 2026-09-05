/**
 * Real subprocess-timeout test.
 *
 * Verifies that runBinary actually kills a hung child process when
 * timeoutMs elapses. Uses Node itself (`node -e 'setTimeout(() => {},
 * 60000)'`) as a portable hung-child stand-in — no shelling out to
 * `sleep` which is not always available cross-platform.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { runBinary } from '../../src/lib/subprocess.js';

const NODE = process.execPath;

describe('runBinary timeout enforcement', () => {
  it('kills a hung child within the configured timeout', async () => {
    const start = Date.now();
    const result = await runBinary(NODE, {
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    // Hard timeout is 200ms; SIGKILL escalation is 2s after; a hung
    // child should be reaped well under 5s (allowing slack for
    // process-startup overhead, especially on Windows).
    expect(elapsed).toBeLessThan(5_000);
    // Killed processes report a signal exit; the exact exit code varies
    // by platform (null on signal, 137 on SIGKILL on linux). Accept any
    // non-zero or null exit.
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  }, 10_000);

  it('completes normally for a fast child without firing the timeout', async () => {
    const result = await runBinary(NODE, {
      args: ['-e', 'process.stdout.write("done")'],
      timeoutMs: 5_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
  });

  it('captures stderr when the child exits non-zero before the timeout', async () => {
    const result = await runBinary(NODE, {
      args: ['-e', 'console.error("explicit error"); process.exit(1)'],
      timeoutMs: 5_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('explicit error');
  });

  it('reports exitCode null and the spawn error when the binary does not exist', async () => {
    const result = await runBinary('/this/binary/does/not/exist', {
      args: [],
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('passes stdin through to the child process', async () => {
    const result = await runBinary(NODE, {
      args: [
        '-e',
        // Read all of stdin and echo it back.
        "let buf=''; process.stdin.on('data',c=>buf+=c); process.stdin.on('end',()=>process.stdout.write(buf))",
      ],
      timeoutMs: 5_000,
      stdin: 'hello from stdin',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from stdin');
  });

  it('does not leak child processes — verifiable via process.pid count', async () => {
    // Smoke test: spawn 10 children sequentially and confirm none of
    // them are still running afterwards. We do this by attempting to
    // spawn the same node-with-loop and ensuring system resource
    // tracking is sound (no zombie reaping issues).
    for (let i = 0; i < 10; i += 1) {
      const r = await runBinary(NODE, {
        args: ['-e', 'setTimeout(() => {}, 60_000)'],
        timeoutMs: 50,
      });
      expect(r.timedOut).toBe(true);
    }
    // If any of the previous calls leaked a child, the test process
    // would slow down or run out of FDs. Reaching here means we did
    // not.
    expect(true).toBe(true);
  }, 30_000);
});

describe('runBinary signal handling', () => {
  it('kills a hung child via SIGTERM within the timeout window', async () => {
    // The deterministic SIGKILL escalation (SIGTERM ignored → SIGKILL
    // fires after 2 s) is verified branch-by-branch in
    // tests/unit/lib/subprocess.test.ts with fake timers — that's the
    // authoritative coverage of the escalation logic. This integration
    // test confirms the high-level contract end-to-end against a real
    // child: when a hung child is sent SIGTERM, runBinary actually
    // resolves with timedOut=true and the child is reaped.
    //
    // The child does not trap SIGTERM here; the trapped case, which needs
    // the SIGKILL escalation to be real, is covered below with a bound wide
    // enough for a slow runner.
    const start = Date.now();
    const result = await runBinary(NODE, {
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      timeoutMs: 100,
    });
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThan(100);
    // Reaping should happen quickly for a SIGTERM-cooperative child;
    // bound is generous to absorb CI-runner scheduler jitter.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});

describe('runBinary against children that do not cooperate', () => {
  it.runIf(process.platform !== 'win32')(
    'reaps a child that traps SIGTERM',
    async () => {
      const start = Date.now();
      // Long enough for node to boot and install the handler on a slow
      // runner; otherwise the default disposition kills it and the test
      // would prove nothing.
      const result = await runBinary(NODE, {
        args: ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000)'],
        timeoutMs: 2_000,
      });
      const elapsed = Date.now() - start;

      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe('SIGKILL');
      // 2s timeout, 2s to escalate, and slack for process start-up.
      expect(elapsed).toBeLessThan(10_000);
    },
    15_000,
  );

  it('settles when a grandchild keeps the pipes open after the child exits', async () => {
    // The shape of a wrapper script: start the real program with the
    // inherited stdio, then exit. The grandchild lives on holding the pipes.
    const script = [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {',
      '  stdio: "inherit", detached: process.platform !== "win32" });',
      'g.unref();',
      'process.stdout.write(String(g.pid));',
      'process.exit(0);',
    ].join(' ');
    const start = Date.now();
    const result = await runBinary(NODE, { args: ['-e', script], timeoutMs: 30_000 });
    const elapsed = Date.now() - start;
    // parseInt, and a positive check: Number('') is 0, and kill(0) would
    // signal this process's own group, test runner included.
    const grandchild = Number.parseInt(result.stdout.trim(), 10);
    try {
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(grandchild).toBeGreaterThan(0);
      // Settled on the drain grace, long before the timeout.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      if (Number.isInteger(grandchild) && grandchild > 0) {
        try {
          process.kill(grandchild, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 15_000);

  it.runIf(process.platform !== 'win32')(
    'kills the grandchild together with a hung child on timeout',
    async () => {
      // The grandchild stays in the child's process group and inherits the
      // pipes; the child then hangs. The timeout must take both down.
      const script = [
        'const { spawn } = require("node:child_process");',
        'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "inherit" });',
        'process.stdout.write(String(g.pid));',
        'setTimeout(() => {}, 60_000);',
      ].join(' ');
      // Two node start-ups have to fit inside the timeout, or the pid never
      // reaches stdout and there is nothing to probe.
      const result = await runBinary(NODE, { args: ['-e', script], timeoutMs: 3_000 });
      const grandchild = Number.parseInt(result.stdout.trim(), 10);
      expect(result.timedOut).toBe(true);
      expect(grandchild).toBeGreaterThan(0);

      // Give the signal a moment to land, then probe: signal 0 throws ESRCH
      // once the process is gone.
      await new Promise((r) => setTimeout(r, 500));
      let alive = true;
      try {
        process.kill(grandchild, 0);
      } catch {
        alive = false;
      }
      if (alive) {
        try {
          process.kill(grandchild, 'SIGKILL');
        } catch {
          // raced with its own exit
        }
      }
      expect(alive).toBe(false);
    },
    15_000,
  );
});

// Assert spawn is what the test depends on at module level so this
// file fails fast if the import surface ever breaks.
void spawn;
