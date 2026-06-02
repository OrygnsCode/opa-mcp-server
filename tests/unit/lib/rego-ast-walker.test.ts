/**
 * Unit tests for rego-ast-walker.ts.
 *
 * The walker takes a parsed OPA JSON AST (OpaModule) and produces a
 * VerifyWalkResult. No OPA binary or Z3 required.
 */
import { describe, expect, it } from 'vitest';

import { walkModule } from '../../../src/lib/rego-ast-walker.js';
import type { OpaExpression, OpaModule, OpaRule } from '../../../src/lib/rego-ast-types.js';
import type { VerifyExpr } from '../../../src/lib/rego-ir.js';

// ─── AST construction helpers ────────────────────────────────────────────────

/** Make a minimal OpaModule wrapping one or more rules. */
function makeModule(rules: OpaRule[]): OpaModule {
  return {
    package: { path: [{ type: 'ref', value: [{ type: 'var', value: 'data' }] }] },
    rules,
  };
}

/** Make a boolean-head rule (allow { ... }). */
function boolRule(name: string, body: unknown[], isDefault = false): OpaRule {
  return {
    head: { name, value: { type: 'boolean', value: true } },
    body: body as OpaRule['body'],
    ...(isDefault ? { default: true } : {}),
  };
}

/** Cast a plain object to OpaExpression for use in body arrays. */
const asExpr = (obj: object): OpaExpression => obj as unknown as OpaExpression;

/** Make a single binary expression: operator(left, right). */
function binExpr(op: string, left: object, right: object): OpaExpression {
  return {
    index: 0,
    terms: [{ type: 'ref', value: [{ type: 'var', value: op }] }, left, right],
  } as unknown as OpaExpression;
}

/** Input ref: input.x.y */
function inputRef(...segments: string[]) {
  return {
    type: 'ref',
    value: [
      { type: 'var', value: 'input' },
      ...segments.map((s) => ({ type: 'string', value: s })),
    ],
  };
}

/** String literal term. */
const strLit = (v: string) => ({ type: 'string', value: v });
/** Number literal term. */
const numLit = (v: number) => ({ type: 'number', value: v });
/** Bool literal term. */
const boolLit = (v: boolean) => ({ type: 'boolean', value: v });
/** Var term. */
const varTerm = (name: string) => ({ type: 'var', value: name });
/** Local var ref (bare var). */
const _localRef = (name: string) => ({ type: 'ref', value: [{ type: 'var', value: name }] });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('walkModule - basic eq expression', () => {
  it('produces one clause with one eq expression for single body', () => {
    const mod = makeModule([
      boolRule('allow', [binExpr('equal', inputRef('user', 'role'), strLit('admin'))]),
    ]);
    const result = walkModule(mod);
    expect(result.rules.has('allow')).toBe(true);
    const clauses = result.rules.get('allow')!;
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.expressions).toHaveLength(1);
    const expr = clauses[0]!.expressions[0]! as Extract<VerifyExpr, { kind: 'eq' }>;
    expect(expr.kind).toBe('eq');
    expect(expr.left).toEqual({
      kind: 'input_ref',
      path: 'input.user.role',
      segments: ['user', 'role'],
    });
    expect(expr.right).toEqual({ kind: 'literal_string', value: 'admin' });
  });
});

describe('walkModule - multiple clauses (OR semantics)', () => {
  it('produces two clauses for two rule bodies with same name', () => {
    const mod = makeModule([
      boolRule('allow', [binExpr('equal', inputRef('role'), strLit('admin'))]),
      boolRule('allow', [binExpr('equal', inputRef('role'), strLit('editor'))]),
    ]);
    const result = walkModule(mod);
    const clauses = result.rules.get('allow')!;
    expect(clauses).toHaveLength(2);
    const roles = clauses.map((c) => {
      const expr = c.expressions[0] as Extract<VerifyExpr, { kind: 'eq' }>;
      return (expr.right as { kind: 'literal_string'; value: string }).value;
    });
    expect(roles).toContain('admin');
    expect(roles).toContain('editor');
  });
});

describe('walkModule - operator names', () => {
  const ops: Array<[string, string]> = [
    ['equal', 'eq'],
    ['eq', 'eq'],
    ['neq', 'neq'],
    ['gt', 'gt'],
    ['gte', 'gte'],
    ['lt', 'lt'],
    ['lte', 'lte'],
  ];
  for (const [opaOp, irKind] of ops) {
    it(`maps OPA operator "${opaOp}" to IR kind "${irKind}"`, () => {
      const mod = makeModule([boolRule('allow', [binExpr(opaOp, inputRef('count'), numLit(5))])]);
      const result = walkModule(mod);
      const expr = result.rules.get('allow')![0]!.expressions[0]!;
      expect(expr.kind).toBe(irKind);
    });
  }
});

describe('walkModule - assign operator', () => {
  it('maps := (assign) to assign IR kind', () => {
    const mod = makeModule([
      boolRule('allow', [
        // assign: x := input.role
        {
          index: 0,
          terms: [
            { type: 'ref', value: [{ type: 'var', value: 'assign' }] },
            varTerm('x'),
            inputRef('role'),
          ],
        },
      ]),
    ]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]!;
    expect(expr.kind).toBe('assign');
  });
});

describe('walkModule - string built-ins', () => {
  it('handles startswith', () => {
    const mod = makeModule([
      boolRule('allow', [
        {
          index: 0,
          terms: [
            { type: 'ref', value: [{ type: 'var', value: 'startswith' }] },
            inputRef('path'),
            strLit('/api/'),
          ],
        },
      ]),
    ]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]! as Extract<
      VerifyExpr,
      { kind: 'startswith' }
    >;
    expect(expr.kind).toBe('startswith');
    expect(expr.str).toEqual({ kind: 'input_ref', path: 'input.path', segments: ['path'] });
    expect(expr.prefix).toEqual({ kind: 'literal_string', value: '/api/' });
  });

  it('handles endswith', () => {
    const mod = makeModule([
      boolRule('allow', [
        {
          index: 0,
          terms: [
            { type: 'ref', value: [{ type: 'var', value: 'endswith' }] },
            inputRef('name'),
            strLit('.json'),
          ],
        },
      ]),
    ]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]! as Extract<
      VerifyExpr,
      { kind: 'endswith' }
    >;
    expect(expr.kind).toBe('endswith');
    expect(expr.suffix).toEqual({ kind: 'literal_string', value: '.json' });
  });

  it('handles contains', () => {
    const mod = makeModule([
      boolRule('allow', [
        {
          index: 0,
          terms: [
            { type: 'ref', value: [{ type: 'var', value: 'contains' }] },
            inputRef('text'),
            strLit('secret'),
          ],
        },
      ]),
    ]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]! as Extract<
      VerifyExpr,
      { kind: 'contains' }
    >;
    expect(expr.kind).toBe('contains');
    expect(expr.sub).toEqual({ kind: 'literal_string', value: 'secret' });
  });

  it('handles regex.match (compound ref) with a simple prefix pattern', () => {
    const mod = makeModule([
      boolRule('allow', [
        {
          index: 0,
          terms: [
            {
              type: 'ref',
              value: [
                { type: 'var', value: 'regex' },
                { type: 'string', value: 'match' },
              ],
            },
            strLit('^admin.*'),
            inputRef('user'),
          ],
        },
      ]),
    ]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]! as Extract<
      VerifyExpr,
      { kind: 'regex_match' }
    >;
    expect(expr.kind).toBe('regex_match');
    expect(expr.pattern).toEqual({ kind: 'literal_string', value: '^admin.*' });
    expect(expr.str).toEqual({ kind: 'input_ref', path: 'input.user', segments: ['user'] });
  });

  it('marks complex literal regex pattern as unsupported (complex_regex)', () => {
    const mod = makeModule([
      boolRule('allow', [
        {
          index: 0,
          terms: [
            {
              type: 'ref',
              value: [
                { type: 'var', value: 'regex' },
                { type: 'string', value: 'match' },
              ],
            },
            strLit('[a-z]+'),
            inputRef('username'),
          ],
        },
      ]),
    ]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]!;
    expect(expr.kind).toBe('unsupported');
    expect((expr as { kind: 'unsupported'; constructType: string }).constructType).toBe(
      'complex_regex',
    );
    expect(result.unsupported.some((u) => u.constructType === 'complex_regex')).toBe(true);
  });

  it('marks variable regex pattern as unsupported (variable_regex_pattern)', () => {
    const mod = makeModule([
      boolRule('allow', [
        {
          index: 0,
          terms: [
            {
              type: 'ref',
              value: [
                { type: 'var', value: 'regex' },
                { type: 'string', value: 'match' },
              ],
            },
            varTerm('pat'),
            inputRef('username'),
          ],
        },
      ]),
    ]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]!;
    expect(expr.kind).toBe('unsupported');
    expect((expr as { kind: 'unsupported'; constructType: string }).constructType).toBe(
      'variable_regex_pattern',
    );
    expect(result.unsupported.some((u) => u.constructType === 'variable_regex_pattern')).toBe(true);
  });
});

describe('walkModule - negation (NAF)', () => {
  it('marks negated expressions as unsupported', () => {
    const mod = makeModule([
      boolRule('allow', [
        {
          index: 0,
          negated: true,
          terms: inputRef('blocked'),
        },
      ]),
    ]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]!;
    expect(expr.kind).toBe('unsupported');
  });

  it('records NAF as an unsupported construct', () => {
    const mod = makeModule([
      boolRule('allow', [{ index: 0, negated: true, terms: inputRef('blocked') }]),
    ]);
    const result = walkModule(mod);
    expect(result.unsupported.length).toBeGreaterThan(0);
    expect(result.unsupported.some((u) => u.constructType === 'naf')).toBe(true);
  });
});

describe('walkModule - bool_check (bare input ref)', () => {
  it('produces bool_check for a bare input ref truthiness check', () => {
    const mod = makeModule([boolRule('allow', [{ index: 0, terms: inputRef('admin') }])]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]!;
    expect(expr.kind).toBe('bool_check');
  });
});

describe('walkModule - input path collection', () => {
  it('collects all input paths from all clauses', () => {
    const mod = makeModule([
      boolRule('allow', [
        binExpr('equal', inputRef('user', 'role'), strLit('admin')),
        binExpr('equal', inputRef('action'), strLit('read')),
      ]),
      boolRule('allow', [binExpr('equal', inputRef('user', 'dept'), strLit('eng'))]),
    ]);
    const result = walkModule(mod);
    expect(result.inputPaths.has('input.user.role')).toBe(true);
    expect(result.inputPaths.has('input.action')).toBe(true);
    expect(result.inputPaths.has('input.user.dept')).toBe(true);
  });
});

describe('walkModule - default rules', () => {
  it('records default rule value in defaults map', () => {
    const mod = makeModule([
      {
        head: { name: 'allow', value: { type: 'boolean', value: false } },
        body: [{ index: 0, terms: { type: 'boolean', value: true } }],
        default: true,
      },
    ]);
    const result = walkModule(mod);
    expect(result.defaults.get('allow')).toBe(false);
  });
});

describe('walkModule - rule inlining', () => {
  it('inlines single-clause helper rule referenced in another rule', () => {
    const mod = makeModule([
      // is_admin { input.user.role == "admin" }
      boolRule('is_admin', [binExpr('equal', inputRef('user', 'role'), strLit('admin'))]),
      // allow { is_admin }  -- bare var term, as OPA AST produces
      boolRule('allow', [{ index: 0, terms: varTerm('is_admin') }]),
    ]);
    const result = walkModule(mod);
    const allowClauses = result.rules.get('allow')!;
    expect(allowClauses).toHaveLength(1);
    // The is_admin reference should be inlined: allow clause gets the eq expression
    const expr = allowClauses[0]!.expressions[0]!;
    expect(expr.kind).toBe('eq');
    const eqExpr = expr as Extract<VerifyExpr, { kind: 'eq' }>;
    expect(eqExpr.left).toEqual({
      kind: 'input_ref',
      path: 'input.user.role',
      segments: ['user', 'role'],
    });
  });

  it('does not inline multi-clause helper (returns unsupported)', () => {
    const mod = makeModule([
      // multi_check has two clauses -- inlining would change OR semantics
      boolRule('multi_check', [binExpr('equal', inputRef('a'), strLit('x'))]),
      boolRule('multi_check', [binExpr('equal', inputRef('b'), strLit('y'))]),
      boolRule('allow', [{ index: 0, terms: varTerm('multi_check') }]),
    ]);
    const result = walkModule(mod);
    const allowClauses = result.rules.get('allow')!;
    const expr = allowClauses[0]!.expressions[0]!;
    // Multi-clause rules can't be safely inlined -- should be unsupported
    expect(expr.kind).toBe('unsupported');
  });

  it('inlines multi-expression helper rule (two body expressions)', () => {
    const mod = makeModule([
      // is_admin { input.user.role == "admin"; input.user.active == true }
      boolRule('is_admin', [
        binExpr('equal', inputRef('user', 'role'), strLit('admin')),
        binExpr('equal', inputRef('user', 'active'), boolLit(true)),
      ]),
      boolRule('allow', [{ index: 0, terms: varTerm('is_admin') }]),
    ]);
    const result = walkModule(mod);
    const allowClauses = result.rules.get('allow')!;
    expect(allowClauses).toHaveLength(1);
    // Both conditions from is_admin must appear in allow's clause
    const exprs = allowClauses[0]!.expressions;
    expect(exprs).toHaveLength(2);
    expect(exprs[0]!.kind).toBe('eq');
    expect(exprs[1]!.kind).toBe('eq');
    // First: input.user.role == "admin"
    const e0 = exprs[0] as Extract<VerifyExpr, { kind: 'eq' }>;
    expect(e0.left).toEqual({
      kind: 'input_ref',
      path: 'input.user.role',
      segments: ['user', 'role'],
    });
    expect(e0.right).toEqual({ kind: 'literal_string', value: 'admin' });
    // Second: input.user.active == true
    const e1 = exprs[1] as Extract<VerifyExpr, { kind: 'eq' }>;
    expect(e1.left).toEqual({
      kind: 'input_ref',
      path: 'input.user.active',
      segments: ['user', 'active'],
    });
    expect(e1.right).toEqual({ kind: 'literal_bool', value: true });
  });

  it('inlines multi-expression helper rule (three body expressions)', () => {
    const mod = makeModule([
      // is_eligible { input.age >= 18; input.age <= 65; input.active == true }
      boolRule('is_eligible', [
        binExpr('gte', inputRef('age'), numLit(18)),
        binExpr('lte', inputRef('age'), numLit(65)),
        binExpr('equal', inputRef('active'), boolLit(true)),
      ]),
      boolRule('allow', [{ index: 0, terms: varTerm('is_eligible') }]),
    ]);
    const result = walkModule(mod);
    const clause = result.rules.get('allow')![0]!;
    expect(clause.expressions).toHaveLength(3);
    expect(clause.expressions[0]!.kind).toBe('gte');
    expect(clause.expressions[1]!.kind).toBe('lte');
    expect(clause.expressions[2]!.kind).toBe('eq');
  });

  it('inlines multi-expression helper plus additional caller conditions', () => {
    const mod = makeModule([
      // is_admin { input.role == "admin"; input.active == true }
      boolRule('is_admin', [
        binExpr('equal', inputRef('role'), strLit('admin')),
        binExpr('equal', inputRef('active'), boolLit(true)),
      ]),
      // allow { is_admin; input.region == "us" }
      boolRule('allow', [
        { index: 0, terms: varTerm('is_admin') },
        binExpr('equal', inputRef('region'), strLit('us')),
      ]),
    ]);
    const result = walkModule(mod);
    const clause = result.rules.get('allow')![0]!;
    // is_admin expands to 2 exprs + allow adds 1 more = 3 total
    expect(clause.expressions).toHaveLength(3);
    const kinds = clause.expressions.map((e) => e.kind);
    expect(kinds).toEqual(['eq', 'eq', 'eq']);
  });

  it('inlines nested multi-expression helper transitively', () => {
    const mod = makeModule([
      // is_active { input.active == true; input.enabled == true }
      boolRule('is_active', [
        binExpr('equal', inputRef('active'), boolLit(true)),
        binExpr('equal', inputRef('enabled'), boolLit(true)),
      ]),
      // is_admin_active { is_active; input.role == "admin" }
      boolRule('is_admin_active', [
        { index: 0, terms: varTerm('is_active') },
        binExpr('equal', inputRef('role'), strLit('admin')),
      ]),
      // allow { is_admin_active }
      boolRule('allow', [{ index: 0, terms: varTerm('is_admin_active') }]),
    ]);
    const result = walkModule(mod);
    const clause = result.rules.get('allow')![0]!;
    // is_active (2) + is_admin_active's own role check (1) = 3 total in allow's clause
    expect(clause.expressions).toHaveLength(3);
    expect(clause.expressions.every((e) => e.kind !== 'unsupported')).toBe(true);
  });

  it('marks NAF inside multi-expression helper body as unsupported', () => {
    const mod = makeModule([
      // has_naf { not input.blocked; input.role == "admin" }
      boolRule('has_naf', [
        asExpr({ index: 0, negated: true, terms: inputRef('blocked') }),
        binExpr('equal', inputRef('role'), strLit('admin')),
      ]),
      boolRule('allow', [{ index: 0, terms: varTerm('has_naf') }]),
    ]);
    const result = walkModule(mod);
    const clause = result.rules.get('allow')![0]!;
    // NAF expr is unsupported, the eq expr is fine
    expect(clause.expressions).toHaveLength(2);
    expect(clause.expressions[0]!.kind).toBe('unsupported');
    expect(clause.expressions[1]!.kind).toBe('eq');
    expect(result.unsupported.some((u) => u.constructType === 'naf')).toBe(true);
  });

  it('inlines helper with string built-in as one of multiple body expressions', () => {
    const mod = makeModule([
      // is_api_admin { startswith(input.path, "/api/"); input.role == "admin" }
      boolRule('is_api_admin', [
        asExpr({
          index: 0,
          terms: [
            { type: 'ref', value: [{ type: 'var', value: 'startswith' }] },
            inputRef('path'),
            strLit('/api/'),
          ],
        }),
        binExpr('equal', inputRef('role'), strLit('admin')),
      ]),
      boolRule('allow', [{ index: 0, terms: varTerm('is_api_admin') }]),
    ]);
    const result = walkModule(mod);
    const clause = result.rules.get('allow')![0]!;
    expect(clause.expressions).toHaveLength(2);
    expect(clause.expressions[0]!.kind).toBe('startswith');
    expect(clause.expressions[1]!.kind).toBe('eq');
  });
});

describe('walkModule - clause index scoping', () => {
  it('assigns distinct clauseIndex to each clause', () => {
    const mod = makeModule([
      boolRule('allow', [binExpr('equal', inputRef('a'), strLit('x'))]),
      boolRule('allow', [binExpr('equal', inputRef('b'), strLit('y'))]),
      boolRule('allow', [binExpr('equal', inputRef('c'), strLit('z'))]),
    ]);
    const result = walkModule(mod);
    const clauses = result.rules.get('allow')!;
    const indices = clauses.map((c) => c.clauseIndex);
    // All indices should be distinct
    expect(new Set(indices).size).toBe(3);
  });
});

describe('walkModule - literal types', () => {
  it('produces literal_number for number comparand', () => {
    const mod = makeModule([boolRule('allow', [binExpr('gte', inputRef('age'), numLit(18))])]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]! as Extract<
      VerifyExpr,
      { kind: 'gte' }
    >;
    expect(expr.right).toEqual({ kind: 'literal_number', value: 18 });
  });

  it('produces literal_bool for boolean comparand', () => {
    const mod = makeModule([
      boolRule('allow', [binExpr('equal', inputRef('verified'), boolLit(true))]),
    ]);
    const result = walkModule(mod);
    const expr = result.rules.get('allow')![0]!.expressions[0]! as Extract<
      VerifyExpr,
      { kind: 'eq' }
    >;
    expect(expr.right).toEqual({ kind: 'literal_bool', value: true });
  });
});

describe('walkModule - multiple expressions in one clause (AND)', () => {
  it('all body expressions become conjuncts in the same clause', () => {
    const mod = makeModule([
      boolRule('allow', [
        binExpr('equal', inputRef('role'), strLit('admin')),
        binExpr('equal', inputRef('method'), strLit('GET')),
        binExpr('gte', inputRef('age'), numLit(21)),
      ]),
    ]);
    const result = walkModule(mod);
    const clause = result.rules.get('allow')![0]!;
    expect(clause.expressions).toHaveLength(3);
  });
});

describe('walkModule - string interpolation (internal.template_string)', () => {
  // OPA v1.12.0+ compiles $"Hello {expr}!" to internal.template_string()
  // calls in the AST. These must be classified as string_interpolation (not
  // the generic unknown_builtin) so callers can give a specific message.
  it('classifies internal.template_string as string_interpolation construct type', () => {
    const mod = makeModule([
      boolRule('allow', [
        asExpr({
          index: 0,
          terms: [
            // internal.template_string ref -- a compound ref like regex.match
            {
              type: 'ref',
              value: [
                { type: 'var', value: 'internal' },
                { type: 'string', value: 'template_string' },
              ],
            },
            strLit('Hello '),
            inputRef('name'),
            strLit('!'),
          ],
        }),
      ]),
    ]);
    const result = walkModule(mod);

    // Expression in the rule body must be 'unsupported' with constructType 'string_interpolation'
    const clause = result.rules.get('allow')![0]!;
    expect(clause.expressions).toHaveLength(1);
    const expr = clause.expressions[0]!;
    expect(expr.kind).toBe('unsupported');
    expect((expr as { kind: 'unsupported'; constructType: string }).constructType).toBe(
      'string_interpolation',
    );

    // The global unsupported list must record it as string_interpolation, NOT unknown_builtin
    const si = result.unsupported.find((u) => u.constructType === 'string_interpolation');
    expect(si).toBeDefined();
    expect(si!.description).toMatch(/string interpolation/i);
    expect(si!.description).toMatch(/internal\.template_string/);

    const generic = result.unsupported.find((u) => u.constructType === 'unknown_builtin');
    expect(generic).toBeUndefined();
  });

  it('does not confuse internal.template_string with other internal.* calls', () => {
    // A hypothetical other internal.* call should still be unknown_builtin
    const mod = makeModule([
      boolRule('allow', [
        asExpr({
          index: 0,
          terms: [
            {
              type: 'ref',
              value: [
                { type: 'var', value: 'internal' },
                { type: 'string', value: 'some_other_fn' },
              ],
            },
            strLit('arg'),
          ],
        }),
      ]),
    ]);
    const result = walkModule(mod);
    const clause = result.rules.get('allow')![0]!;
    const expr = clause.expressions[0]!;
    expect(expr.kind).toBe('unsupported');
    expect((expr as { kind: 'unsupported'; constructType: string }).constructType).toBe(
      'unknown_builtin',
    );
    expect(
      result.unsupported.find((u) => u.constructType === 'string_interpolation'),
    ).toBeUndefined();
  });
});
