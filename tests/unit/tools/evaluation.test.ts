import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  baseConfig,
  callTool,
  fixturePath,
  makeServer,
  spawnFailure,
  spawnSuccess,
  spawnTimedOut,
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
    expect(args[dataIdx + 1]).toMatch(/orygn-opa-mcp-[^/\\]+[/\\]input\.rego$/);
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

  it('parses a JSON string passed as input (LLM serialization mistake)', async () => {
    // LLMs often pass JSON as a string: input: '{"user":"alice"}' instead of
    // input: {user: "alice"}. We parse it so OPA gets an object on stdin.
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout()));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_eval', {
      query: 'input.user',
      paths: [validRegoPath()],
      input: '{"user":"alice"}',
    });
    const opts = mockRun.mock.calls[0]![1];
    expect(opts.args).toContain('--stdin-input');
    expect(opts.stdin).toBe('{"user":"alice"}');
  });

  it('passes a non-JSON string input through as-is', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(evalSuccessStdout()));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_eval', {
      query: 'input',
      paths: [validRegoPath()],
      input: 'plain string',
    });
    const opts = mockRun.mock.calls[0]![1];
    expect(opts.stdin).toBe('"plain string"');
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

// Real OPA JSON output for passing tests: NO `pass` field -- only `fail: true`
// for failures and `skip: true` for todo_* tests. The `passed` count is derived
// as `total - failed - skipped`, NOT by counting records with `pass: true`.
describe('rego_test', () => {
  it('computes pass/fail/skipped counts from real OPA output (no pass field on passing tests)', async () => {
    const records = [
      { name: 'test_admin', duration: 100 }, // passing -- no pass field
      { name: 'test_viewer', duration: 50 }, // passing -- no pass field
      { name: 'test_anon', fail: true, duration: 30 },
      { name: 'todo_pending', skip: true, duration: 0 },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(records)));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{
      passed: number;
      failed: number;
      skipped: number;
      total: number;
    }>(server, 'rego_test', { paths: [validRegoPath()] });
    expect(env.ok).toBe(true);
    expect(env.data?.passed).toBe(2); // total(4) - failed(1) - skipped(1)
    expect(env.data?.failed).toBe(1);
    expect(env.data?.skipped).toBe(1);
    expect(env.data?.total).toBe(4);
  });

  it('parses NDJSON output as a fallback', async () => {
    // Older OPA versions emit one JSON object per line rather than a wrapped array.
    const ndjson =
      JSON.stringify({ name: 'test_a', duration: 10 }) +
      '\n' +
      JSON.stringify({ name: 'test_b', fail: true, duration: 5 });
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

  it('forwards --verbose and --run flags in normal mode', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      verbose: true,
      runPattern: '^test_a',
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--verbose');
    expect(args).toContain('--run');
    expect(args).toContain('^test_a');
    expect(args).not.toContain('--coverage'); // not set
    expect(args).not.toContain('--threshold'); // not set
  });

  // ─── coverage mode ────────────────────────────────────────────────────

  it('returns coverage JSON when coverage:true and all tests pass', async () => {
    // Real OPA output with --coverage: a JSON object, NOT a test-record array.
    const coverageJson = JSON.stringify({
      files: { 'policy.rego': { covered_lines: 8, not_covered_lines: 2, coverage: 80 } },
      covered_lines: 8,
      not_covered_lines: 2,
      coverage: 80,
    });
    mockRun.mockResolvedValueOnce(spawnSuccess(coverageJson));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ coveragePct?: number; coverage?: unknown }>(server, 'rego_test', {
      paths: [validRegoPath()],
      coverage: true,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.coveragePct).toBe(80);
    expect(env.data?.coverage).toBeDefined();
    // OPA does not emit test records in coverage mode -- counts are zero.
    const typedData = env.data as { passed: number; total: number } | undefined;
    expect(typedData?.passed).toBe(0);
    expect(typedData?.total).toBe(0);
    // --coverage flag must be present in argv
    expect(mockRun.mock.calls[0]![1].args).toContain('--coverage');
  });

  it('passes --threshold to OPA and reports thresholdMet:true when threshold is met', async () => {
    const coverageJson = JSON.stringify({ coverage: 90, covered_lines: 9, not_covered_lines: 1 });
    mockRun.mockResolvedValueOnce(spawnSuccess(coverageJson));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ coveragePct?: number; thresholdMet?: boolean }>(
      server,
      'rego_test',
      { paths: [validRegoPath()], threshold: 80 },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.thresholdMet).toBe(true);
    expect(env.data?.coveragePct).toBe(90);

    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--threshold');
    expect(args[args.indexOf('--threshold') + 1]).toBe('80');
    // threshold implicitly enables coverage mode
    expect(args).toContain('--coverage');
  });

  it('returns COVERAGE_BELOW_THRESHOLD when OPA reports threshold not met', async () => {
    // OPA emits this exact message on stderr (exit 2), stdout is empty.
    const thresholdMsg = 'Code coverage threshold not met: got 75.00 instead of 90.00';
    mockRun.mockResolvedValueOnce(spawnFailure(2, thresholdMsg, ''));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ details?: { actualCoverage?: number } }>(server, 'rego_test', {
      paths: [validRegoPath()],
      threshold: 90,
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('COVERAGE_BELOW_THRESHOLD');
    expect(env.error?.details).toMatchObject({ actualCoverage: 75, requiredThreshold: 90 });
  });

  it('returns EVAL_ERROR when tests fail in coverage mode', async () => {
    // OPA exits 1 with test failure on stderr; stdout is empty.
    const failMsg = 'data.example_test.test_denied: FAIL (0s)';
    mockRun.mockResolvedValueOnce(spawnFailure(1, failMsg, ''));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      threshold: 80,
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('EVAL_ERROR');
    expect(env.error?.message).toContain('FAIL');
  });

  it('rejects threshold values outside 0-100', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    // Zod schema rejects values outside [0, 100] before the handler runs.
    const envHigh = await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      threshold: 101,
    });
    expect(envHigh.ok).toBe(false);
    const envNeg = await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      threshold: -1,
    });
    expect(envNeg.ok).toBe(false);
  });

  it('rejects paths outside allowed roots', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_test', { paths: ['/outside/x'] });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  // ─── varValues ────────────────────────────────────────────────────────

  it('forwards --var-values to opa when varValues: true', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      varValues: true,
    });
    expect(mockRun.mock.calls[0]![1].args).toContain('--var-values');
  });

  it('does not forward --var-values when varValues is false', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      varValues: false,
    });
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--var-values');
  });

  it('does not forward --var-values when varValues is omitted', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', { paths: [validRegoPath()] });
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--var-values');
  });

  it('can combine varValues: true with verbose: true', async () => {
    // --var-values is only meaningful alongside --verbose; the tool should pass
    // both flags without conflict.
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      verbose: true,
      varValues: true,
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--verbose');
    expect(args).toContain('--var-values');
  });

  it('preserves test records with trace data when varValues is set', async () => {
    // When --var-values is set, OPA adds a `trace` array to each failing test
    // record. The tool must not strip unknown fields -- they pass through as-is.
    const traceRecord = {
      name: 'test_table_case',
      fail: true,
      duration: 5,
      trace: [
        {
          op: 'Eval',
          node: { type: 'Every' },
          locals: [{ key: 'tc', value: { input: {}, expected: true } }],
        },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([traceRecord])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{
      results: Array<{ name?: string; trace?: unknown; fail?: boolean }>;
    }>(server, 'rego_test', { paths: [validRegoPath()], varValues: true });
    expect(env.ok).toBe(true);
    expect(env.data?.results[0]?.trace).toBeDefined();
    expect(env.data?.results[0]?.fail).toBe(true);
  });

  it('places --var-values before --threshold in argv', async () => {
    // Ordering matters: the test() handler must emit --var-values before --threshold.
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ coverage: 90 })));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      varValues: true,
      threshold: 80,
    });
    const args = mockRun.mock.calls[0]![1].args;
    const varValuesIdx = args.indexOf('--var-values');
    const thresholdIdx = args.indexOf('--threshold');
    expect(varValuesIdx).toBeGreaterThan(-1);
    expect(thresholdIdx).toBeGreaterThan(-1);
    expect(varValuesIdx).toBeLessThan(thresholdIdx);
  });

  // ─── new params: ignorePatterns, bundle, count, timeout ───────────────

  it('passes --ignore for each pattern in ignorePatterns', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      ignorePatterns: ['*_generated.rego', 'fixtures/**'],
    });
    const args = mockRun.mock.calls[0]![1].args;
    const ignoreIdxs = args.map((a, i) => (a === '--ignore' ? i : -1)).filter((i) => i !== -1);
    expect(ignoreIdxs).toHaveLength(2);
    expect(args[ignoreIdxs[0]! + 1]).toBe('*_generated.rego');
    expect(args[ignoreIdxs[1]! + 1]).toBe('fixtures/**');
  });

  it('does not emit --ignore when ignorePatterns is empty', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', { paths: [validRegoPath()], ignorePatterns: [] });
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--ignore');
  });

  it('passes --bundle when bundle: true', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', { paths: [validRegoPath()], bundle: true });
    expect(mockRun.mock.calls[0]![1].args).toContain('--bundle');
  });

  it('does not emit --bundle when bundle is false or omitted', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', { paths: [validRegoPath()], bundle: false });
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--bundle');
  });

  it('passes --count N when count is set', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', { paths: [validRegoPath()], count: 5 });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--count');
    expect(args[args.indexOf('--count') + 1]).toBe('5');
  });

  it('does not emit --count when count is omitted', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', { paths: [validRegoPath()] });
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--count');
  });

  it('rejects count: 0 with INVALID_INPUT before invoking opa', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_test', { paths: [validRegoPath()], count: 0 });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('passes --timeout when timeout is set', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', { paths: [validRegoPath()], timeout: '30s' });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--timeout');
    expect(args[args.indexOf('--timeout') + 1]).toBe('30s');
  });

  it('does not emit --timeout when timeout is omitted', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([{ name: 'test_a', duration: 1 }])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_test', { paths: [validRegoPath()] });
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--timeout');
  });

  // ─── NO_TESTS_FOUND hint improvement ──────────────────────────────────

  it('includes runPattern in NO_TESTS_FOUND hint when no tests match', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_test', {
      paths: [validRegoPath()],
      runPattern: '^test_admin',
    });
    expect(env.error?.code).toBe('NO_TESTS_FOUND');
    expect(env.error?.hint).toContain('^test_admin');
    expect(env.error?.hint).toContain('pattern');
  });

  it('returns plain NO_TESTS_FOUND hint when runPattern is absent', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_test', { paths: [validRegoPath()] });
    expect(env.error?.code).toBe('NO_TESTS_FOUND');
    // Hint should not reference a pattern when none was given.
    expect(env.error?.hint).not.toContain('matched');
  });

  // ─── parameterizedGroups ──────────────────────────────────────────────

  it('populates parameterizedGroups for test_X[...] style records', async () => {
    const records = [
      { name: 'test_allow[{"role":"admin"}]', duration: 1 },
      { name: 'test_allow[{"role":"viewer"}]', fail: true, duration: 2 },
      { name: 'test_deny[{"action":"write"}]', duration: 1 },
      { name: 'test_plain', duration: 1 }, // non-parametrized, should not appear in groups
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(records)));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{
      parameterizedGroups: Record<string, Array<{ name?: string; fail?: boolean }>>;
    }>(server, 'rego_test', { paths: [validRegoPath()] });

    expect(env.ok).toBe(true);
    const groups = env.data?.parameterizedGroups;
    expect(groups).toBeDefined();
    expect(Object.keys(groups!)).toContain('test_allow');
    expect(Object.keys(groups!)).toContain('test_deny');
    expect(Object.keys(groups!)).not.toContain('test_plain');
    // test_allow has 2 cases
    expect(groups!['test_allow']).toHaveLength(2);
    // The failing case is present in the group
    const allowCases = groups!['test_allow']!;
    expect(allowCases.some((r) => r.fail === true)).toBe(true);
    // test_deny has 1 case
    expect(groups!['test_deny']).toHaveLength(1);
  });

  it('omits parameterizedGroups when no test_X[...] records are present', async () => {
    const records = [
      { name: 'test_a', duration: 1 },
      { name: 'test_b', fail: true, duration: 2 },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(records)));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ parameterizedGroups?: unknown }>(server, 'rego_test', {
      paths: [validRegoPath()],
    });
    expect(env.ok).toBe(true);
    // No parametrized groups -- field should be absent.
    expect(env.data?.parameterizedGroups).toBeUndefined();
  });

  it('counts parametrized cases correctly in pass/fail totals', async () => {
    // 2 parametrized cases for test_allow: 1 pass, 1 fail
    const records = [
      { name: 'test_allow[{"role":"admin"}]', duration: 1 },
      { name: 'test_allow[{"role":"viewer"}]', fail: true, duration: 2 },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(records)));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ passed: number; failed: number; total: number }>(
      server,
      'rego_test',
      { paths: [validRegoPath()] },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.total).toBe(2);
    expect(env.data?.passed).toBe(1);
    expect(env.data?.failed).toBe(1);
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

  it('rejects inputPath outside the allow-list', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_bench', {
      query: 'data.x',
      paths: [validRegoPath()],
      inputPath: '/outside/i.json',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects paths outside the allow-list', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_bench', {
      query: 'data.x',
      paths: ['/outside/p.rego'],
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('returns UNKNOWN_ERROR when bench output is unparseable', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('not json'));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'rego_bench', {
      query: 'data.x',
      paths: [validRegoPath()],
    });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('uses --input file when inputPath is provided (no --stdin-input)', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ iterations: 1 })));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'rego_bench', {
      query: 'data.x',
      paths: [validRegoPath()],
      inputPath: validInputPath(),
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--input');
    expect(args).toContain(validInputPath());
    expect(args).not.toContain('--stdin-input');
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
    const unknownIdxs = args.map((a, i) => (a === '--unknowns' ? i : -1)).filter((i) => i !== -1);
    expect(unknownIdxs).toHaveLength(2);
    expect(args[unknownIdxs[0]! + 1]).toBe('input.user');
    expect(args[unknownIdxs[1]! + 1]).toBe('input.action');
  });
});

// ─── opa_exec ─────────────────────────────────────────────────────────────

const execSuccessStdout = (entries: Array<{ path: string; result?: unknown; error?: object }>) =>
  JSON.stringify({ result: entries });

describe('opa_exec', () => {
  it('issues correct argv and parses per-file results', async () => {
    const entries = [
      { path: validInputPath(), result: true },
      { path: fixturePath('inputs', 'rbac.json'), result: false },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(execSuccessStdout(entries)));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{
      results: typeof entries;
      count: number;
      successCount: number;
      errorCount: number;
    }>(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
    });

    expect(env.ok).toBe(true);
    expect(env.data?.results).toEqual(entries);
    expect(env.data?.count).toBe(2);
    expect(env.data?.successCount).toBe(2);
    expect(env.data?.errorCount).toBe(0);

    const args = mockRun.mock.calls[0]![1].args;
    expect(args[0]).toBe('exec');
    expect(args).toContain('--format=json');
    expect(args).toContain('--decision');
    expect(args[args.indexOf('--decision') + 1]).toBe('data.rbac.allow');
    // Input path is a positional arg at the end of argv.
    expect(args[args.length - 1]).toBe(validInputPath());
  });

  it('passes --bundle flag when bundle is provided', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(execSuccessStdout([{ path: validInputPath(), result: true }])),
    );
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.authz.allow',
      bundle: fixturePath('policies', 'valid'),
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--bundle');
    expect(args[args.indexOf('--bundle') + 1]).toBe(fixturePath('policies', 'valid'));
    expect(args).not.toContain('--data');
  });

  it('passes --data flags for each dataPaths entry', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(execSuccessStdout([{ path: validInputPath(), result: true }])),
    );
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    await callTool(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
      dataPaths: [validRegoPath(), fixturePath('policies', 'valid')],
    });
    const args = mockRun.mock.calls[0]![1].args;
    const dataIdxs = args.map((a, i) => (a === '--data' ? i : -1)).filter((i) => i !== -1);
    expect(dataIdxs).toHaveLength(2);
    expect(args[dataIdxs[0]! + 1]).toBe(validRegoPath());
    expect(args[dataIdxs[1]! + 1]).toBe(fixturePath('policies', 'valid'));
    expect(args).not.toContain('--bundle');
  });

  it('rejects providing both bundle and dataPaths', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
      bundle: fixturePath('policies', 'valid'),
      dataPaths: [validRegoPath()],
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects inputPaths outside allowed roots', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'opa_exec', {
      inputPaths: ['/outside/input.json'],
      decision: 'data.rbac.allow',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects bundle outside allowed roots', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
      bundle: '/outside/bundle.tar.gz',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects dataPaths outside allowed roots', async () => {
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
      dataPaths: ['/outside/policy.rego'],
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('maps non-zero exit to EVAL_ERROR', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'bundle load failed'));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
    });
    expect(env.error?.code).toBe('EVAL_ERROR');
    expect((env.error?.details as { stderr?: string })?.stderr).toContain('bundle load failed');
  });

  it('maps missing binary to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
    });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });

  it('maps subprocess timeout to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
    });
    expect(env.error?.code).toBe('TIMEOUT');
  });

  it('computes successCount and errorCount correctly from mixed results', async () => {
    const entries = [
      { path: 'input1.json', result: true },
      { path: 'input2.json', error: { code: 'eval_error', message: 'failed' } },
      { path: 'input3.json', result: false },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(execSuccessStdout(entries)));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{
      count: number;
      successCount: number;
      errorCount: number;
    }>(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.count).toBe(3);
    expect(env.data?.successCount).toBe(2);
    expect(env.data?.errorCount).toBe(1);
  });

  it('returns UNKNOWN_ERROR when opa exec produces no parseable JSON', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('this is not json'));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
    });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('handles empty result array (no inputs matched)', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(execSuccessStdout([])));
    const server = makeServer();
    registerEvaluationTools(server, baseConfig);
    const env = await callTool<{ count: number; results: unknown[] }>(server, 'opa_exec', {
      inputPaths: [validInputPath()],
      decision: 'data.rbac.allow',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.count).toBe(0);
    expect(env.data?.results).toEqual([]);
  });
});
