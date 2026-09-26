/**
 * `rego_migrate_v1`: parse as v0, rewrite what the formatter refuses, format,
 * check, and compare the two versions on the inputs given. opa is mocked by
 * subcommand; tests/integration/migrate-v1.test.ts runs the real binary.
 */
import { readFileSync } from 'node:fs';
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

import { runBinary, type SpawnResult } from '../../../src/lib/subprocess.js';

import { registerAuthoringTools } from '../../../src/tools/authoring/index.js';
import type { RegoMigrateV1Output } from '../../../src/tools/authoring/migrate-v1.js';

const mockRun = vi.mocked(runBinary);

type Spawn = SpawnResult;
type Handler = Spawn | ((args: string[], stdin?: string) => Spawn);

/** Answer each opa subcommand with its own result; calls are recorded in mockRun. */
function opaAnswers(answers: Partial<Record<'parse' | 'fmt' | 'check' | 'eval', Handler>>): void {
  mockRun.mockImplementation((_bin, opts) => {
    const cmd = opts.args[0] as keyof typeof answers;
    const answer = answers[cmd];
    if (answer === undefined) throw new Error(`unexpected opa ${String(cmd)}`);
    return Promise.resolve(typeof answer === 'function' ? answer(opts.args, opts.stdin) : answer);
  });
}

const callsTo = (cmd: string): string[][] =>
  mockRun.mock.calls.map((c) => c[1].args).filter((a) => a[0] === cmd);

/** The file an inline-source command was given, read while the call is live. */
const inlineSource = (args: string[]): string => readFileSync(args[args.length - 1]!, 'utf8');

const v0Source = `package example\n\nallow {\n  input.user == "admin"\n}\n`;
const v1Source = `package example\n\nimport rego.v1\n\nallow if {\n  input.user == "admin"\n}\n`;
/** Enough of an AST for a module with nothing to rewrite. */
const plainAst = JSON.stringify({
  package: {
    path: [
      { type: 'var', value: 'data' },
      { type: 'string', value: 'example' },
    ],
  },
  rules: [],
});

const run = (input: Record<string, unknown>) => {
  const server = makeServer();
  registerAuthoringTools(server, baseConfig);
  return callTool<RegoMigrateV1Output>(server, 'rego_migrate_v1', input);
};

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rego_migrate_v1', () => {
  it('parses as v0, formats with --rego-v1 and checks the result', async () => {
    opaAnswers({
      parse: spawnSuccess(plainAst),
      fmt: spawnSuccess(v1Source),
      check: spawnSuccess(''),
    });
    const env = await run({ source: v0Source });

    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      original: v0Source,
      migrated: v1Source,
      changed: true,
      valid: true,
      errors: [],
      rewrites: [],
      notes: [],
    });
    expect(env.data?.equivalence).toBeUndefined();
    expect(callsTo('parse')[0]).toEqual(
      expect.arrayContaining(['--v0-compatible', '--json-include']),
    );
    expect(callsTo('fmt')[0]).toContain('--rego-v1');
    expect(callsTo('check')[0]).toContain('--v1-compatible');
  });

  it('formats the rewritten source, not the original', async () => {
    const source = readFileSync(fixturePath('migrate', 'legacy.rego'), 'utf8');
    const ast = readFileSync(fixturePath('migrate', 'legacy.ast.json'), 'utf8');
    let formatted = '';
    opaAnswers({
      parse: spawnSuccess(ast),
      fmt: (args) => {
        formatted = inlineSource(args);
        return spawnSuccess('package legacy.admission\n');
      },
      check: spawnSuccess(''),
    });
    const env = await run({ source });

    expect(env.ok).toBe(true);
    expect(formatted).toContain('contains_(arr, elem) {');
    expect(formatted).toContain('regex.match(`:latest$`, image)');
    expect(formatted).toMatch(/^all_true\(xs\) = r \{/m);
    expect(env.data?.rewrites).toContainEqual({ line: 8, from: 'contains', to: 'contains_' });
    expect(env.data?.notes.some((n) => n.includes('`contains_`'))).toBe(true);
  });

  it('returns a source that is already Rego v1 unchanged', async () => {
    opaAnswers({
      parse: (args) =>
        args.includes('--v0-compatible')
          ? spawnFailure(1, '', JSON.stringify({ errors: [{ message: 'unexpected if keyword' }] }))
          : spawnSuccess(plainAst),
      check: spawnSuccess(''),
    });
    const env = await run({ source: v1Source });

    expect(env.ok).toBe(true);
    expect(env.data?.migrated).toBe(v1Source);
    expect(env.data?.changed).toBe(false);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.notes[0]).toMatch(/already Rego v1/);
    expect(callsTo('fmt')).toHaveLength(0);
  });

  it("reports opa's own message and line for a source that parses as neither version", async () => {
    const errors = { errors: [{ message: 'unexpected eof token', location: { row: 3 } }] };
    opaAnswers({ parse: spawnFailure(1, JSON.stringify(errors)) });
    const env = await run({ source: 'package x\n\nallow {' });

    expect(env.error?.code).toBe('INVALID_REGO');
    expect(env.error?.message).toBe(
      'The source parses as neither Rego v0 nor Rego v1: unexpected eof token (line 3).',
    );
    expect(callsTo('fmt')).toHaveLength(0);
  });

  it('retries the parse without --v0-compatible on an OPA older than 1.0', async () => {
    opaAnswers({
      parse: (args) =>
        args.includes('--v0-compatible')
          ? spawnFailure(1, 'Error: unknown flag: --v0-compatible')
          : spawnSuccess(plainAst),
      fmt: spawnSuccess(v1Source),
      check: spawnSuccess(''),
    });
    const env = await run({ source: v0Source });

    expect(env.ok).toBe(true);
    expect(callsTo('parse')).toHaveLength(2);
    expect(callsTo('parse')[1]).not.toContain('--v0-compatible');
  });

  it('names the line and message of the first error the formatter reports, and counts the rest', async () => {
    const stderr =
      'failed to format Rego source file: 2 errors occurred:\n' +
      '/tmp/orygn-opa-mcp-x/input.rego:4: rego_parse_error: unexpected assign token\n' +
      '/tmp/orygn-opa-mcp-x/input.rego:9: rego_type_error: something else';
    opaAnswers({ parse: spawnSuccess(plainAst), fmt: spawnFailure(2, stderr) });
    const env = await run({ source: v0Source });

    expect(env.error?.code).toBe('INVALID_REGO');
    expect(env.error?.message).toBe(
      'opa fmt --rego-v1 could not convert line 4: unexpected assign token (and 1 more).',
    );
    expect(env.error?.message).not.toMatch(/could not parse/);
    const details = env.error?.details as { errors: Array<{ line: number; code: string }> };
    expect(details.errors.map((e) => [e.line, e.code])).toEqual([
      [4, 'rego_parse_error'],
      [9, 'rego_type_error'],
    ]);
    expect(JSON.stringify(env.error)).not.toContain('orygn-opa-mcp-');
    expect(callsTo('check')).toHaveLength(0);
  });

  it('quotes the line when the error is in the formatter output, which the original lacks', async () => {
    opaAnswers({
      parse: spawnSuccess(plainAst),
      fmt: (args) =>
        args.includes('--check-result=false')
          ? spawnSuccess('package example\n\nimport rego.v1\n\nimport input.in\n')
          : spawnFailure(
              2,
              'x.rego was successfully formatted, but the result is invalid: 1 error occurred: formatted:5: rego_parse_error: unexpected import path',
            ),
    });
    const env = await run({ source: v0Source });

    expect(env.error?.message).toBe(
      'opa fmt --rego-v1 could not convert line 5 of the formatted output (`import input.in`): unexpected import path.',
    );
    const details = env.error?.details as { errors: Array<{ in: string; text?: string }> };
    expect(details.errors[0]).toMatchObject({ in: 'formatted output', text: 'import input.in' });
  });

  it('says when an error falls in a helper appended to the module', async () => {
    const source = readFileSync(fixturePath('migrate', 'legacy.rego'), 'utf8');
    const ast = readFileSync(fixturePath('migrate', 'legacy.ast.json'), 'utf8');
    const helperLine = source.split('\n').length + 3;
    opaAnswers({
      parse: spawnSuccess(ast),
      fmt: spawnFailure(
        2,
        `failed to format Rego source file: 1 error occurred: <inline>:${helperLine}: rego_parse_error: something`,
      ),
    });
    const env = await run({ source });
    const details = env.error?.details as { errors: Array<{ in: string; line: number }> };
    expect(details.errors[0]).toMatchObject({ in: 'added helper', line: helperLine });
    expect(env.error?.message).toContain(`line ${helperLine} of the added helper`);
  });

  it('returns the migration with valid=false and the errors check found', async () => {
    const checkErrors = [
      { code: 'rego_compile_error', message: 'var x is unsafe', location: { row: 5, col: 3 } },
    ];
    opaAnswers({
      parse: spawnSuccess(plainAst),
      fmt: spawnSuccess(v1Source),
      check: spawnFailure(1, JSON.stringify({ errors: checkErrors })),
    });
    const env = await run({ source: v0Source });

    expect(env.ok).toBe(true);
    expect(env.data?.migrated).toBe(v1Source);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors[0]?.code).toBe('rego_compile_error');
  });

  it('returns empty errors when check exits non-zero with no JSON', async () => {
    opaAnswers({
      parse: spawnSuccess(plainAst),
      fmt: spawnSuccess(v1Source),
      check: spawnFailure(1, 'not json'),
    });
    const env = await run({ source: v0Source });
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors).toEqual([]);
  });

  it.each([
    ['parse', { parse: spawnUnreachable() }, 'OPA_BINARY_NOT_FOUND'],
    ['fmt', { parse: spawnSuccess(plainAst), fmt: spawnTimedOut() }, 'TIMEOUT'],
    [
      'check',
      { parse: spawnSuccess(plainAst), fmt: spawnSuccess(v1Source), check: spawnUnreachable() },
      'OPA_BINARY_NOT_FOUND',
    ],
  ] as const)('maps a %s subprocess failure to its code', async (_step, answers, code) => {
    opaAnswers(answers);
    const env = await run({ source: v0Source });
    expect(env.error?.code).toBe(code);
  });

  it('rejects more than 20 inputs before running anything', async () => {
    const env = await run({ source: v0Source, inputs: Array.from({ length: 21 }, () => ({})) });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe('rego_migrate_v1 with inputs', () => {
  const batch = (rows: Array<[Record<string, unknown>, Record<string, string>]>) =>
    spawnSuccess(JSON.stringify({ result: [{ bindings: { r: rows } }] }));

  it('evaluates the original as v0 and the result as v1, one process each', async () => {
    const rows: Array<[Record<string, unknown>, Record<string, string>]> = [
      [{ allow: true }, { allow: 'boolean' }],
      [{ allow: false }, { allow: 'boolean' }],
    ];
    opaAnswers({
      parse: spawnSuccess(plainAst),
      fmt: spawnSuccess(v1Source),
      check: spawnSuccess(''),
      eval: batch(rows),
    });
    const env = await run({ source: v0Source, inputs: [{ user: 'admin' }, { user: 'bob' }] });

    expect(env.data?.equivalence).toEqual({ compared: 2, identical: true, differences: [] });
    const evals = callsTo('eval');
    expect(evals).toHaveLength(2);
    expect(evals[0]).toContain('--v0-compatible');
    expect(evals[1]).not.toContain('--v0-compatible');
    for (const args of evals) expect(args.at(-1)).toContain('data["example"]');
    // The inputs travel on stdin as one array.
    expect(JSON.parse(mockRun.mock.calls.find((c) => c[1].args[0] === 'eval')![1].stdin!)).toEqual([
      { user: 'admin' },
      { user: 'bob' },
    ]);
  });

  it('reports a rule whose value or type differs, by input and rule', async () => {
    opaAnswers({
      parse: spawnSuccess(plainAst),
      fmt: spawnSuccess(v1Source),
      check: spawnSuccess(''),
      eval: (args) =>
        args.includes('--v0-compatible')
          ? batch([
              [
                { allow: true, deny: ['x'] },
                { allow: 'boolean', deny: 'set' },
              ],
            ])
          : batch([
              [
                { allow: true, deny: { x: true } },
                { allow: 'boolean', deny: 'object' },
              ],
            ]),
    });
    const env = await run({ source: v0Source, inputs: [{}] });

    expect(env.data?.equivalence?.identical).toBe(false);
    expect(env.data?.equivalence?.differences).toEqual([
      {
        input: 0,
        rule: 'deny',
        original: { value: ['x'], type: 'set' },
        migrated: { value: { x: true }, type: 'object' },
      },
    ]);
  });

  it('treats a rule named like an Object property as any other rule', async () => {
    opaAnswers({
      parse: spawnSuccess(plainAst),
      fmt: spawnSuccess(v1Source),
      check: spawnSuccess(''),
      eval: (args) =>
        args.includes('--v0-compatible')
          ? batch([[{ constructor: 1 }, { constructor: 'number' }]])
          : batch([[{}, {}]]),
    });
    const env = await run({ source: v0Source, inputs: [{}] });
    expect(env.data?.equivalence?.differences).toEqual([
      {
        input: 0,
        rule: 'constructor',
        original: { value: 1, type: 'number' },
        migrated: { undefined: true },
      },
    ]);
  });

  it('matches a renamed rule to its new name', async () => {
    const source = readFileSync(fixturePath('migrate', 'legacy.rego'), 'utf8');
    const ast = readFileSync(fixturePath('migrate', 'legacy.ast.json'), 'utf8');
    // `contains` is a function in the fixture; pretend it were a document to
    // see that the comparison follows the rename.
    opaAnswers({
      parse: spawnSuccess(ast),
      fmt: spawnSuccess('package legacy.admission\n'),
      check: spawnSuccess(''),
      eval: (args) =>
        args.includes('--v0-compatible')
          ? batch([[{ contains: [1] }, { contains: 'set' }]])
          : batch([[{ contains_: [1] }, { contains_: 'set' }]]),
    });
    const env = await run({ source, inputs: [{}] });
    expect(env.data?.equivalence).toEqual({ compared: 1, identical: true, differences: [] });
  });

  it('falls back to one process per input when the batch fails, and pins the error to its input', async () => {
    opaAnswers({
      parse: spawnSuccess(plainAst),
      fmt: spawnSuccess(v1Source),
      check: spawnSuccess(''),
      eval: (args, stdin) => {
        const v0 = args.includes('--v0-compatible');
        const query = args.at(-1)!;
        if (query.startsWith('r := ')) {
          // The batch: the migrated side raises for one of the inputs.
          return v0
            ? batch([
                [{ allow: true }, { allow: 'boolean' }],
                [{ allow: true }, { allow: 'boolean' }],
              ])
            : spawnFailure(2, '', JSON.stringify({ errors: [{ message: 'conflict' }] }));
        }
        const input = JSON.parse(stdin!) as { n: number };
        if (input.n === 1) {
          return spawnFailure(
            2,
            '',
            JSON.stringify({
              errors: [{ message: 'eval_conflict_error: /tmp/orygn-opa-mcp-a/input.rego:3' }],
            }),
          );
        }
        return spawnSuccess(
          JSON.stringify({
            result: [{ bindings: { d: { allow: true }, t: { allow: 'boolean' } } }],
          }),
        );
      },
    });
    const env = await run({ source: v0Source, inputs: [{ n: 0 }, { n: 1 }] });

    const eq = env.data?.equivalence;
    expect(eq?.identical).toBe(false);
    expect(eq?.differences).toHaveLength(1);
    expect(eq?.differences[0]?.input).toBe(1);
    expect(eq?.differences[0]?.rule).toBeUndefined();
    expect(eq?.differences[0]?.migrated).toEqual({
      error: expect.stringContaining('eval_conflict_error') as unknown,
    });
    expect(JSON.stringify(eq)).not.toContain('orygn-opa-mcp-');
  });

  it('does not compare when the migrated source fails its check', async () => {
    opaAnswers({
      parse: spawnSuccess(plainAst),
      fmt: spawnSuccess(v1Source),
      check: spawnFailure(1, JSON.stringify({ errors: [{ message: 'x' }] })),
    });
    const env = await run({ source: v0Source, inputs: [{}] });
    expect(env.data?.valid).toBe(false);
    expect(env.data?.equivalence).toBeUndefined();
    expect(callsTo('eval')).toHaveLength(0);
  });
});
