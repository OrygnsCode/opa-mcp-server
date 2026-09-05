/**
 * Integration tests for `opa test --coverage`, run against the real OPA binary.
 *
 * Coverage mode behaves differently from an ordinary run in two ways that no
 * mocked subprocess would reveal: OPA emits the coverage report alone, with no
 * per-test records, and a suite holding a `todo_` test exits non-zero with an
 * empty stderr even though nothing failed.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import { registerHelperTools } from '../../src/tools/helpers/index.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

const POLICY = `package cov

import rego.v1

default allow := false

allow if input.role == "admin"

allow if input.role == "root"
`;

let workDir: string;
let config: Config;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-coverage-mode-'));
  config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: process.env['OPA_BINARY'] ?? 'opa',
    regalBinary: 'regal',
    conftestBinary: 'conftest',
    subprocessTimeoutMs: 60_000,
    httpTimeoutMs: 15_000,
    allowedPaths: [workDir],
    logFile: join(workDir, 'server.log'),
    logLevel: 'error',
    maxResponseBytes: 1_000_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function suite(name: string, tests: string): Promise<string> {
  const dir = join(workDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'p.rego'), POLICY, 'utf8');
  await writeFile(join(dir, 'p_test.rego'), tests, 'utf8');
  return dir;
}

const PASSING = `package cov_test

import rego.v1

import data.cov

test_admin if cov.allow with input as {"role": "admin"}
`;

describe('rego_test in coverage mode', () => {
  it('returns the coverage report when the suite holds a skipped test', async () => {
    // OPA exits non-zero here with an empty stderr, while the report it was
    // asked for sits on stdout. That was reported as "One or more tests
    // failed", which was wrong twice: nothing failed, and the report was
    // thrown away.
    const dir = await suite('todo', `${PASSING}\ntodo_test_later if true\n`);
    const server = makeServer();
    registerEvaluationTools(server, config);
    const env = await callTool<{ coveragePct?: number }>(server, 'rego_test', {
      paths: [dir],
      coverage: true,
    });

    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.coveragePct).toBeGreaterThan(0);
  }, 60_000);

  it('reports a passing suite with no skipped test as before', async () => {
    const dir = await suite('clean', PASSING);
    const server = makeServer();
    registerEvaluationTools(server, config);
    const env = await callTool<{ coveragePct?: number }>(server, 'rego_test', {
      paths: [dir],
      coverage: true,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.coveragePct).toBeGreaterThan(0);
  }, 60_000);

  it('still reports a genuinely failing suite as failing', async () => {
    const dir = await suite(
      'failing',
      `package cov_test\n\nimport rego.v1\n\nimport data.cov\n\ntest_no if not cov.allow with input as {"role": "admin"}\n`,
    );
    const server = makeServer();
    registerEvaluationTools(server, config);
    const env = await callTool(server, 'rego_test', { paths: [dir], coverage: true });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('EVAL_ERROR');
  }, 60_000);
});

describe('rego_coverage_gaps', () => {
  it('leaves the test counts out, since OPA reports no records here', async () => {
    // Three zeros read as "no tests ran". OPA does not emit test records in
    // coverage mode at all, so the honest answer is that it did not say.
    const dir = await suite('gaps', PASSING);
    const server = makeServer();
    registerHelperTools(server, config);
    const env = await callTool<{
      overallCoverage: number;
      testsPassed?: number;
      testsFailed?: number;
      testsSkipped?: number;
    }>(server, 'rego_coverage_gaps', { paths: [dir] });

    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.overallCoverage).toBeGreaterThan(0);
    expect(env.data?.testsPassed).toBeUndefined();
    expect(env.data?.testsFailed).toBeUndefined();
    expect(env.data?.testsSkipped).toBeUndefined();
  }, 60_000);
});
