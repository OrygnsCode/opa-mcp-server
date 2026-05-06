import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  baseConfig,
  callTool,
  fixturePath,
  makeServer,
  spawnFailure,
  spawnSuccess,
  spawnUnreachable,
} from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

import { registerEvaluationTools } from '../../../src/tools/evaluation/index.js';

const mockRun = vi.mocked(runBinary);

const validRegoPath = () => fixturePath('policies', 'valid', 'rbac.rego');
const validInputPath = () => fixturePath('inputs', 'rbac.json');

const evalSuccessStdout = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    result: [{ expressions: [{ value: true, text: 'data.rbac.allow' }] }],
    ...overrides,
  });

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── rego_eval (the bread-and-butter case) ────────────────────────────────

describe('rego_eval', () => {
  it('evaluates against fixture paths and returns the parsed result', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout()));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ result?: unknown[] }>(server, 'rego_eval', {
      query: 'data.rbac.allow',
      paths: [validRegoPath()],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.result).toBeDefined();
    const args = mockRun.mock.calls[0]![1].args;
    expect(args[0]).toBe('eval');
    expect(args).toContain('--data');
    expect(args).toContain(validRegoPath());
    expect(args[args.length - 1]).toBe('data.rbac.allow');
  });

  it('writes inline source to a temp file and adds it to --data', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout()));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_eval', {
      query: 'data.x.allow',
      source: 'package x\nimport rego.v1\nallow := true',
    });
    expect(env.ok).toBe(true);
    const args = mockRun.mock.calls[0]![1].args;
    const dataIdx = args.indexOf('--data');
    expect(dataIdx).toBeGreaterThan(-1);
    expect(args[dataIdx + 1]).toMatch(/orygn-opa-mcp-.*\.rego$/);
  });

  it('pipes inline input via --stdin-input', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout()));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_eval', {
      query: 'input.user',
      paths: [validRegoPath()],
      input: { user: 'alice' },
    });
    const opts = mockRun.mock.calls[0]![1];
    expect(opts.args).toContain('--stdin-input');
    expect(opts.stdin).toBe('{"user":"alice"}');
  });

  it('uses --input flag when inputPath is provided', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout()));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_eval', {
      query: 'data.rbac.allow',
      paths: [validRegoPath()],
      inputPath: validInputPath(),
    });
    const opts = mockRun.mock.calls[0]![1];
    expect(opts.args).toContain('--input');
    expect(opts.args).toContain(validInputPath());
    expect(opts.args).not.toContain('--stdin-input');
  });

  it('rejects calls with neither source nor paths', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_eval', { query: 'data.x' });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.message).toMatch(/source.*paths/);
  });

  it('rejects calls with both input and inputPath', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_eval', {
      query: 'data.x',
      paths: [validRegoPath()],
      input: { a: 1 },
      inputPath: validInputPath(),
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects paths outside allowed roots', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_eval', {
      query: 'data.x',
      paths: ['/outside/p.rego'],
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects inputPath outside allowed roots', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_eval', {
      query: 'data.x',
      paths: [validRegoPath()],
      inputPath: '/outside/i.json',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('maps a non-zero opa exit to EVAL_ERROR', async () => {
    mockRun.mockResolvedValueOnce(
      spawnFailure(1, 'eval failed', JSON.stringify({ errors: [{ message: 'unexpected' }] })),
    );
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_eval', {
      query: 'data.x',
      paths: [validRegoPath()],
    });
    expect(env.error?.code).toBe('EVAL_ERROR');
  });

  it('maps a missing binary to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_eval', {
      query: 'data.x',
      paths: [validRegoPath()],
    });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });
});

// ─── eval variants — verify each sets the right flag ──────────────────────

describe('rego_eval_with_explain', () => {
  it('attaches --explain=full', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(evalSuccessStdout({ explanation: [{ op: 'enter' }] })),
    );
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ explanation?: unknown[] }>(server, 'rego_eval_with_explain', {
      query: 'data.rbac.allow',
      paths: [validRegoPath()],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.explanation).toEqual([{ op: 'enter' }]);
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--explain');
    expect(args).toContain('full');
  });
});

describe('rego_eval_with_profile', () => {
  it('attaches --profile and --metrics', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout({ profile: [] })));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_eval_with_profile', {
      query: 'data.x',
      paths: [validRegoPath()],
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--profile');
    expect(args).toContain('--metrics');
  });
});

describe('rego_eval_with_coverage', () => {
  it('attaches --coverage', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout({ coverage: {} })));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_eval_with_coverage', {
      query: 'data.x',
      paths: [validRegoPath()],
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--coverage');
  });
});

// ─── rego_test ────────────────────────────────────────────────────────────

describe('rego_test', () => {
  it('parses an array of test records and computes pass/fail counts', async () => {
    const records = [
      { name: 'test_admin', pass: true, duration: 100 },
      { name: 'test_viewer', pass: true, duration: 50 },
      { name: 'test_anon', fail: true, duration: 30 },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(records)));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{
      passed: number;
      failed: number;
      total: number;
      results: typeof records;
    }>(server, 'rego_test', { paths: [validRegoPath()] });
    expect(env.ok).toBe(true);
    expect(env.data?.passed).toBe(2);
    expect(env.data?.failed).toBe(1);
    expect(env.data?.total).toBe(3);
  });

  it('parses NDJSON output as a fallback', async () => {
    const ndjson =
      JSON.stringify({ name: 'test_a', pass: true }) +
      '\n' +
      JSON.stringify({ name: 'test_b', fail: true });
    mockRun.mockResolvedValueOnce(spawnSuccess(ndjson));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ passed: number; failed: number }>(server, 'rego_test', {
      paths: [validRegoPath()],
    });
    expect(env.data?.passed).toBe(1);
    expect(env.data?.failed).toBe(1);
  });

  it('returns NO_TESTS_FOUND when opa exits 0 with no records', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_test', { paths: [validRegoPath()] });
    expect(env.error?.code).toBe('NO_TESTS_FOUND');
  });

  it('forwards --verbose, --coverage, --bench, --run flags', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ pass: true }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      verbose: true,
      coverage: true,
      runPattern: '^test_a',
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--verbose');
    expect(args).toContain('--coverage');
    expect(args).toContain('--run');
    expect(args).toContain('^test_a');
  });

  it('rejects paths outside allowed roots', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_test', { paths: ['/outside/x'] });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });
});

// ─── rego_bench ───────────────────────────────────────────────────────────

describe('rego_bench', () => {
  it('returns the parsed bench output', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(JSON.stringify({ iterations: 1000, metrics: { ns_per_op: 12345 } })),
    );
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ iterations?: number; metrics?: Record<string, unknown> }>(
      server,
      'rego_bench',
      { query: 'data.x', paths: [validRegoPath()], count: 1000 },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.iterations).toBe(1000);
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--count');
    expect(args).toContain('1000');
  });

  it('rejects calls with both input and inputPath', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_bench', {
      query: 'data.x',
      paths: [validRegoPath()],
      input: { a: 1 },
      inputPath: validInputPath(),
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('maps non-zero exit to EVAL_ERROR', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'bench failed'));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_bench', {
      query: 'data.x',
      paths: [validRegoPath()],
    });
    expect(env.error?.code).toBe('EVAL_ERROR');
  });
});

// ─── rego_compile_query (partial eval) ────────────────────────────────────

describe('rego_compile_query', () => {
  it('forces --partial and defaults unknowns to ["input"]', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout({ partial: { queries: [] } })));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_compile_query', {
      query: 'data.rbac.allow',
      paths: [validRegoPath()],
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--partial');
    const unknownsIdx = args.indexOf('--unknowns');
    expect(unknownsIdx).toBeGreaterThan(-1);
    expect(args[unknownsIdx + 1]).toBe('input');
  });

  it('passes through caller-provided unknowns when set', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout()));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_compile_query', {
      query: 'data.rbac.allow',
      paths: [validRegoPath()],
      unknowns: ['input.user', 'input.action'],
    });
    const args = mockRun.mock.calls[0]![1].args;
    const unknownIdxs = args
      .map((a, i) => (a === '--unknowns' ? i : -1))
      .filter((i) => i !== -1);
    expect(unknownIdxs).toHaveLength(2);
    expect(args[unknownIdxs[0]! + 1]).toBe('input.user');
    expect(args[unknownIdxs[1]! + 1]).toBe('input.action');
  });
});
