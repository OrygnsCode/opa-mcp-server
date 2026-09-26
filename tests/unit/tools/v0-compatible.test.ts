/**
 * `v0Compatible` on every tool that has opa load Rego.
 *
 * OPA 1.x refuses a pre-1.0 policy unless told to read v0, so a tool that
 * declares the option and then drops it on the way to opa leaves a legacy
 * policy impossible to evaluate, test or check. One table covers them all, and
 * a guard fails when a tool gains the option without an entry here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseConfig, callTool, fixturePath, makeServer, spawnSuccess } from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

import { registerTools } from '../../../src/tools/index.js';

const mockRun = vi.mocked(runBinary);

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue(spawnSuccess('{}'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const policy = () => fixturePath('policies', 'valid', 'rbac.rego');
const policyDir = () => fixturePath('policies', 'valid');
const input = () => fixturePath('inputs', 'rbac.json');

/** The smallest valid call of each tool, without the option under test. */
const CALLS: Record<string, () => Record<string, unknown>> = {
  rego_check: () => ({ paths: [policy()] }),
  rego_check_schema: () => ({ paths: [policy()], inlineSchema: { type: 'object' } }),
  rego_format: () => ({ source: 'package x\n' }),
  rego_parse_ast: () => ({ source: 'package x\n' }),
  rego_inspect: () => ({ target: policy() }),
  rego_eval: () => ({ query: 'data.rbac.allow', paths: [policy()] }),
  rego_eval_with_explain: () => ({ query: 'data.rbac.allow', paths: [policy()] }),
  rego_eval_with_profile: () => ({ query: 'data.rbac.allow', paths: [policy()] }),
  rego_eval_with_coverage: () => ({ query: 'data.rbac.allow', paths: [policy()] }),
  rego_compile_query: () => ({ query: 'data.rbac.allow', paths: [policy()] }),
  rego_explain_decision: () => ({ query: 'data.rbac.allow', paths: [policy()] }),
  rego_test: () => ({ paths: [policyDir()] }),
  rego_test_multiroot: () => ({ roots: [{ path: policyDir() }] }),
  rego_coverage_gaps: () => ({ paths: [policyDir()] }),
  rego_bench: () => ({ query: 'data.rbac.allow', paths: [policy()] }),
  opa_exec: () => ({ inputPaths: [input()], decision: 'rbac/allow', dataPaths: [policyDir()] }),
  opa_bundle_build: () => ({ paths: [policyDir()], output: fixturePath('never-written.tar.gz') }),
  rego_format_write: () => ({ paths: [policyDir()], dryRun: true }),
  rego_explain_undefined: () => ({ query: 'data.rbac.allow', paths: [policy()] }),
  rego_describe_policy: () => ({ source: 'package x\n' }),
  rego_generate_test_skeleton: () => ({ source: 'package x\n' }),
  rego_infer_input_schema: () => ({ source: 'package x\n' }),
  conftest_test: () => ({ inlineConfig: 'kind: Pod\n', inlinePolicy: 'package main\n' }),
  conftest_verify: () => ({ policy: fixturePath('conftest', 'policy') }),
};

/** The argv each tool is expected to carry; opa's flag unless named here. */
const EXPECTED: Record<string, string[]> = {
  conftest_test: ['--rego-version', 'v0'],
  conftest_verify: ['--rego-version', 'v0'],
};

/** True when `args` holds `flag` as consecutive entries. */
const carries = (args: string[], flag: string[]): boolean =>
  args.some((_, i) => flag.every((f, j) => args[i + j] === f));

/**
 * Tools with the option whose forwarding is covered by their own tests:
 * rego_verify's is tested against real OPA, since a mocked AST would bring
 * up the Z3 engine inside a unit test.
 */
const COVERED_ELSEWHERE = new Set(['opa_bundle_verify', 'rego_verify']);

interface RegisteredToolLike {
  inputSchema?: { shape?: Record<string, unknown> };
}

const declaresV0 = (): string[] => {
  const server = makeServer();
  registerTools(server, baseConfig);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })
    ._registeredTools;
  return Object.entries(tools)
    .filter(([, t]) => t.inputSchema?.shape?.['v0Compatible'] !== undefined)
    .map(([name]) => name)
    .sort();
};

describe('v0Compatible', () => {
  it('is declared by exactly the tools this file covers', () => {
    expect(declaresV0()).toEqual(
      [...Object.keys(CALLS), ...COVERED_ELSEWHERE].sort((a, b) => a.localeCompare(b)),
    );
  });

  // --v0-compatible reads the query as v0 as well, where `in` and `every` are
  // keywords only once imported.
  const QUERY_TOOLS = [
    'rego_eval',
    'rego_eval_with_explain',
    'rego_eval_with_profile',
    'rego_eval_with_coverage',
    'rego_compile_query',
    'rego_explain_decision',
    'rego_bench',
  ];
  const importsKeywords = (a: string[]) =>
    a.some((arg, i) => arg === '--import' && a[i + 1] === 'future.keywords');

  for (const tool of QUERY_TOOLS) {
    it(`${tool} imports the future keywords into a v0 query, and only then`, async () => {
      const server = makeServer();
      registerTools(server, baseConfig);

      await callTool(server, tool, { ...CALLS[tool]!(), v0Compatible: true });
      expect(mockRun.mock.calls.some((c) => importsKeywords(c[1].args))).toBe(true);

      mockRun.mockClear();
      await callTool(server, tool, CALLS[tool]!());
      expect(mockRun.mock.calls.some((c) => importsKeywords(c[1].args))).toBe(false);
    });
  }

  for (const [tool, args] of Object.entries(CALLS)) {
    const flag = EXPECTED[tool] ?? ['--v0-compatible'];
    it(`${tool} passes ${flag.join(' ')} when v0Compatible is set, and not otherwise`, async () => {
      const server = makeServer();
      registerTools(server, baseConfig);

      await callTool(server, tool, { ...args(), v0Compatible: true });
      const withFlag = mockRun.mock.calls.map((c) => c[1].args);
      expect(withFlag.length).toBeGreaterThan(0);
      expect(withFlag.some((a) => carries(a, flag))).toBe(true);

      mockRun.mockClear();
      await callTool(server, tool, args());
      const without = mockRun.mock.calls.map((c) => c[1].args);
      expect(without.length).toBeGreaterThan(0);
      expect(without.some((a) => carries(a, flag))).toBe(false);
    });
  }

  it('rego_policy_diff reads each side as v0 only when that side asks', async () => {
    const server = makeServer();
    registerTools(server, baseConfig);
    await callTool(server, 'rego_policy_diff', {
      pathA: policy(),
      sourceB: 'package rbac\n',
      query: 'data.rbac.allow',
      v0CompatibleA: true,
    });
    const evals = mockRun.mock.calls.map((c) => c[1].args).filter((a) => a[0] === 'eval');
    expect(evals).toHaveLength(2);
    // Side A loads the fixture path; side B an inline temp file.
    const sideA = evals.find((a) => a.some((x) => x.endsWith('rbac.rego')))!;
    const sideB = evals.find((a) => a !== sideA)!;
    expect(sideA).toContain('--v0-compatible');
    expect(sideB).not.toContain('--v0-compatible');
  });
});
