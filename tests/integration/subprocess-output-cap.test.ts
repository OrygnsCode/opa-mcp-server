/**
 * Integration test: the subprocess output cap, against real child processes.
 *
 * The unit tests drive a mocked child, so they prove the accounting but not that
 * the cap survives real pipe semantics -- chunking, backpressure, and the EPIPE
 * that follows killing a process mid-write.
 *
 * What this is guarding: `Buffer.concat(chunks).toString('utf8')` throws once a
 * capture passes V8's max string length, and it throws inside an async 'close'
 * handler where no tool-level try/catch can reach it. That took the whole stdio
 * server down. A policy iterating `numbers.range(1,1000)` under `--explain full`
 * produced 518 MiB in under 7 seconds, so the timeout never came close to
 * saving it.
 *
 * Node is used as the emitter rather than `opa`, so the test is fast, exact
 * about byte counts, and does not depend on a binary being installed.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_OUTPUT_BYTES, runBinary } from '../../src/lib/subprocess.js';

/** A child that writes `bytes` to the given stream and exits 0. */
function emitter(bytes: number, stream: 'stdout' | 'stderr' = 'stdout'): string[] {
  return [
    '-e',
    `const b = Buffer.alloc(${bytes}, 0x61); process.${stream}.write(b, () => process.exit(0));`,
  ];
}

describe('subprocess output cap (real child processes)', () => {
  it('captures output that stays under the limit', async () => {
    const result = await runBinary(process.execPath, {
      args: emitter(1_000),
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    });

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(1_000);
    expect(result.outputTruncated).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('clamps output that exceeds the limit and reports it', async () => {
    const limit = 64 * 1024;
    const result = await runBinary(process.execPath, {
      args: emitter(4 * 1024 * 1024),
      timeoutMs: 30_000,
      maxOutputBytes: limit,
    });

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(limit);
    expect(result.outputTruncated).toBe(true);
    // Killed for size, not for time. mapSubprocessFailure keys on that to avoid
    // reporting a chatty command as a missing binary.
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('caps stderr the same way', async () => {
    const limit = 32 * 1024;
    const result = await runBinary(process.execPath, {
      args: emitter(2 * 1024 * 1024, 'stderr'),
      timeoutMs: 30_000,
      maxOutputBytes: limit,
    });

    expect(Buffer.byteLength(result.stderr, 'utf8')).toBe(limit);
    expect(result.outputTruncated).toBe(true);
  });

  it('does not crash the process when a child is killed mid-write', async () => {
    // Killing a child while it is writing can raise EPIPE on the pipe. An
    // unhandled 'error' event there would be a new way to kill the server --
    // the fix reintroducing the bug it was written to remove.
    const before = process.listenerCount('uncaughtException');

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runBinary(process.execPath, {
          args: emitter(8 * 1024 * 1024),
          timeoutMs: 30_000,
          maxOutputBytes: 16 * 1024,
        }),
      ),
    );

    for (const r of results) {
      expect(r.outputTruncated).toBe(true);
      expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(16 * 1024);
    }
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  it('resolves rather than throwing when output would exceed the string limit', async () => {
    // The crash condition itself. 600 MB is past MAX_STRING_LENGTH
    // (536,870,888), so without a byte cap the decode throws. Written to stdout
    // in 64 MB slices to keep the child's own memory reasonable.
    const result = await runBinary(process.execPath, {
      args: [
        '-e',
        `const b = Buffer.alloc(64 * 1024 * 1024, 0x61);
         let n = 0;
         (function w() {
           if (n++ >= 10) return process.exit(0);
           process.stdout.write(b, w);
         })();`,
      ],
      timeoutMs: 120_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });

    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(DEFAULT_MAX_OUTPUT_BYTES);
  }, 120_000);
});
