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
};

/** Tools with the option whose forwarding is covered by their own tests. */
const COVERED_ELSEWHERE = new Set(['opa_bundle_verify']);

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

  for (const [tool, args] of Object.entries(CALLS)) {
    it(`${tool} passes --v0-compatible to opa when set, and not otherwise`, async () => {
      const server = makeServer();
      registerTools(server, baseConfig);

      await callTool(server, tool, { ...args(), v0Compatible: true });
      const withFlag = mockRun.mock.calls.map((c) => c[1].args);
      expect(withFlag.length).toBeGreaterThan(0);
      expect(withFlag.some((a) => a.includes('--v0-compatible'))).toBe(true);

      mockRun.mockClear();
      await callTool(server, tool, args());
      const without = mockRun.mock.calls.map((c) => c[1].args);
      expect(without.length).toBeGreaterThan(0);
      expect(without.some((a) => a.includes('--v0-compatible'))).toBe(false);
    });
  }
});
