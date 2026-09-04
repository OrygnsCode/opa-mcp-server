/**
 * Integration tests for `opa_exec`'s decision path, run against the real OPA
 * binary.
 *
 * `opa exec` names a decision by slash-separated path with no `data.` prefix.
 * The flag accepts any string, and anything else simply resolves to nothing, so
 * every input file comes back with `opa_undefined_error`. Under a `deny`-style
 * policy that reads as a clean pass, which is why this needs a real binary
 * rather than a mocked argv assertion.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

const POLICY = `package authz

import rego.v1

default allow := false

allow if input.user == "admin"
`;

interface ExecOutput {
  results: Array<{ result?: unknown; error?: { code: string } }>;
  count: number;
  successCount: number;
  errorCount: number;
  hint?: string;
}

let workDir: string;
let policyDir: string;
let inputDir: string;
let config: Config;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-exec-decision-'));
  policyDir = join(workDir, 'policy');
  inputDir = join(workDir, 'input');
  await mkdir(policyDir, { recursive: true });
  await mkdir(inputDir, { recursive: true });
  await writeFile(join(policyDir, 'authz.rego'), POLICY, 'utf8');
  await writeFile(join(inputDir, 'admin.json'), '{"user":"admin"}\n', 'utf8');
  await writeFile(join(inputDir, 'other.json'), '{"user":"bob"}\n', 'utf8');

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
    maxResponseBytes: 100_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

const run = async (decision: string) => {
  const server = makeServer();
  registerEvaluationTools(server, config);
  return callTool<ExecOutput>(server, 'opa_exec', {
    inputPaths: [inputDir],
    decision,
    dataPaths: [policyDir],
  });
};

describe('opa_exec decision path', () => {
  it('evaluates the rule however the reference is spelled', async () => {
    // Only `authz/allow` works when passed straight through. The others,
    // including the `data.authz.allow` this tool documented, left every input
    // undefined.
    for (const decision of [
      'data.authz.allow',
      'authz/allow',
      'authz.allow',
      '/authz/allow',
      'data/authz/allow',
    ]) {
      const env = await run(decision);
      expect(env.ok, `${decision}: ${JSON.stringify(env.error)}`).toBe(true);
      expect(env.data?.count, decision).toBe(2);
      expect(env.data?.errorCount, decision).toBe(0);
      const values = (env.data?.results ?? []).map((r) => r.result).sort();
      expect(values, decision).toEqual([false, true]);
      expect(env.data?.hint, decision).toBeUndefined();
    }
  }, 120_000);

  it('says so when a decision names nothing', async () => {
    const env = await run('data.authz.nosuchrule');
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.errorCount).toBe(2);
    expect(env.data?.results.every((r) => r.error?.code === 'opa_undefined_error')).toBe(true);
    expect(env.data?.hint).toContain('authz/nosuchrule');
  }, 60_000);

  it('rejects a reference with nothing left to name', async () => {
    for (const decision of ['data', '/', 'a..b']) {
      const env = await run(decision);
      expect(env.ok, decision).toBe(false);
      expect(env.error?.code, decision).toBe('INVALID_INPUT');
    }
  }, 60_000);
});
