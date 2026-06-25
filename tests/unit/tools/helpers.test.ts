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
    // New: uses `with input as` idiom, NOT the `input := {}` anti-pattern.
    expect(env.data?.testFile).toContain('with input as');
    expect(env.data?.testFile).not.toContain('input := {}');
    // Binds the rule result and asserts a concrete expected value, so a stub
    // never silently passes (e.g. for an empty partial-set rule, which is
    // always "defined" and would satisfy a bare reference).
    expect(env.data?.testFile).toContain('actual := data.rbac.allow with input as');
    expect(env.data?.testFile).toContain('actual == true');
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

  it('includes inferredInputShape in the response', async () => {
    const ast = {
      package: {
        path: [
          { value: 'data', type: 'var' },
          { value: 'rbac', type: 'string' },
        ],
      },
      rules: [{ head: { name: 'allow' } }],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ inferredInputShape: unknown }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package rbac\nallow if true' },
    );
    expect(env.ok).toBe(true);
    // AST has no body expressions -- no input.* refs, so shape must be exactly {}.
    expect(env.data?.inferredInputShape).toEqual({});
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

  // ─── skip test_* / todo_test_* rules ─────────────────────────────────

  it('skips existing test_* rules -- they should not get stubs', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [
        { head: { name: 'allow' } },
        { head: { name: 'test_allow' } }, // should be filtered out
        { head: { name: 'deny' } },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ ruleNames: string[]; testFile: string }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package authz' },
    );
    expect(env.ok).toBe(true);
    // test_allow must be absent from ruleNames -- it was an existing test rule.
    expect(env.data?.ruleNames).not.toContain('test_allow');
    expect(env.data?.ruleNames).toEqual(expect.arrayContaining(['allow', 'deny']));
    // The skeleton must not generate a test_test_allow double-prefixed stub.
    expect(env.data?.testFile).not.toContain('test_test_allow');
  });

  it('skips todo_test_* rules from generation', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [
        { head: { name: 'allow' } },
        { head: { name: 'todo_test_allow' } }, // should be filtered out
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ ruleNames: string[] }>(server, 'rego_generate_test_skeleton', {
      source: 'package authz',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.ruleNames).toEqual(['allow']);
    expect(env.data?.ruleNames).not.toContain('todo_test_allow');
  });

  it('returns INVALID_INPUT when all rules are test_* or todo_test_* (nothing testable)', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [{ head: { name: 'test_allow' } }, { head: { name: 'todo_test_deny' } }],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_generate_test_skeleton', {
      source: 'package authz',
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  // ─── input shape inference ────────────────────────────────────────────

  it('infers input shape from body expressions and uses it in the skeleton', async () => {
    // Simulate an AST where the rule body accesses input.role and input.action.
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [
        {
          head: { name: 'allow' },
          body: [
            {
              terms: [
                { type: 'ref', value: [{ type: 'var', value: 'equal' }] },
                {
                  type: 'ref',
                  value: [
                    { type: 'var', value: 'input' },
                    { type: 'string', value: 'role' },
                  ],
                },
                { type: 'string', value: 'admin' },
              ],
            },
            {
              terms: [
                { type: 'ref', value: [{ type: 'var', value: 'equal' }] },
                {
                  type: 'ref',
                  value: [
                    { type: 'var', value: 'input' },
                    { type: 'string', value: 'action' },
                  ],
                },
                { type: 'string', value: 'read' },
              ],
            },
          ],
        },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string; inferredInputShape: Record<string, unknown> }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package authz\nallow if {\n  input.role == "admin"\n  input.action == "read"\n}' },
    );
    expect(env.ok).toBe(true);
    // Inferred shape has both detected fields.
    expect(env.data?.inferredInputShape).toMatchObject({ role: null, action: null });
    // Skeleton uses the inferred shape in the `with input as` clause.
    expect(env.data?.testFile).toContain('"role": null');
    expect(env.data?.testFile).toContain('"action": null');
    expect(env.data?.testFile).toContain('with input as');
  });

  it('infers nested input shape (e.g. input.user.role)', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [
        {
          head: { name: 'allow' },
          body: [
            {
              terms: [
                { type: 'ref', value: [{ type: 'var', value: 'equal' }] },
                {
                  type: 'ref',
                  value: [
                    { type: 'var', value: 'input' },
                    { type: 'string', value: 'user' },
                    { type: 'string', value: 'role' },
                  ],
                },
                { type: 'string', value: 'admin' },
              ],
            },
          ],
        },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ inferredInputShape: Record<string, unknown> }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package authz' },
    );
    expect(env.ok).toBe(true);
    // Nested: { user: { role: null } }
    expect(env.data?.inferredInputShape).toMatchObject({ user: { role: null } });
  });

  it('falls back to empty shape ({}) when no input.* refs are detected', async () => {
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [{ head: { name: 'always_allow' } }],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ testFile: string; inferredInputShape: Record<string, unknown> }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package authz\nalways_allow := true' },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.inferredInputShape).toEqual({});
    // Skeleton uses `with input as {}` when shape is empty.
    expect(env.data?.testFile).toContain('with input as {}');
  });

  it('does not infer dynamic input refs (var-keyed or number-keyed)', async () => {
    // input[x] (var key) and input[0] (number key) should not be added to the shape.
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [
        {
          head: { name: 'allow' },
          body: [
            {
              terms: [
                {
                  // input[x] -- dynamic key, should be ignored
                  type: 'ref',
                  value: [
                    { type: 'var', value: 'input' },
                    { type: 'var', value: 'x' }, // var key, not string
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ inferredInputShape: Record<string, unknown> }>(
      server,
      'rego_generate_test_skeleton',
      { source: 'package authz' },
    );
    expect(env.ok).toBe(true);
    // Dynamic access adds nothing to the shape.
    expect(env.data?.inferredInputShape).toEqual({});
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
    // No input := {} anti-pattern anywhere.
    expect(file).not.toContain('input := {}');
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
    // Classic stub form uses `with input as` -- no `input := {}` anti-pattern.
    expect(env.data?.testFile).toContain('test_allow if {');
    expect(env.data?.testFile).toContain('with input as');
    expect(env.data?.testFile).not.toContain('input := {}');
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
    expect(env.data?.testFile).toContain('with input as');
    expect(env.data?.testFile).not.toContain('input := {}');
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
        clauseCount: number;
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
    expect(deny?.clauseCount).toBe(2); // deny has two clauses -- no longer collapsed silently
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

// ─── rego_explain_undefined ───────────────────────────────────────────────

// Helper: base64-encode a string for embedding in mock AST location.text fields.
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

// Minimal valid OPA AST for package data.authz with a single non-default rule.
function makeAst(opts: {
  pkgName: string;
  rules: Array<{
    name: string;
    row: number;
    isDefault?: boolean;
    defaultVal?: unknown;
    body?: Array<{ row: number; col?: number; text: string }>;
  }>;
}): object {
  return {
    package: {
      path: [{ value: 'data' }, { value: opts.pkgName }],
    },
    rules: opts.rules.map((r) => ({
      head: r.isDefault ? { name: r.name, value: { value: r.defaultVal } } : { name: r.name },
      ...(r.isDefault ? { default: true } : {}),
      body: (r.body ?? []).map((e) => ({
        location: { file: '<inline>', row: e.row, col: e.col ?? 3, text: b64(e.text) },
      })),
      location: { file: '<inline>', row: r.row, col: 1 },
    })),
  };
}

describe('rego_explain_undefined', () => {
  it('returns queryResult: defined immediately when OPA produces a value', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(
        JSON.stringify({ result: [{ expressions: [{ value: true, text: 'data.authz.allow' }] }] }),
      ),
    );
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ queryResult: string; value: unknown; rulesFound: number }>(
      server,
      'rego_explain_undefined',
      { query: 'data.authz.allow', source: 'package authz\nallow := true' },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.queryResult).toBe('defined');
    expect(env.data?.value).toBe(true);
    expect(env.data?.rulesFound).toBe(0);
    // Defined path must short-circuit: only one runBinary call.
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('returns queryResult: undefined with rulesFound: 0 when no source or paths provided', async () => {
    // Plain eval -> undefined; explain=full -> empty trace; no parse call.
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: [] })));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ queryResult: string; rulesFound: number; rules: unknown[] }>(
      server,
      'rego_explain_undefined',
      { query: 'data.authz.allow' },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.queryResult).toBe('undefined');
    expect(env.data?.rulesFound).toBe(0);
    expect(env.data?.rules).toEqual([]);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('returns EVAL_ERROR when the plain eval exits non-zero', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, '{"errors": [{"code": "rego_parse_error"}]}'));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: 'broken policy',
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('EVAL_ERROR');
  });

  it('returns OPA_BINARY_NOT_FOUND when opa is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });

  it('returns PATH_NOT_ALLOWED when paths fall outside allowedPaths', async () => {
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      paths: ['/etc/notallowed.rego'],
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    // Path validation happens before any subprocess call.
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('uses --explain=full on the second eval call', async () => {
    const ast = makeAst({ pkgName: 'authz', rules: [{ name: 'allow', row: 2, body: [] }] });
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: [] })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    await callTool(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: 'package authz\nallow := true',
    });
    // Call index 1 is the trace eval; verify --explain full is in its args.
    const traceArgs = mockRun.mock.calls[1]![1].args;
    const explainIdx = traceArgs.indexOf('--explain');
    expect(explainIdx).toBeGreaterThan(-1);
    expect(traceArgs[explainIdx + 1]).toBe('full');
  });

  it('trace-based: identifies blocking condition from Enter + Fail trace events', async () => {
    const ast = makeAst({
      pkgName: 'authz',
      rules: [
        {
          name: 'allow',
          row: 3,
          body: [{ row: 4, text: 'input.role == "admin"' }],
        },
      ],
    });
    const trace = [
      {
        Op: 'Enter',
        Node: { head: { name: 'allow' }, location: { file: '<inline>', row: 3, col: 1 } },
        Location: { file: '<inline>', row: 3, col: 1 },
      },
      { Op: 'Fail', Location: { file: '<inline>', row: 4, col: 3 } },
    ];
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      queryResult: string;
      rulesFound: number;
      rules: Array<{
        isDefault: boolean;
        source: string;
        conditions: Array<{ text: string; result: string; row: number }>;
        blockingCondition: { text: string; result: string; row: number; index: number } | null;
      }>;
    }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: 'package authz\nimport rego.v1\nallow if {\n  input.role == "admin"\n}',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.queryResult).toBe('undefined');
    expect(env.data?.rulesFound).toBe(1);
    expect(env.data?.rules).toHaveLength(1);
    const rule = env.data!.rules[0]!;
    expect(rule.source).toBe('trace');
    expect(rule.isDefault).toBe(false);
    expect(rule.blockingCondition).not.toBeNull();
    expect(rule.blockingCondition!.text).toBe('input.role == "admin"');
    expect(rule.blockingCondition!.result).toBe('false');
    expect(rule.blockingCondition!.row).toBe(4);
    expect(rule.blockingCondition!.index).toBe(0);
  });

  it('trace-based: Enter event present but no Fail at a body row -- blockingCondition is null', async () => {
    const ast = makeAst({
      pkgName: 'authz',
      rules: [
        {
          name: 'allow',
          row: 2,
          body: [{ row: 3, text: 'input.x == 1' }],
        },
      ],
    });
    // Trace has Enter but no Fail at row 3.
    const trace = [
      {
        Op: 'Enter',
        Node: { head: { name: 'allow' }, location: { file: '<inline>', row: 2, col: 1 } },
        Location: { file: '<inline>', row: 2, col: 1 },
      },
    ];
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ rules: Array<{ source: string; blockingCondition: unknown }> }>(
      server,
      'rego_explain_undefined',
      { query: 'data.authz.allow', source: 'package authz\nallow if input.x == 1' },
    );
    expect(env.ok).toBe(true);
    const rule = env.data!.rules[0]!;
    expect(rule.source).toBe('trace');
    expect(rule.blockingCondition).toBeNull();
  });

  it('standalone-eval: evaluates each condition when rule is not in trace (indexed out)', async () => {
    const ast = makeAst({
      pkgName: 'authz',
      rules: [
        {
          name: 'allow',
          row: 3,
          body: [
            { row: 4, text: 'input.role == "admin"' },
            { row: 5, text: 'input.action == "read"' },
          ],
        },
      ],
    });
    // Trace has Index event only -- rule was indexed out; no Enter for 'allow'.
    const trace = [{ Op: 'Index', Message: '(matched 0 rules)' }];
    // call 0: plain eval -> undefined
    // call 1: explain=full -> no enter for allow
    // call 2: parse -> AST
    // call 3: standalone eval cond 0 -> true
    // call 4: standalone eval cond 1 -> false (undefined result)
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)))
      .mockResolvedValueOnce(
        spawnSuccess(JSON.stringify({ result: [{ expressions: [{ value: true }] }] })),
      )
      .mockResolvedValueOnce(spawnSuccess('{}'));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      rules: Array<{
        source: string;
        conditions: Array<{ text: string; result: string; index: number }>;
        blockingCondition: { text: string; result: string; index: number } | null;
      }>;
    }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source:
        'package authz\nimport rego.v1\nallow if {\n  input.role == "admin"\n  input.action == "read"\n}',
    });
    expect(env.ok).toBe(true);
    const rule = env.data!.rules[0]!;
    expect(rule.source).toBe('standalone-eval');
    expect(rule.conditions[0]?.result).toBe('true');
    expect(rule.conditions[0]?.text).toBe('input.role == "admin"');
    expect(rule.conditions[1]?.result).toBe('false');
    expect(rule.conditions[1]?.text).toBe('input.action == "read"');
    expect(rule.blockingCondition).not.toBeNull();
    expect(rule.blockingCondition!.text).toBe('input.action == "read"');
    expect(rule.blockingCondition!.index).toBe(1);
  });

  it('standalone-eval: marks a present-but-false comparison as false and names it the blocker', async () => {
    // Regression guard. OPA returns a result ROW for `input.user.tier ==
    // "premium"` even when tier is "free" -- the row's expression value is
    // `false`, not an empty result. A row-count check marks it satisfied and
    // misses the real blocker; the value must be inspected. This mirrors the
    // exact ABAC shape a user hits when a later guard is the one that fails.
    const ast = makeAst({
      pkgName: 'authz',
      rules: [
        {
          name: 'allow',
          row: 3,
          body: [
            { row: 4, text: 'input.method == "GET"' },
            { row: 5, text: 'input.path == "/public"' },
            { row: 6, text: 'input.user.tier == "premium"' },
          ],
        },
      ],
    });
    const trace = [{ Op: 'Index', Message: '(matched 0 rules)' }];
    // Realistic OPA stdout: a false comparison yields a row whose expression
    // value is false (the unrealistic `{}` mock is what hid this bug before).
    const row = (value: unknown): string =>
      JSON.stringify({ result: [{ expressions: [{ value }] }] });
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}')) // plain eval -> undefined
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace }))) // indexed out
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast))) // parse
      .mockResolvedValueOnce(spawnSuccess(row(true))) // cond 0: method == GET -> true
      .mockResolvedValueOnce(spawnSuccess(row(true))) // cond 1: path == /public -> true
      .mockResolvedValueOnce(spawnSuccess(row(false))); // cond 2: tier == premium -> false
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      rules: Array<{
        source: string;
        conditions: Array<{ text: string; result: string; index: number }>;
        blockingCondition: { text: string; result: string; index: number } | null;
      }>;
    }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source:
        'package authz\nimport rego.v1\nallow if {\n  input.method == "GET"\n  input.path == "/public"\n  input.user.tier == "premium"\n}',
    });
    expect(env.ok).toBe(true);
    const rule = env.data!.rules[0]!;
    expect(rule.source).toBe('standalone-eval');
    expect(rule.conditions[0]?.result).toBe('true');
    expect(rule.conditions[1]?.result).toBe('true');
    expect(rule.conditions[2]?.result).toBe('false');
    expect(rule.blockingCondition).not.toBeNull();
    expect(rule.blockingCondition!.text).toBe('input.user.tier == "premium"');
    expect(rule.blockingCondition!.index).toBe(2);
  });

  it('standalone-eval: a truthy non-boolean condition value counts as satisfied', async () => {
    // A body condition need not be a boolean comparison -- e.g. a bare
    // reference `input.tags` resolves to an array. The check must be "defined
    // and not false", not "=== true", or legitimate non-boolean guards would
    // be wrongly reported as the blocker.
    const ast = makeAst({
      pkgName: 'authz',
      rules: [
        {
          name: 'allow',
          row: 3,
          body: [
            { row: 4, text: 'input.tags' },
            { row: 5, text: 'input.role == "admin"' },
          ],
        },
      ],
    });
    const trace = [{ Op: 'Index', Message: '(matched 0 rules)' }];
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)))
      // cond 0: input.tags resolves to a non-empty array -> truthy, satisfied
      .mockResolvedValueOnce(
        spawnSuccess(JSON.stringify({ result: [{ expressions: [{ value: ['urgent'] }] }] })),
      )
      // cond 1: role == admin -> false value
      .mockResolvedValueOnce(
        spawnSuccess(JSON.stringify({ result: [{ expressions: [{ value: false }] }] })),
      );
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      rules: Array<{
        conditions: Array<{ result: string; index: number }>;
        blockingCondition: { index: number } | null;
      }>;
    }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: 'package authz',
    });
    expect(env.ok).toBe(true);
    const rule = env.data!.rules[0]!;
    expect(rule.conditions[0]?.result).toBe('true');
    expect(rule.conditions[1]?.result).toBe('false');
    expect(rule.blockingCondition?.index).toBe(1);
  });

  it('standalone-eval: marks condition as unevaluable when standalone eval exits non-zero', async () => {
    const ast = makeAst({
      pkgName: 'authz',
      rules: [
        {
          name: 'allow',
          row: 2,
          body: [{ row: 3, text: 'x == 1' }], // x is unsafe standalone
        },
      ],
    });
    const trace = [{ Op: 'Index', Message: '(matched 0 rules)' }];
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)))
      .mockResolvedValueOnce(spawnFailure(1, 'var x is unsafe')); // standalone eval fails
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      rules: Array<{ conditions: Array<{ result: string; note?: string }> }>;
    }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: 'package authz',
    });
    expect(env.ok).toBe(true);
    const cond = env.data!.rules[0]!.conditions[0]!;
    expect(cond.result).toBe('unevaluable');
    expect(cond.note).toMatch(/Standalone eval failed/);
  });

  it('extracts defaultValue from a default rule', async () => {
    const ast = makeAst({
      pkgName: 'authz',
      rules: [
        { name: 'allow', row: 2, isDefault: true, defaultVal: false, body: [] },
        {
          name: 'allow',
          row: 4,
          body: [{ row: 5, text: 'input.role == "admin"' }],
        },
      ],
    });
    const trace = [
      {
        Op: 'Enter',
        Node: { head: { name: 'allow' }, location: { file: '<inline>', row: 4, col: 1 } },
        Location: { file: '<inline>', row: 4, col: 1 },
      },
      { Op: 'Fail', Location: { file: '<inline>', row: 5, col: 3 } },
    ];
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      queryResult: string;
      rulesFound: number;
      defaultValue: unknown;
      rules: Array<{ isDefault: boolean }>;
    }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source:
        'package authz\nimport rego.v1\ndefault allow := false\nallow if input.role == "admin"',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.queryResult).toBe('undefined');
    // The default rule provides a value but doesn't prevent queryResult from being 'undefined'
    // (the query evaluates to the default, meaning the non-default rules all failed).
    expect(env.data?.defaultValue).toBe(false);
    expect(env.data?.rulesFound).toBe(1); // only non-default rules counted
    // Default rule entry is in the rules array but marked isDefault: true.
    expect(env.data?.rules.some((r) => r.isDefault)).toBe(true);
  });

  it('analyses multiple rule definitions and populates each independently', async () => {
    // Two incremental definitions of allow.
    const ast = makeAst({
      pkgName: 'authz',
      rules: [
        {
          name: 'allow',
          row: 2,
          body: [{ row: 3, text: 'input.role == "admin"' }],
        },
        {
          name: 'allow',
          row: 5,
          body: [{ row: 6, text: 'input.role == "superuser"' }],
        },
      ],
    });
    // Both rules indexed out.
    const trace = [{ Op: 'Index', Message: '(matched 0 rules)' }];
    // Calls: plain eval, explain=full, parse, standalone rule0 cond0, standalone rule1 cond0
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)))
      .mockResolvedValueOnce(spawnSuccess('{}')) // rule0 cond0: false
      .mockResolvedValueOnce(spawnSuccess('{}')); // rule1 cond0: false
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      rulesFound: number;
      rules: Array<{
        ruleIndex: number;
        source: string;
        blockingCondition: { text: string } | null;
      }>;
    }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: 'package authz\nallow if input.role == "admin"\nallow if input.role == "superuser"',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.rulesFound).toBe(2);
    expect(env.data?.rules).toHaveLength(2);
    expect(env.data?.rules[0]?.ruleIndex).toBe(0);
    expect(env.data?.rules[1]?.ruleIndex).toBe(1);
    expect(env.data?.rules[0]?.blockingCondition?.text).toBe('input.role == "admin"');
    expect(env.data?.rules[1]?.blockingCondition?.text).toBe('input.role == "superuser"');
  });

  it('skips conditions with no location text (marks unevaluable with a note)', async () => {
    // AST body expression has no 'text' field in its location.
    const ast = {
      package: { path: [{ value: 'data' }, { value: 'authz' }] },
      rules: [
        {
          head: { name: 'allow' },
          body: [{ location: { file: '<inline>', row: 3, col: 3 } }], // no 'text' field
          location: { file: '<inline>', row: 2, col: 1 },
        },
      ],
    };
    const trace = [{ Op: 'Index', Message: '(matched 0 rules)' }];
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    // No standalone eval call -- condition has no text so it is skipped.
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      rules: Array<{ conditions: Array<{ result: string; text: string; note?: string }> }>;
    }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: 'package authz',
    });
    expect(env.ok).toBe(true);
    const cond = env.data!.rules[0]!.conditions[0]!;
    expect(cond.text).toBe('<expression>');
    expect(cond.result).toBe('unevaluable');
    expect(cond.note).toMatch(/No location text/);
    // No standalone eval was invoked.
    expect(mockRun).toHaveBeenCalledTimes(3);
  });

  it('summary string mentions the query and number of rules', async () => {
    const ast = makeAst({
      pkgName: 'authz',
      rules: [{ name: 'allow', row: 2, body: [] }],
    });
    const trace = [{ Op: 'Index', Message: '(matched 0 rules)' }];
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(ast)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ summary: string }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: 'package authz\nallow := true',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.summary).toContain('data.authz.allow');
    expect(env.data?.summary).toContain('undefined');
  });

  it('summary includes defined value when queryResult is defined', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(JSON.stringify({ result: [{ expressions: [{ value: false }] }] })),
    );
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{ summary: string; value: unknown }>(
      server,
      'rego_explain_undefined',
      { query: 'data.authz.allow', source: 'package authz\ndefault allow := false' },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.summary).toContain('defined');
    expect(env.data?.value).toBe(false);
  });

  it('sanitizes temp-file paths in rule locations', async () => {
    const ast = makeAst({
      pkgName: 'authz',
      rules: [{ name: 'allow', row: 2, body: [] }],
    });
    // Override the location file to simulate a real OPA temp-file path.
    const astWithTempPath = JSON.parse(JSON.stringify(ast)) as {
      rules: Array<{ location: { file: string } }>;
    };
    astWithTempPath.rules[0]!.location.file = '/tmp/orygn-opa-mcp-abc123/input.rego';
    const trace = [{ Op: 'Index', Message: '(matched 0 rules)' }];
    mockRun
      .mockResolvedValueOnce(spawnSuccess('{}'))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify({ explanation: trace })))
      .mockResolvedValueOnce(spawnSuccess(JSON.stringify(astWithTempPath)));
    const server = makeServer();
    registerHelperTools(server, baseConfig);
    const env = await callTool<{
      rules: Array<{ location: { file: string } }>;
    }>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: 'package authz\nallow := true',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.rules[0]?.location.file).toBe('<inline>');
  });
});
