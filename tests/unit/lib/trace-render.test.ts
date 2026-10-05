/**
 * Tests for renderTrace against a trace captured from OPA 1.21.1:
 *
 *   opa eval -f json --explain full -d roles.rego -i input.json data.authz.allow
 *
 * with roles.rego
 *
 *   default allow := false
 *   allow if { some role in input.user.roles; role == "admin"; not input.user.suspended }
 *
 * and input {"user": {"roles": ["dev", "admin"], "suspended": true}}.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { renderTerm, renderTrace, type TraceEvent } from '../../../src/lib/trace-render.js';
import { fixturePath } from '../tools/_helpers.js';

const events = JSON.parse(
  readFileSync(fixturePath('traces', 'roles-explain-full.json'), 'utf8'),
) as TraceEvent[];

describe('renderTrace on a real OPA trace', () => {
  const rendered = renderTrace(events);
  const { lines } = rendered;

  it('leaves out Redo events and counts them', () => {
    expect(rendered.events).toBe(26);
    expect(rendered.redoOmitted).toBe(9);
    expect(lines).toHaveLength(17);
    expect(lines.some((l) => / Redo /.test(l))).toBe(false);
  });

  it('nests the way opa eval --format pretty does', () => {
    expect(lines[0]).toMatch(/^query:1 +Enter data\.authz\.allow = _$/);
    expect(lines[1]).toMatch(/^query:1 +\| Eval data\.authz\.allow = _$/);
    expect(lines[3]).toMatch(/^roles\.rego:5 +\| Enter data\.authz\.allow$/);
    expect(lines[4]).toMatch(/^roles\.rego:6 +\| \| Eval role = input\.user\.roles\[__local0__\]$/);
  });

  it('shows the values of the variables a condition names', () => {
    expect(lines).toContainEqual(
      expect.stringMatching(/\| \| Fail role = "admin" +\{role: "dev"\}$/),
    );
  });

  it('prints negation, index match counts and exit messages', () => {
    expect(lines).toContainEqual(expect.stringMatching(/Fail not input\.user\.suspended$/));
    expect(lines).toContainEqual(
      expect.stringMatching(/Index data\.authz\.allow \(matched 1 rule, early exit\)$/),
    );
    expect(lines).toContainEqual(expect.stringMatching(/Exit data\.authz\.allow early$/));
  });

  it('keeps Redo events when asked', () => {
    const all = renderTrace(events, { keepRedo: true });
    expect(all.lines).toHaveLength(26);
    expect(all.redoOmitted).toBe(0);
  });

  it('is a small fraction of the raw trace', () => {
    expect(JSON.stringify(lines).length * 5).toBeLessThan(JSON.stringify(events).length);
  });
});

describe('renderTerm', () => {
  const s = (value: string) => ({ type: 'string', value });

  it('writes composite values in Rego syntax', () => {
    expect(
      renderTerm({
        type: 'object',
        value: [
          [s('a'), { type: 'array', value: [{ type: 'number', value: 1 }, { type: 'null' }] }],
          [s('b'), { type: 'set', value: [] }],
        ],
      }),
    ).toBe('{"a": [1, null], "b": set()}');
  });

  it('quotes ref segments that are not identifiers, and prints wildcards as _', () => {
    expect(
      renderTerm({
        type: 'ref',
        value: [{ type: 'var', value: 'input' }, s('labels'), s('app.kubernetes.io/name')],
      }),
    ).toBe('input.labels["app.kubernetes.io/name"]');
    expect(renderTerm({ type: 'var', value: '$term1' })).toBe('_');
  });

  it('writes comparisons and membership infix, other calls as calls', () => {
    const ref = (...names: string[]) => ({
      type: 'ref',
      value: [{ type: 'var', value: names[0] }, ...names.slice(1).map(s)],
    });
    const x = { type: 'var', value: 'x' };
    expect(renderTerm({ type: 'call', value: [ref('gt'), x, { type: 'number', value: 10 }] })).toBe(
      'x > 10',
    );
    expect(
      renderTerm({
        type: 'call',
        value: [ref('internal', 'member_2'), x, { type: 'var', value: 'xs' }],
      }),
    ).toBe('x in xs');
    expect(
      renderTerm({ type: 'call', value: [ref('count'), x, { type: 'var', value: 'n' }] }),
    ).toBe('count(x, n)');
  });
});
