/**
 * The rewrites that let `opa fmt --v0-v1` take a v0 module it would refuse.
 *
 * The ASTs are what `opa parse --v0-compatible --json-include
 * locations,-comments` printed for the fixtures under OPA 1.21, with file
 * paths removed. Whether the rewritten module then formats, checks and behaves
 * the same is tested against a real binary in
 * tests/integration/migrate-v1.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { packageQuery, planV0Migration } from '../../../src/lib/rego-migrate.js';
import { fixturePath } from '../tools/_helpers.js';

const load = (name: string): { source: string; ast: unknown } => ({
  source: readFileSync(fixturePath('migrate', `${name}.rego`), 'utf8'),
  ast: JSON.parse(readFileSync(fixturePath('migrate', `${name}.ast.json`), 'utf8')) as unknown,
});

describe('planV0Migration', () => {
  const { source, ast } = load('legacy');
  const plan = planV0Migration(source, ast)!;
  const lines = plan.source.split('\n');
  const original = source.split('\n');

  it('renames a rule named with a v1 keyword, at its definition and every use', () => {
    expect(plan.renamedRules).toEqual({ contains: 'contains_' });
    expect(lines[7]).toBe('contains_(arr, elem) {');
    expect(lines[13]).toBe('\tnot contains_(approved_registries, split(image, "/")[0])');
    // Through the full data path too.
    expect(lines[39]).toBe('\tdata.legacy.admission.contains_(["a"], "a")');
  });

  it('renames a local variable named with a v1 keyword', () => {
    expect(lines[43]).toBe('\tin_ := count(input.containers)');
    expect(lines[44]).toBe('\tin_ > 1');
  });

  it('renames re_match and net.cidr_overlap to the v1 built-ins', () => {
    expect(lines[19]).toBe('\tregex.match(`:latest$`, image)');
    expect(lines[35]).toBe('\tnet.cidr_contains("10.0.0.0/8", input.ip)');
  });

  it('places an edit by characters on a line with non-ASCII text before it', () => {
    expect(original[48]).toBe('\tl := "café"; re_match(`^caf`, l)');
    expect(lines[48]).toBe('\tl := "café"; regex.match(`^caf`, l)');
  });

  it('replaces the removed built-ins without a v1 equivalent by helpers, defined once', () => {
    expect(lines[25]).toBe('\tall_true([c.runAsNonRoot | c := input.containers[_]])');
    expect(lines[29]).toBe('\tany_true([c.privileged | c := input.containers[_]])');
    expect(lines[32]).toBe('extra_ports = set_difference(as_set(input.ports), {80, 443})');
    for (const helper of ['all_true', 'any_true', 'set_difference', 'as_set']) {
      const definitions = plan.source.match(new RegExp(`^${helper}\\(`, 'gm')) ?? [];
      expect(definitions.length, helper).toBeGreaterThan(0);
    }
    expect(plan.source).not.toMatch(/^as_array\(/m);
  });

  it('keeps every line where it was, so line numbers still point at the original', () => {
    expect(lines.slice(0, original.length).length).toBe(original.length);
    for (const [i, line] of original.entries()) {
      if (line === lines[i]) continue;
      expect(
        plan.rewrites.some((r) => r.line === i + 1),
        `line ${i + 1}`,
      ).toBe(true);
    }
  });

  it('lists each rewrite by line and explains each kind once', () => {
    expect(plan.rewrites).toContainEqual({ line: 8, from: 'contains', to: 'contains_' });
    expect(plan.rewrites).toContainEqual({ line: 26, from: 'all', to: 'all_true' });
    expect(plan.rewrites).toContainEqual({ line: 33, from: 'cast_set', to: 'as_set' });
    expect(plan.notes.filter((n) => n.includes('`contains`'))).toHaveLength(1);
    expect(plan.notes.some((n) => n.includes('`all()`'))).toBe(true);
    expect(plan.notes.some((n) => n.includes('`re_match`'))).toBe(true);
  });

  it('leaves a call to the built-in contains alone when no rule is named contains', () => {
    const b = load('builtin-contains');
    const p = planV0Migration(b.source, b.ast)!;
    expect(p.source).toBe(b.source);
    expect(p.rewrites).toEqual([]);
  });

  it('refuses to guess when the text is not what opa located', () => {
    // Same length, different text: an edit here would corrupt the module.
    const shifted = source.replace('re_match(`:latest$`', 're_mat_h(`:latest$`');
    expect(planV0Migration(shifted, ast)).toBeUndefined();
  });

  it('picks a free name when the preferred one is taken', () => {
    const taken = source.replace('approved_registries', 'all_true');
    const takenAst = JSON.parse(
      JSON.stringify(ast).replaceAll('"approved_registries"', '"all_true"'),
    ) as unknown;
    const p = planV0Migration(taken, takenAst);
    expect(p).toBeDefined();
    expect(p!.rewrites).toContainEqual({ line: 26, from: 'all', to: 'all_true_2' });
  });
});

describe('packageQuery', () => {
  it('reads the package path in a form both Rego versions parse', () => {
    expect(packageQuery(load('legacy').ast)).toBe('data["legacy"]["admission"]');
  });
});
