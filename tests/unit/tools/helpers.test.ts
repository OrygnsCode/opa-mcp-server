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
      { Op: 'Enter', Node: { head: { name: 'data.rbac.allow' } }, Message: '' },
      { Op: 'Enter', Node: { head: { name: 'helper' } }, Message: '' },
      { Op: 'Exit', Node: { head: { name: 'data.rbac.allow' } }, Message: '' },
      { Op: 'Fail', Message: 'fail x' },
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

  it('handles trace events without a rule name (query-level events)', async () => {
    // Enter/exit events for query frames (Node is an array of terms, not a
    // rule object) must still increment the counters but not populate rule sets.
    const trace = [
      { Op: 'Enter' },
      { Op: 'Enter', Node: [{ terms: [] }] },
      { Op: 'Exit' },
      { Op: 'Fail', Message: 'expr fail' },
    ];
    mockRun.mockResolvedValueOnce(
      spawnSuccess(
        JSON.stringify({
          result: [{ expressions: [{ value: null }] }],
          explanation: trace,
        }),
      ),
    );
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      summary: { enterEvents: number; exitEvents: number; failEvents: number };
      rulesEvaluated: string[];
      rulesFired: string[];
    }>(server, 'rego_explain_decision', {
      query: 'data.x',
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
    });
    expect(env.data?.summary.enterEvents).toBe(2);
    expect(env.data?.summary.exitEvents).toBe(1);
    expect(env.data?.summary.failEvents).toBe(1);
    expect(env.data?.rulesEvaluated).toEqual([]);
    expect(env.data?.rulesFired).toEqual([]);
  });

  it('returns undefined result when the eval result array is empty', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ result: [], explanation: [] })));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ result: unknown }>(server, 'rego_explain_decision', {
      query: 'data.x',
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.result).toBeUndefined();
  });
});

// ─── rego_generate_test_skeleton ───────────────────────────────────────────

describe('rego_generate_test_skeleton', () => {
  it('emits one test stub per rule in the parsed AST', async () => {
    const ast = {
      package: {
        path: [
          { value: 'data', type: 'var' },
          { value: 'rbac', type: 'string' },
        ],
      },
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
      package: {
        path: [
          { value: 'data', type: 'var' },
          { value: 'empty', type: 'string' },
        ],
      },
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

  it('extracts rule names from the head.ref array form (no head.name)', async () => {
    // OPA emits multi-segment rule heads as a `ref` array: e.g. for
    // `allow.read := true`, head.ref is [{value: "allow"}, {value: "read"}].
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'multi' }] },
      rules: [
        {
          head: {
            ref: [
              { value: 'allow', type: 'var' },
              { value: 'read', type: 'string' },
            ],
          },
        },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ ruleNames: string[]; testFile: string }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package multi' },
    );
    expect(env.data?.ruleNames).toEqual(['allow.read']);
    // Sanitization: `.` in rule name becomes `_` in the test name.
    expect(env.data?.testFile).toContain('test_allow_read if {');
  });

  it('skips rules where neither head.name nor head.ref yields a name', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'x' }] },
      rules: [
        { head: {} }, // no name, no ref
        { head: { name: 'good' } },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ ruleNames: string[] }>(server, 'rego_generate_test_skeleton', {
      source: 'package x',
    });
    expect(env.data?.ruleNames).toEqual(['good']);
  });

  it('returns INVALID_REGO when opa parse outputs unparseable JSON', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('definitely not json'));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_generate_test_skeleton', {
      source: 'package x',
    });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  // ─── tableStyle ──────────────────────────────────────────────────────

  it('emits every-loop stubs when tableStyle: true', async () => {
    const ast = {
      package: {
        path: [
          { value: 'data', type: 'var' },
          { value: 'authz', type: 'string' },
        ],
      },
      rules: [{ head: { name: 'allow' } }],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string; ruleNames: string[] }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package authz\nallow if true', tableStyle: true },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.ruleNames).toEqual(['allow']);
    const file = env.data?.testFile ?? '';
    // Package header matches the source package.
    expect(file).toContain('package authz_test');
    expect(file).toContain('import rego.v1');
    expect(file).toContain('import data.authz');
    // Cases array declared at package scope.
    expect(file).toContain('allow_cases := [');
    // Each case object has the three required scaffold keys.
    expect(file).toContain('"description"');
    expect(file).toContain('"input"');
    expect(file).toContain('"expected"');
    // The test rule uses `every` over the cases array.
    expect(file).toContain('test_allow if {');
    expect(file).toContain('every tc in allow_cases {');
    // Body evaluates the rule under test with tc.input and compares to tc.expected.
    expect(file).toContain('data.authz.allow with input as tc.input');
    expect(file).toContain('actual == tc.expected');
  });

  it('tableStyle: false falls back to the classic single-case skeleton', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [{ head: { name: 'allow' } }],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string }>(server, 'rego_generate_test_skeleton', {
      source: 'package authz\nallow if true',
      tableStyle: false,
    });
    expect(env.ok).toBe(true);
    // Classic style: no `every` loop, no cases array.
    expect(env.data?.testFile).not.toContain('every tc in');
    expect(env.data?.testFile).not.toContain('_cases := [');
    // Classic stub form.
    expect(env.data?.testFile).toContain('test_allow if {');
    expect(env.data?.testFile).toContain('# Arrange');
  });

  it('tableStyle omitted produces classic skeleton (backward-compatible default)', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [{ head: { name: 'deny' } }],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string }>(server, 'rego_generate_test_skeleton', {
      source: 'package authz\ndeny if false',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.testFile).not.toContain('every tc in');
    expect(env.data?.testFile).toContain('# Arrange');
  });

  it('tableStyle: true generates one cases array and test per rule', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'rbac' }] },
      rules: [{ head: { name: 'allow' } }, { head: { name: 'deny' } }],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string; ruleNames: string[] }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package rbac\nallow if true\ndeny if false', tableStyle: true },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.ruleNames).toEqual(['allow', 'deny']);
    const file = env.data?.testFile ?? '';
    // Both rules get their own cases array.
    expect(file).toContain('allow_cases := [');
    expect(file).toContain('deny_cases := [');
    // Both rules get their own every-loop test.
    expect(file).toContain('test_allow if {');
    expect(file).toContain('every tc in allow_cases {');
    expect(file).toContain('test_deny if {');
    expect(file).toContain('every tc in deny_cases {');
    // Each test references its own cases variable (not the other's).
    expect(file.match(/every tc in allow_cases/g)).toHaveLength(1);
    expect(file.match(/every tc in deny_cases/g)).toHaveLength(1);
  });

  it('tableStyle: true with top-level package (no nested path) uses main_test package', async () => {
    const ast = {
      package: { path: [{ value: 'data', type: 'var' }] },
      rules: [{ head: { name: 'allow' } }],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string }>(server, 'rego_generate_test_skeleton', {
      source: 'allow if true',
      tableStyle: true,
    });
    expect(env.ok).toBe(true);
    const file = env.data?.testFile ?? '';
    // No nested package -> package main_test.
    expect(file).toContain('package main_test');
    // No import data.<empty>.
    expect(file).not.toContain('import data.');
    // Rule ref must not have a package prefix when packageName is empty.
    expect(file).toContain('data.allow with input as tc.input');
  });

  it('tableStyle: true sanitizes dotted rule names (from head.ref) in cases variable and test name', async () => {
    // head.ref form: allow.read -> safeName = allow_read
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'perms' }] },
      rules: [
        {
          head: {
            ref: [
              { value: 'allow', type: 'var' },
              { value: 'read', type: 'string' },
            ],
          },
        },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string; ruleNames: string[] }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package perms\nallow.read := true', tableStyle: true },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.ruleNames).toEqual(['allow.read']);
    const file = env.data?.testFile ?? '';
    // `.` in rule name -> `_` in the cases variable name.
    expect(file).toContain('allow_read_cases := [');
    expect(file).toContain('test_allow_read if {');
    expect(file).toContain('every tc in allow_read_cases {');
    // Rule ref uses the original dotted name (data.perms.allow.read).
    expect(file).toContain('data.perms.allow.read with input as tc.input');
  });

  it('tableStyle: true still deduplicates repeated rule names', async () => {
    // Same rule name appears twice in AST (common with incremental rules).
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'x' }] },
      rules: [
        { head: { name: 'allow' } },
        { head: { name: 'allow' } }, // duplicate
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string }>(server, 'rego_generate_test_skeleton', {
      source: 'package x\nallow := 1\nallow := 2',
      tableStyle: true,
    });
    expect(env.ok).toBe(true);
    // Deduplication: only one cases array and one test stub.
    expect(env.data?.testFile.match(/allow_cases := \[/g)).toHaveLength(1);
    expect(env.data?.testFile.match(/test_allow if/g)).toHaveLength(1);
  });

  it('tableStyle: true still returns INVALID_INPUT when no rules exist', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'empty' }] },
      rules: [],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_generate_test_skeleton', {
      source: 'package empty',
      tableStyle: true,
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
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

  it('skips rules with no resolvable name', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'mixed' }] },
      rules: [
        { head: {} }, // unnamed, skipped
        { head: { name: 'real_rule' } },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ rules: Array<{ name: string }> }>(server, 'rego_describe_policy', {
      source: 'package mixed',
    });
    expect(env.data?.rules.map((r) => r.name)).toEqual(['real_rule']);
  });

  it('handles undefined rule body when merging duplicates (defaults to 0)', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'd' }] },
      rules: [
        { head: { name: 'allow' }, body: [{ a: 1 }] },
        { head: { name: 'allow' } }, // no body field
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ rules: Array<{ bodyLength: number }> }>(
      server,
      'rego_describe_policy',
      { source: 'package d' },
    );
    expect(env.data?.rules[0]?.bodyLength).toBe(1);
  });

  it('returns UNKNOWN_ERROR when parse produces unparseable JSON', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('garbage'));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_describe_policy', { source: 'package x' });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
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
      diagnostics: [{ code: 'rego_unsafe_var_error', message: 'var x is unsafe' }],
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

  it('produces medium-confidence suggestion for rego_type_error', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      suggestions: Array<{ suggestion: string; confidence: string }>;
    }>(server, 'rego_suggest_fix', {
      diagnostics: [
        { code: 'rego_type_error', message: 'rego_type_error: cannot compare string and number' },
      ],
    });
    expect(env.data?.suggestions[0]?.confidence).toBe('medium');
    expect(env.data?.suggestions[0]?.suggestion).toMatch(/Type mismatch/);
    // Suggestion should strip the `rego_type_error:` prefix from the message.
    expect(env.data?.suggestions[0]?.suggestion).not.toContain('rego_type_error:');
  });

  it('produces high-confidence suggestion for rego_recursion_error', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      suggestions: Array<{ confidence: string; suggestion: string }>;
    }>(server, 'rego_suggest_fix', {
      diagnostics: [{ code: 'rego_recursion_error', message: 'recursion detected' }],
    });
    expect(env.data?.suggestions[0]?.confidence).toBe('high');
    expect(env.data?.suggestions[0]?.suggestion).toMatch(/cycle|recursion/i);
  });

  it('produces high-confidence suggestion for directory-package-mismatch (Regal)', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      suggestions: Array<{ confidence: string; suggestion: string }>;
    }>(server, 'rego_suggest_fix', {
      diagnostics: [
        {
          code: 'directory-package-mismatch',
          message: 'package does not match path',
        },
      ],
    });
    expect(env.data?.suggestions[0]?.confidence).toBe('high');
    expect(env.data?.suggestions[0]?.suggestion).toMatch(/package/);
  });

  it('produces low-confidence suggestion for rego_compile_error (catch-all)', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      suggestions: Array<{ confidence: string; suggestion: string }>;
    }>(server, 'rego_suggest_fix', {
      diagnostics: [{ code: 'rego_compile_error', message: 'unresolved import' }],
    });
    expect(env.data?.suggestions[0]?.confidence).toBe('low');
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
