/**
 * Real-binary tests for how `rego_test` and `rego_test_multiroot` count what
 * `opa test` reports.
 *
 * OPA marks a test it could not evaluate with an `error` object and does NOT
 * set `fail`, so a count derived as `total - failed - skipped` absorbed it
 * into the passing total. A suite whose tests all error read as fully passing.
 * The shapes asserted here were taken from OPA 1.19 output.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import type { RegoTestOutput, TestRecord } from '../../src/tools/evaluation/test.js';
import type { MultiRootTestOutput } from '../../src/tools/evaluation/test-multiroot.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

/**
 * `p` is defined twice, so any test that reads it raises
 * eval_conflict_error. OPA reports that as `error` on the record, with no
 * `fail`. `test_ok` never touches `p` and passes.
 */
const CONFLICT_POLICY = `package t

p := 1 if true

p := 2 if true
`;

const CONFLICT_TESTS = `package t

test_conflict if p == 1

test_ok if true

test_really_fails if false

todo_test_skipped if false
`;

let workDir: string;
let server: ReturnType<typeof makeServer>;

const runTest = (input: Record<string, unknown>) =>
  callTool<RegoTestOutput>(server, 'rego_test', input);

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-test-records-'));
  const conflictDir = join(workDir, 'conflict');
  await mkdir(conflictDir, { recursive: true });
  await writeFile(join(conflictDir, 'p.rego'), CONFLICT_POLICY);
  await writeFile(join(conflictDir, 'p_test.rego'), CONFLICT_TESTS);

  // A second root, so multiroot has something to aggregate.
  const cleanDir = join(workDir, 'roots', 'clean');
  await mkdir(cleanDir, { recursive: true });
  await writeFile(join(cleanDir, 'c.rego'), 'package c\n\nallow if true\n');
  await writeFile(join(cleanDir, 'c_test.rego'), 'package c\n\ntest_allow if allow\n');
  const brokenDir = join(workDir, 'roots', 'broken');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(join(brokenDir, 'b.rego'), CONFLICT_POLICY.replace('package t', 'package b'));
  await writeFile(
    join(brokenDir, 'b_test.rego'),
    'package b\n\ntest_conflict if p == 1\n\ntest_ok if true\n',
  );

  const config: Config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: process.env['OPA_BINARY'] ?? 'opa',
    regalBinary: 'regal',
    conftestBinary: 'conftest',
    subprocessTimeoutMs: 30_000,
    httpTimeoutMs: 15_000,
    allowedPaths: [workDir],
    logFile: join(workDir, 'server.log'),
    logLevel: 'error',
    maxResponseBytes: 200_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
  server = makeServer();
  registerEvaluationTools(server, config);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('rego_test counts a test OPA could not evaluate', () => {
  it('reports it as errored rather than passed', async () => {
    const env = await runTest({ paths: [join(workDir, 'conflict')] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);

    const records = env.data!.results;
    const byName = (n: string): TestRecord | undefined => records.find((r) => r.name === n);

    // The shape this all rests on: OPA sets `error` and leaves `fail` unset.
    const conflict = byName('test_conflict');
    expect(conflict?.error).toBeDefined();
    expect(conflict?.error?.code).toBe('eval_conflict_error');
    expect(conflict?.fail).toBeUndefined();

    expect(env.data).toMatchObject({
      total: 4,
      passed: 1,
      failed: 1,
      skipped: 1,
      errored: 1,
    });
    // The sum has to account for every record exactly once.
    const { passed, failed, skipped, errored, total } = env.data!;
    expect(passed + failed + skipped + errored).toBe(total);
  }, 30_000);

  it('does not report a suite of only errored tests as passing', async () => {
    const dir = join(workDir, 'all-errors');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'p.rego'), CONFLICT_POLICY);
    await writeFile(
      join(dir, 'p_test.rego'),
      'package t\n\ntest_a if p == 1\n\ntest_b if p == 2\n',
    );

    const env = await runTest({ paths: [dir] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data).toMatchObject({ total: 2, passed: 0, failed: 0, skipped: 0, errored: 2 });
  }, 30_000);

  it('still counts an ordinary failure as a failure, not an error', async () => {
    const dir = join(workDir, 'plain-fail');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'p_test.rego'),
      'package f\n\ntest_no if false\n\ntest_yes if true\n',
    );

    const env = await runTest({ paths: [dir] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data).toMatchObject({ total: 2, passed: 1, failed: 1, skipped: 0, errored: 0 });
  }, 30_000);
});

describe('rego_test_multiroot counts errored tests across roots', () => {
  it('aggregates errored separately from passed', async () => {
    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      scanDir: join(workDir, 'roots'),
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);

    const totals = env.data!;
    expect(totals.totalErrored).toBe(1);
    expect(totals.totalPassed).toBe(2);
    expect(
      totals.totalPassed + totals.totalFailed + totals.totalSkipped + totals.totalErrored,
    ).toBe(totals.totalTests);

    const broken = totals.roots.find((r) => r.path.endsWith('broken'));
    expect(broken?.errored).toBe(1);
    expect(broken?.passed).toBe(1);
  }, 60_000);
});

describe('rego_test repeats the suite when count is set', () => {
  it('reports results rather than finding no tests', async () => {
    // opa test --count N prints one array per repetition; reading only a
    // single JSON value made every repeated run look like an empty suite.
    const dir = join(workDir, 'repeat');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'r_test.rego'), 'package r\n\ntest_a if true\n\ntest_b if true\n');

    for (const count of [2, 3]) {
      const env = await runTest({ paths: [dir], count });
      expect(env.ok, `count=${count}: ${JSON.stringify(env.error)}`).toBe(true);
      expect(env.data).toMatchObject({ total: 2, passed: 2, failed: 0, repetitions: count });
    }
  }, 60_000);

  it('reports the failure when opa stops repeating after a failed run', async () => {
    // OPA does not keep repeating past a run that fails, so a failing suite
    // emits a single array however high the count is. The failure still has to
    // come through as a failure rather than as a load error.
    const dir = join(workDir, 'repeat-fail');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'r_test.rego'),
      'package rf\n\ntest_ok if true\n\ntest_no if false\n',
    );
    const env = await runTest({ paths: [dir], count: 3 });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    // Two distinct tests, not six records.
    expect(env.data).toMatchObject({ total: 2, passed: 1, failed: 1 });
    // Only one repetition ran, so the field is left off.
    expect(env.data?.repetitions).toBeUndefined();
  }, 60_000);

  it('omits repetitions when count is 1', async () => {
    const dir = join(workDir, 'repeat-one');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'r_test.rego'), 'package r1\n\ntest_a if true\n');
    const env = await runTest({ paths: [dir], count: 1 });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.repetitions).toBeUndefined();
    expect(env.data?.total).toBe(1);
  }, 60_000);
});
