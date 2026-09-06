/**
 * Soundness tests for rego_verify, checked against the real OPA binary.
 *
 * The engine shipped unsound: it returned `proven` and `unsatisfiable` for
 * claims that were false, on ordinary policy shapes, with an empty
 * `unsupportedConstructs` list so nothing warned. Roughly a third of generated
 * policies produced a wrong verdict.
 *
 * Every earlier test asserted the engine against ITSELF: given this IR, does the
 * encoder produce that formula. None of them ever asked OPA what the policy
 * actually does, which is why the bug survived. These tests fix that: for each
 * policy the expected answer is derived by EVALUATING it with OPA over a probe
 * domain, and the verdict is checked against that.
 *
 * The contract under test:
 *   - `proven` on always_true  => the rule is true on every probe input
 *   - `proven` on never_true   => the rule is true on no probe input
 *   - `unsatisfiable`          => the rule is true on no probe input
 *   - a counterexample         => that exact input really does behave as claimed
 *   - `inconclusive`           => always acceptable; refusing to answer is not a
 *                                 soundness failure, only a coverage one
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runVerify } from '../../src/lib/rego-verify-engine.js';
import type { VerifyProperty } from '../../src/lib/rego-property-parser.js';

const OPA = process.env['OPA_BINARY'] ?? 'opa';
const workDir = mkdtempSync(join(tmpdir(), 'orygn-verify-soundness-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/**
 * Probe inputs. Deliberately includes the empty object and explicit nulls: a
 * missing field makes a body undefined, and that is exactly the case the engine
 * used to model as "always present", which is what let vacuous predicates prove
 * always_true.
 */
const DOMAIN: Array<Record<string, unknown>> = [
  {},
  { x: 'a' },
  { x: 'b' },
  { x: '' },
  { x: null },
  { n: 0 },
  { n: 1 },
  { n: 5 },
  { n: -1 },
  { n: 0.5 },
  { n: 2.5 },
  { n: null },
  { f: true },
  { f: false },
  { q: 1 },
  { q: 2 },
  { role: 'admin' },
  { role: 'user' },
  { s: 'prefix-y' },
  { s: 'mid' },
  { x: 'a', n: 1 },
  { x: 'b', n: 5 },
];

function evalRule(src: string, rule: string, input: unknown): unknown {
  const file = join(workDir, 'p.rego');
  writeFileSync(file, src, 'utf8');
  // Run from the module's directory and name it relatively. OPA's loader
  // resolves an absolute path against the drive the child is on, which fails
  // when the temp directory is on a different drive from the tests.
  const r = spawnSync(OPA, ['eval', '-d', 'p.rego', '-I', '--format', 'json', `data.t.${rule}`], {
    cwd: workDir,
    input: JSON.stringify(input),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) return undefined;
  try {
    const exprs = (
      JSON.parse(r.stdout) as { result?: Array<{ expressions?: Array<{ value: unknown }> }> }
    ).result?.[0]?.expressions;
    return exprs && exprs.length > 0 ? exprs[0]!.value : undefined;
  } catch {
    return undefined;
  }
}

function parse(src: string): unknown {
  const file = join(workDir, 'q.rego');
  writeFileSync(file, src, 'utf8');
  const r = spawnSync(OPA, ['parse', 'q.rego', '--format', 'json'], {
    cwd: workDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`opa parse failed: ${r.stderr.slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

/** Inputs from the probe domain on which OPA says the rule is exactly `true`. */
function trueOn(src: string, rule: string): Array<Record<string, unknown>> {
  return DOMAIN.filter((i) => evalRule(src, rule, i) === true);
}

/**
 * Assert one verdict is consistent with what OPA actually does.
 * Returns nothing; failures are reported with the policy inline so a CI failure
 * is diagnosable without rerunning anything by hand.
 */
async function assertSound(name: string, src: string, rule: string, kind: VerifyProperty['kind']) {
  const ast = parse(src);
  const hits = trueOn(src, rule);
  const anyTrue = hits.length > 0;
  const allTrue = hits.length === DOMAIN.length;

  const res = await runVerify(ast as never, { kind, ruleName: rule });
  const v = res.verdict;

  if (v === 'inconclusive') return; // honest refusal, never a soundness failure

  if (kind === 'always_true' && v === 'proven') {
    expect(allTrue, `${name}: PROVEN always_true but OPA says false on some input\n${src}`).toBe(
      true,
    );
  }
  if (kind === 'never_true' && v === 'proven') {
    expect(
      anyTrue,
      `${name}: PROVEN never_true but OPA says true on ${JSON.stringify(hits[0])}\n${src}`,
    ).toBe(false);
  }
  if (kind === 'satisfiable' && v === 'unsatisfiable') {
    expect(
      anyTrue,
      `${name}: UNSATISFIABLE but OPA says true on ${JSON.stringify(hits[0])}\n${src}`,
    ).toBe(false);
  }
  if (v === 'counterexample' && res.counterexample) {
    const actual = evalRule(src, rule, res.counterexample);
    const ce = JSON.stringify(res.counterexample);
    if (kind === 'always_true') {
      expect(actual, `${name}: counterexample ${ce} does not falsify the rule\n${src}`).not.toBe(
        true,
      );
    }
    if (kind === 'never_true') {
      expect(actual, `${name}: counterexample ${ce} does not satisfy the rule\n${src}`).toBe(true);
    }
  }
}

/** Each entry is a shape that produced a WRONG verdict before the fix. */
const CASES: Array<{ name: string; src: string; rule?: string }> = [
  {
    name: 'non-ASCII string literal',
    src: 'package t\n\nallow if {\n\tinput.s == "héllo €"\n}\n',
  },
  {
    name: 'default true with contradictory clause',
    src: 'package t\n\ndefault allow := true\n\nallow if {\n\tinput.x == "a"\n\tinput.x == "b"\n}\n',
  },
  {
    name: 'default true with a guard clause',
    src: 'package t\n\ndefault allow := true\n\nallow if {\n\tinput.role == "admin"\n}\n',
  },
  {
    name: 'default false with a guard clause',
    src: 'package t\n\ndefault allow := false\n\nallow if {\n\tinput.role == "admin"\n}\n',
  },
  { name: 'default true only', src: 'package t\n\ndefault allow := true\n' },
  { name: 'default false only', src: 'package t\n\ndefault allow := false\n' },
  { name: 'head value false', src: 'package t\n\nallow := false if {\n\ttrue\n}\n' },
  {
    name: 'head value is a string',
    src: 'package t\n\nallow := "deny" if {\n\tinput.role == "admin"\n}\n',
  },
  { name: 'literal false in the body', src: 'package t\n\nallow if {\n\tfalse\n}\n' },
  { name: 'literal true in the body', src: 'package t\n\nallow if {\n\ttrue\n}\n' },
  {
    name: 'two clauses, OR',
    src: 'package t\n\nallow if {\n\tinput.x == "a"\n}\n\nallow if {\n\tinput.x == "b"\n}\n',
  },
  {
    name: 'two clauses with mixed head values',
    src: 'package t\n\nallow if {\n\tinput.x == "a"\n}\n\nallow := false if {\n\tinput.n == 5\n}\n',
  },
  { name: 'comparison against null', src: 'package t\n\nallow if {\n\tinput.x == null\n}\n' },
  {
    name: 'fractional range between two integers',
    src: 'package t\n\nallow if {\n\tinput.n > 0\n\tinput.n < 1\n}\n',
  },
  { name: 'fractional equality', src: 'package t\n\nallow if {\n\tinput.n == 0.5\n}\n' },
  {
    name: 'helper with a true default and a contradictory body',
    src: 'package t\n\nallow if {\n\thelper\n}\n\ndefault helper := true\n\nhelper if {\n\tinput.q == 1\n\tinput.q == 2\n}\n',
  },
  {
    name: 'helper with a false default',
    src: 'package t\n\nallow if {\n\thelper\n}\n\ndefault helper := false\n\nhelper if {\n\tinput.q == 1\n}\n',
  },
  {
    name: 'helper whose head is false and default is true',
    src: 'package t\n\nallow if {\n\thelper\n}\n\ndefault helper := true\n\nhelper := false if {\n\tinput.q == 1\n}\n',
  },
  {
    // Found by the generative fuzzer, not by reading: the head value was only
    // consulted when the helper also had a default, so a helper that can only
    // ever be false was inlined as though it were its own guard.
    name: 'helper whose head is false with NO default',
    src: 'package t\n\nallow if {\n\thelper\n}\n\nhelper := false if {\n\tinput.x == "a"\n}\n',
  },
  {
    name: 'helper whose head is a string with no default',
    src: 'package t\n\nallow if {\n\thelper\n}\n\nhelper := "yes" if {\n\tinput.x == "a"\n}\n',
  },
  {
    name: 'helper and caller reuse the same local name',
    src: 'package t\n\nallow if {\n\tx := input.x\n\tx == "a"\n\thelper\n}\n\nhelper if {\n\ty := input.role\n\ty == "admin"\n}\n',
  },
  // A boolean literal in a helper body was filtered out whatever it said, so a
  // helper that can never fire inlined as one that always does; and a negated
  // literal was read as the bare one, so `not false` counted as `false`.
  {
    name: 'helper with a literal false body',
    src: 'package t\n\nallow if {\n\thelper\n}\n\nhelper if {\n\tfalse\n}\n',
  },
  {
    name: 'helper with a comparison and then a literal false',
    src: 'package t\n\nallow if {\n\thelper\n}\n\nhelper if {\n\tinput.x == "a"\n\tfalse\n}\n',
  },
  {
    name: 'helper whose head is false, default is true and body is a literal false',
    src: 'package t\n\nallow if {\n\thelper\n}\n\ndefault helper := true\n\nhelper := false if {\n\tfalse\n}\n',
  },
  {
    name: 'helper whose body is not false',
    src: 'package t\n\nallow if {\n\thelper\n}\n\nhelper if {\n\tnot false\n}\n',
  },
  {
    name: 'helper whose body is not true',
    src: 'package t\n\nallow if {\n\thelper\n}\n\nhelper if {\n\tnot true\n}\n',
  },
  {
    name: 'helper with not false before a comparison',
    src: 'package t\n\nallow if {\n\thelper\n}\n\nhelper if {\n\tnot false\n\tinput.x == "a"\n}\n',
  },
  {
    name: 'helper whose head is false, default is true and body is not false',
    src: 'package t\n\nallow if {\n\thelper\n}\n\ndefault helper := true\n\nhelper := false if {\n\tnot false\n}\n',
  },
  { name: 'rule body not false', src: 'package t\n\nallow if {\n\tnot false\n}\n' },
  { name: 'rule body not true', src: 'package t\n\nallow if {\n\tnot true\n}\n' },
  {
    name: 'rule body not false before a comparison',
    src: 'package t\n\nallow if {\n\tnot false\n\tinput.x == "a"\n}\n',
  },
  {
    name: 'partial set rule',
    src: 'package t\n\ndeny contains "no" if {\n\tinput.n == 1\n}\n',
    rule: 'deny',
  },
  { name: 'numeric greater-than', src: 'package t\n\nallow if {\n\tinput.n > 5\n}\n' },
  {
    name: 'startswith on a string',
    src: 'package t\n\nallow if {\n\tstartswith(input.s, "prefix")\n}\n',
  },
  { name: 'bare boolean field check', src: 'package t\n\nallow if {\n\tinput.f\n}\n' },
  // A quoted dotted key and a nested path used to share one constant, and
  // the witness for the quoted key was rebuilt as the nested path.
  {
    name: 'quoted dotted key and nested path are different fields',
    src: 'package t\n\nallow if {\n\tinput["a.b"] == "x"\n\tinput.a.b == "y"\n}\n',
  },
  {
    name: 'quoted dotted key alone',
    src: 'package t\n\nallow if {\n\tinput["a.b"] == "x"\n}\n',
  // A path compared as a scalar cannot also be the object holding a deeper
  // path; the two constants were independent and the rule proved satisfiable.
    name: 'a field read as a string and as a parent object',
    src: 'package t\n\nallow if {\n\tinput.a == "x"\n\tinput.a.b == "y"\n}\n',
    name: 'a field read as a number and as a parent object',
    src: 'package t\n\nallow if {\n\tinput.a > 1\n\tinput.a.b == "y"\n}\n',
    name: 'a field read as a parent object only, in two places',
    src: 'package t\n\nallow if {\n\tinput.a.b == "x"\n\tinput.a.c == "y"\n}\n',
  },
  // The reads for which "present" does not mean "present as a scalar": an
  // object satisfies each of them, so the parent must not be pinned.
  {
    name: 'a bare truthiness read of the parent object',
    src: 'package t\n\nallow if {\n\tinput.x\n\tinput.x.y == 2\n}\n',
  },
  {
    name: 'a parent compared unequal to a scalar',
    src: 'package t\n\nallow if {\n\tinput.x != "a"\n\tinput.x.y == 2\n}\n',
  },
  {
    name: 'a parent compared to another field, no literal',
    src: 'package t\n\nallow if {\n\tinput.a == input.z\n\tinput.a.b == "y"\n}\n',
  },
  {
    name: 'a parent ordered against a number',
    src: 'package t\n\nallow if {\n\tinput.x > 5\n\tinput.x.y == 2\n}\n',
  },
  {
    name: 'a scalar read and a child read in separate clauses',
    src: 'package t\n\nallow if input.x == 1\n\nallow if input.x.y == 2\n',
  },
  // The reads are per rule: another rule comparing the parent as a value
  // says nothing about the inputs that reach this one.
  {
    name: 'a parent compared as a value in a different rule',
    src: 'package t\n\nallow if input.x.y == 2\n\nother if input.x > 1\n',
  },
  {
    name: 'a parent read as a scalar in a different rule',
    src: 'package t\n\nallow if input.x.y == 2\n\nother if input.x == "s"\n',
  },
  {
    name: 'an unrelated field read only by a different rule',
    src: 'package t\n\nallow if input.a == 1\n\nother if input.b.c == 2\n',
  },
  { name: 'negation as failure', src: 'package t\n\nallow if {\n\tnot input.f\n}\n' },
  {
    name: 'regex that matches every string still needs the field',
    src: 'package t\n\nallow if {\n\tregex.match(".*", input.x)\n}\n',
  },
  {
    name: 'local assignment then comparison',
    src: 'package t\n\nallow if {\n\tage := input.n\n\tage >= 21\n}\n',
  },
];

describe('rego_verify soundness against real OPA', () => {
  for (const c of CASES) {
    for (const kind of ['always_true', 'never_true', 'satisfiable'] as const) {
      it(`${c.name} [${kind}]`, async () => {
        await assertSound(c.name, c.src, c.rule ?? 'allow', kind);
      }, 30_000);
    }
  }
});

describe('rego_verify never claims more than it encoded', () => {
  it('refuses a rule whose clause contains an unencodable operand', async () => {
    // A null comparison cannot be represented in the sort model. The engine used
    // to drop the comparison, leaving an empty always-true body behind.
    const src = 'package t\n\nallow if {\n\tinput.x == null\n}\n';
    const res = await runVerify(parse(src) as never, { kind: 'never_true', ruleName: 'allow' });
    expect(res.verdict).toBe('inconclusive');
  }, 30_000);

  it('refuses a partial set rule instead of answering about a set as if it were a boolean', async () => {
    const src = 'package t\n\ndeny contains "x" if {\n\tinput.n == 1\n}\n';
    const res = await runVerify(parse(src) as never, { kind: 'never_true', ruleName: 'deny' });
    expect(res.verdict).toBe('inconclusive');
    expect(res.unsupportedConstructs.map((u) => u.constructType)).toContain('partial_set_rule');
  }, 30_000);

  it('refuses an else chain rather than silently dropping the clause', async () => {
    const src = 'package t\n\nallow if {\n\tinput.n == 1\n} else := false\n';
    const res = await runVerify(parse(src) as never, { kind: 'never_true', ruleName: 'allow' });
    expect(res.verdict).toBe('inconclusive');
    expect(res.unsupportedConstructs.map((u) => u.constructType)).toContain('else_chain');
  }, 30_000);
});

/**
 * The whole Z3 Context lives in one single-threaded WASM heap, so overlapping
 * solves corrupt each other. An MCP client is free to issue several rego_verify
 * calls at once, and before the lock that produced verdicts silently degraded to
 * `inconclusive` plus an allocator crash inside the WASM module. These policies
 * constrain the SAME input path to conflicting sorts on purpose, which is the
 * case that broke first.
 */
describe('rego_verify under concurrent and repeated calls', () => {
  const CONCURRENT: string[] = [
    'package t\n\nallow if {\n\tinput.v == "a"\n}\n',
    'package t\n\nallow if {\n\tinput.v > 5\n}\n',
    'package t\n\nallow if {\n\tinput.v\n}\n',
    'package t\n\nallow if {\n\tstartswith(input.v, "p")\n}\n',
    'package t\n\ndefault allow := true\n\nallow if {\n\tinput.v == "a"\n\tinput.v == "b"\n}\n',
  ];
  const KINDS: Array<VerifyProperty['kind']> = ['always_true', 'never_true', 'satisfiable'];

  it('gives the same verdicts in parallel as it does serially', async () => {
    const asts = CONCURRENT.map((src) => parse(src) as never);

    const serial = new Map<string, string>();
    for (const [i, ast] of asts.entries()) {
      for (const kind of KINDS) {
        serial.set(`${i}:${kind}`, (await runVerify(ast, { kind, ruleName: 'allow' })).verdict);
      }
    }

    const keys: string[] = [];
    const jobs: Array<Promise<{ verdict: string }>> = [];
    for (const [i, ast] of asts.entries()) {
      for (const kind of KINDS) {
        keys.push(`${i}:${kind}`);
        jobs.push(runVerify(ast, { kind, ruleName: 'allow' }));
      }
    }
    const settled = await Promise.allSettled(jobs);

    const diverged = settled.flatMap((r, n) =>
      r.status === 'fulfilled' && r.value.verdict === serial.get(keys[n]!)
        ? []
        : [
            `${keys[n]}: serial=${serial.get(keys[n]!)} concurrent=${
              r.status === 'fulfilled' ? r.value.verdict : `REJECTED ${String(r.reason)}`
            }`,
          ],
    );
    expect(diverged.join(' | '), 'concurrent verdicts diverged').toBe('');
  }, 180_000);

  it('is deterministic across repeated calls', async () => {
    const ast = parse(CONCURRENT[4]!) as never;
    const runs: string[] = [];
    for (let i = 0; i < 4; i++) {
      runs.push((await runVerify(ast, { kind: 'never_true', ruleName: 'allow' })).verdict);
    }
    expect(new Set(runs).size, `verdicts varied across runs: ${runs.join(', ')}`).toBe(1);
  }, 120_000);
});
