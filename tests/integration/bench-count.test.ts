/**
 * Integration test for `rego_bench` with `count`, run against the real OPA
 * binary.
 *
 * `opa bench --count N` prints one JSON document per repetition, back to back.
 * `JSON.parse` rejects that outright, so every count above one failed as
 * unparseable output. A mocked subprocess would only prove the parser handles a
 * shape we invented, so this runs the real thing.
 *
 * The same command writes its diagnostics to stdout as an `errors` array and
 * leaves stderr empty, which is the other half of what is tested here.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

interface BenchOutput {
  iterations?: number;
  nsPerOp?: number;
  raw?: { N?: number; T?: number };
  runs?: Array<{ N?: number; T?: number }>;
  repetitions?: number;
  fastest?: number;
}

let workDir: string;
let policyPath: string;
let config: Config;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-bench-count-'));
  await mkdir(workDir, { recursive: true });
  policyPath = join(workDir, 'bench.rego');
  await writeFile(policyPath, 'package b\n\nimport rego.v1\n\nallow if input.x == 1\n', 'utf8');

  config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: process.env['OPA_BINARY'] ?? 'opa',
    regalBinary: 'regal',
    conftestBinary: 'conftest',
    subprocessTimeoutMs: 120_000,
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

const bench = (input: Record<string, unknown>) => {
  const server = makeServer();
  registerEvaluationTools(server, config);
  return callTool<BenchOutput>(server, 'rego_bench', {
    query: 'data.b.allow',
    paths: [policyPath],
    input: { x: 1 },
    ...input,
  });
};

describe('rego_bench with a repeat count', () => {
  it('returns every repetition instead of failing to parse', async () => {
    const env = await bench({ count: 3 });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.repetitions).toBe(3);
    expect(env.data?.runs).toHaveLength(3);

    // The top-level figures come from the fastest run per iteration, as
    // whole numbers; the document itself sits under raw.
    const perOp = (r: { N?: number; T?: number }) => (r.N ? r.T! / r.N : Infinity);
    const best = Math.min(...(env.data?.runs ?? []).map(perOp));
    expect(env.data?.nsPerOp).toBe(Math.floor(best));
    expect(perOp(env.data!.runs![env.data!.fastest!]!)).toBeCloseTo(best, 6);
    expect(env.data?.raw).toBeUndefined();
  }, 120_000);

  it('leaves the fields off for a single run', async () => {
    const env = await bench({ count: 1 });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.repetitions).toBeUndefined();
    expect(env.data?.runs).toBeUndefined();
    expect(env.data?.iterations).toBeGreaterThan(0);
    expect(env.data?.raw?.N).toBe(env.data?.iterations);
  }, 120_000);

  it('reports what actually went wrong', async () => {
    // opa bench writes the parse error to stdout; stderr is empty, so an error
    // built from stderr alone said nothing at all.
    const env = await bench({ query: 'data.b.allow ==' });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('EVAL_ERROR');
    expect(JSON.stringify(env.error?.details)).toContain('rego_parse_error');
  }, 60_000);
});
