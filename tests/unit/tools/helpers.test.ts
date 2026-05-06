import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  baseConfig,
  callTool,
  fixturePath,
  makeServer,
  spawnFailure,
  spawnSuccess,
} from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

import { registerHelperTools } from '../../../src/tools/helpers/index.js';

const mockRun = vi.mocked(runBinary);

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── rego_explain_decision ─────────────────────────────────────────────────

describe('rego_explain_decision', () => {
  it('runs eval with --explain=full and returns a structured trace summary', async () => {
    const trace = [
      { op: 'enter', message: 'enter data.rbac.allow' },
      { op: 'enter', message: 'enter helper' },
      { op: 'exit', message: 'exit data.rbac.allow' },
      { op: 'fail', message: 'fail x' },
    ];
    mockRun.mockResolvedValueOnce(
      spawnSuccess(
        JSON.stringify({
          result: [{ expressions: [{ value: true, text: 'data.rbac.allow' }] }],
          explanation: trace,
        }),
      ),
    );
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      result: unknown;
      rulesFired: string[];
      rulesEvaluated: string[];
      trace: unknown[];
      summary: { totalEvents: number; enterEvents: number; exitEvents: number; failEvents: number };
    }>(server, 'rego_explain_decision', {
      query: 'data.rbac.allow',
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.result).toBe(true);
    expect(env.data?.summary.totalEvents).toBe(4);
    expect(env.data?.summary.enterEvents).toBe(2);
    expect(env.data?.summary.exitEvents).toBe(1);
    expect(env.data?.summary.failEvents).toBe(1);
    expect(env.data?.rulesEvaluated).toEqual(expect.arrayContaining(['data.rbac.allow']));
    expect(env.data?.rulesFired).toEqual(expect.arrayContaining(['data.rbac.allow']));
    expect(env.data?.trace).toHaveLength(4);

    // Verify --explain=full was actually passed.
    const args = mockRun.mock.calls[0]![1].args;
    const explainIdx = args.indexOf('--explain');
    expect(explainIdx).toBeGreaterThan(-1);
    expect(args[explainIdx + 1]).toBe('full');
  });

  it('propagates underlying eval errors', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'compile error'));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_explain_decision', {
      query: 'data.x',
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
    });
    expect(env.error?.code).toBe('EVAL_ERROR');
  });

  it('handles missing trace gracefully (zero summary, empty rule sets)', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(JSON.stringify({ result: [{ expressions: [{ value: false }] }] })),
    );
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      summary: { totalEvents: number };
      rulesFired: string[];
    }>(server, 'rego_explain_decision', {
      query: 'data.x',
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
    });
    expect(env.data?.summary.totalEvents).toBe(0);
    expect(env.data?.rulesFired).toEqual([]);
  });
});

// ─── rego_generate_test_skeleton ───────────────────────────────────────────

describe('rego_generate_test_skeleton', () => {
  it('emits one test stub per rule in the parsed AST', async () => {
    const ast = {
      package: { path: [{ value: 'data', type: 'var' }, { value: 'rbac', type: 'string' }] },
      rules: [
        { head: { name: 'allow' } },
        { head: { name: 'deny_reasons' } },
        { head: { name: 'allow' } }, // duplicate; should not produce a duplicate test
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string; ruleNames: string[] }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package rbac\nallow if true\ndeny_reasons[r] if r := "x"' },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.ruleNames).toEqual(['allow', 'deny_reasons']);
    expect(env.data?.testFile).toContain('package rbac_test');
    expect(env.data?.testFile).toContain('import rego.v1');
    expect(env.data?.testFile).toContain('import data.rbac');
    expect(env.data?.testFile).toContain('test_allow if {');
    expect(env.data?.testFile).toContain('test_deny_reasons if {');
    // Single allow rule shouldn't appear twice in the skeleton.
    expect(env.data?.testFile.match(/test_allow if/g)).toHaveLength(1);
  });

  it('handles a top-level package (no nested path)', async () => {
    const ast = {
      package: { path: [{ value: 'data', type: 'var' }] },
      rules: [{ head: { name: 'main' } }],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string }>(server, 'rego_generate_test_skeleton', {
      source: 'package main',
    });
    // With no nested package, fallback to main_test.
    expect(env.data?.testFile).toContain('package main_test');
  });

  it('reports INVALID_INPUT when no rules are found', async () => {
    const ast = {
      package: { path: [{ value: 'data', type: 'var' }, { value: 'empty', type: 'string' }] },
      rules: [],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_generate_test_skeleton', {
      source: 'package empty',
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('maps a parse failure to INVALID_REGO', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'parse error'));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_generate_test_skeleton', { source: 'broken' });
    expect(env.error?.code).toBe('INVALID_REGO');
  });
});

// ─── rego_describe_policy ─────────────────────────────────────────────────

describe('rego_describe_policy', () => {
  it('summarizes package, imports, and rules with annotations', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'rbac' }] },
      imports: [
        { path: { value: [{ value: 'rego' }, { value: 'v1' }] } },
        { path: { value: [{ value: 'data' }, { value: 'helpers' }] }, alias: 'h' },
      ],
      rules: [
        { head: { name: 'allow' }, default: true, body: [] },
        {
          head: { name: 'deny' },
          body: [{ a: 1 }, { a: 2 }],
          annotations: { title: 'Deny rule', description: 'denies things' },
        },
        { head: { name: 'deny' }, body: [{ a: 3 }] },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      package: string;
      imports: string[];
      ruleCount: number;
      rules: Array<{
        name: string;
        isDefault: boolean;
        bodyLength: number;
        annotations?: { title?: string };
      }>;
    }>(server, 'rego_describe_policy', { source: 'package rbac' });
    expect(env.ok).toBe(true);
    expect(env.data?.package).toBe('rbac');
    expect(env.data?.imports).toEqual(['rego.v1', 'data.helpers as h']);
    // `deny` appears twice — should be merged with bodyLength accumulated.
    expect(env.data?.ruleCount).toBe(2);
    const allow = env.data?.rules.find((r) => r.name === 'allow');
    const deny = env.data?.rules.find((r) => r.name === 'deny');
    expect(allow?.isDefault).toBe(true);
    expect(deny?.bodyLength).toBe(3); // 2 from first + 1 from second
    expect(deny?.annotations?.title).toBe('Deny rule');
  });

  it('handles policies with no rules', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'empty' }] },
      rules: [],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ ruleCount: number; rules: unknown[] }>(
      server,
      'rego_describe_policy',
      { source: 'package empty' },
    );
    expect(env.data?.ruleCount).toBe(0);
    expect(env.data?.rules).toEqual([]);
  });

  it('maps parse failure to INVALID_REGO', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'parse error'));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_describe_policy', { source: 'broken' });
    expect(env.error?.code).toBe('INVALID_REGO');
  });
});

// ─── rego_suggest_fix ─────────────────────────────────────────────────────

describe('rego_suggest_fix', () => {
  it('produces a high-confidence suggestion for rego_unsafe_var_error with a named var', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      suggestions: Array<{ code: string; suggestion: string; confidence: string }>;
    }>(server, 'rego_suggest_fix', {
      diagnostics: [
        { code: 'rego_unsafe_var_error', message: 'var x is unsafe' },
      ],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.suggestions).toHaveLength(1);
    expect(env.data?.suggestions[0]?.code).toBe('rego_unsafe_var_error');
    expect(env.data?.suggestions[0]?.confidence).toBe('high');
    expect(env.data?.suggestions[0]?.suggestion).toContain('`x`');
  });

  it('handles a rego_parse_error with a medium-confidence suggestion', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      suggestions: Array<{ confidence: string; suggestion: string }>;
    }>(server, 'rego_suggest_fix', {
      diagnostics: [{ code: 'rego_parse_error', message: 'unexpected token' }],
    });
    expect(env.data?.suggestions[0]?.confidence).toBe('medium');
    expect(env.data?.suggestions[0]?.suggestion).toMatch(/rego_format/);
  });

  it('matches Regal violations by their title (used as the code)', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      suggestions: Array<{ code: string; confidence: string; suggestion: string }>;
    }>(server, 'rego_suggest_fix', {
      diagnostics: [
        {
          code: '',
          message: 'print() call in rule body',
          title: 'print-or-trace-call',
          category: 'style',
        },
      ],
    });
    expect(env.data?.suggestions[0]?.code).toBe('print-or-trace-call');
    expect(env.data?.suggestions[0]?.confidence).toBe('high');
  });

  it('returns a low-confidence fallback for unrecognized codes', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      suggestions: Array<{ confidence: string; suggestion: string }>;
    }>(server, 'rego_suggest_fix', {
      diagnostics: [{ code: 'rego_brand_new_error', message: 'something we have not seen' }],
    });
    expect(env.data?.suggestions[0]?.confidence).toBe('low');
    expect(env.data?.suggestions[0]?.suggestion).toMatch(/No automated suggestion/);
  });

  it('produces one suggestion per diagnostic and preserves order', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ suggestions: Array<{ code: string }> }>(
      server,
      'rego_suggest_fix',
      {
        diagnostics: [
          { code: 'rego_unsafe_var_error', message: 'var a is unsafe' },
          { code: 'rego_recursion_error', message: 'recursion detected' },
          { code: 'rego_compile_error', message: 'unknown' },
        ],
      },
    );
    expect(env.data?.suggestions).toHaveLength(3);
    expect(env.data?.suggestions.map((s) => s.code)).toEqual([
      'rego_unsafe_var_error',
      'rego_recursion_error',
      'rego_compile_error',
    ]);
  });
});
