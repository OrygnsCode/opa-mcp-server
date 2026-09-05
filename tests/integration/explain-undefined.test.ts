/**
 * Integration tests for rego_explain_undefined -- runs against the real OPA
 * binary so the full pipeline (plain eval, --explain=full trace, parse, and
 * per-condition standalone eval) is exercised with OPA's actual output shapes.
 *
 * These specifically guard the standalone-eval path: OPA returns a result row
 * for a body expression even when it evaluates to `false` (e.g. an unsatisfied
 * equality guard). A row-count check would mark such a condition satisfied and
 * report the wrong blocker -- or none. Realistic authz policies make the
 * failure mode concrete: a user asks "why is `allow` undefined?" and must be
 * pointed at the guard that actually failed.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../src/config.js';
import { registerRegoExplainUndefined } from '../../src/tools/helpers/explain-undefined.js';
import { callTool } from '../unit/tools/_helpers.js';

const makeServer = () => new McpServer({ name: 'test-server', version: '0.0.0' });

const config: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: process.env['OPA_BINARY'] ?? 'opa',
  regalBinary: process.env['REGAL_BINARY'] ?? 'regal',
  conftestBinary: process.env['CONFTEST_BINARY'] ?? 'conftest',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-opa-mcp-explain-undefined-it.log'),
  logLevel: 'error',
  maxResponseBytes: 100_000,
  maxSubprocessBytes: 32 * 1024 * 1024,
};

interface ExplainOutput {
  queryResult: 'undefined' | 'defined' | 'default';
  value?: unknown;
  summary: string;
  defaultValue?: unknown;
  rulesFound: number;
  rules: Array<{
    isDefault: boolean;
    location: { row: number };
    source: 'trace' | 'standalone-eval';
    conditions: Array<{ index: number; text: string; result: string }>;
    blockingCondition: { index: number; text: string; result: string } | null;
  }>;
}

// A realistic ABAC guard: method + path + subscription tier must all hold.
const abacPolicy = [
  'package authz',
  'import rego.v1',
  'allow if {',
  '\tinput.method == "GET"',
  '\tinput.path == "/public"',
  '\tinput.user.tier == "premium"',
  '}',
].join('\n');

const ruleWithConditions = (env: { data?: ExplainOutput | undefined }) =>
  env.data!.rules.find((r) => !r.isDefault && r.conditions.length > 0)!;

describe('rego_explain_undefined integration (real OPA binary)', () => {
  it('reports a present-but-false LAST guard as the blocker, not as satisfied', async () => {
    // tier is "free"; the method and path guards both hold. Under the old
    // row-count logic the tier guard (which OPA returns as a row with
    // value:false) was marked satisfied and no blocker was found.
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: abacPolicy,
      input: { method: 'GET', path: '/public', user: { tier: 'free' } },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.queryResult).toBe('undefined');
    expect(env.data?.rulesFound).toBe(1);

    const rule = ruleWithConditions(env);
    // This policy is indexed out by OPA, so this exercises the standalone-eval
    // path -- the path the fix lives in.
    expect(rule.source).toBe('standalone-eval');
    const byText = (needle: string) => rule.conditions.find((c) => c.text.includes(needle))!;
    // The blocker is the last guard; earlier guards resolve to true under both
    // the trace and standalone paths, so these assertions are path-robust.
    expect(byText('method').result).toBe('true');
    expect(byText('path').result).toBe('true');
    expect(byText('tier').result).toBe('false');
    expect(rule.blockingCondition).not.toBeNull();
    expect(rule.blockingCondition!.text).toContain('tier');
  });

  it('does not misreport a satisfied guard: with tier premium but method wrong, method is the blocker', async () => {
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: abacPolicy,
      input: { method: 'POST', path: '/public', user: { tier: 'premium' } },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.queryResult).toBe('undefined');
    const rule = ruleWithConditions(env);
    expect(rule.conditions.find((c) => c.text.includes('method'))!.result).toBe('false');
    expect(rule.blockingCondition).not.toBeNull();
    expect(rule.blockingCondition!.text).toContain('method');
  });

  it('returns queryResult: defined when every guard is satisfied (no phantom blocker)', async () => {
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: abacPolicy,
      input: { method: 'GET', path: '/public', user: { tier: 'premium' } },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.queryResult).toBe('defined');
    expect(env.data?.value).toBe(true);
  });

  it('standalone: a local assigned earlier keeps the later guard evaluable, and that guard is the blocker', async () => {
    // Each condition used to be evaluated alone: `u == "alice"` is unsafe
    // without its assignment, came back unevaluable, and was named as the
    // blocker while the tier guard sat behind it marked false.
    const policy = [
      'package authz',
      'import rego.v1',
      'allow if {',
      '\tu := input.user',
      '\tu == "alice"',
      '\tinput.tier == "gold"',
      '}',
    ].join('\n');
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: policy,
      input: { user: 'alice', tier: 'free' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.queryResult).toBe('undefined');
    const rule = ruleWithConditions(env);
    expect(rule.source).toBe('standalone-eval');
    const byText = (needle: string) => rule.conditions.find((c) => c.text.includes(needle))!;
    expect(byText('u := input.user').result).toBe('true');
    expect(byText('u == "alice"').result).toBe('true');
    expect(byText('tier').result).toBe('false');
    expect(rule.blockingCondition).not.toBeNull();
    expect(rule.blockingCondition!.text).toContain('tier');
  });

  it('standalone: a bare reference to a sibling rule resolves inside the package', async () => {
    const policy = [
      'package authz',
      'import rego.v1',
      'is_admin if input.role == "admin"',
      'allow if {',
      '\tis_admin',
      '\tinput.tier == "gold"',
      '}',
    ].join('\n');
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: policy,
      input: { role: 'admin', tier: 'free' },
    });
    expect(env.ok).toBe(true);
    const rule = ruleWithConditions(env);
    expect(rule.source).toBe('standalone-eval');
    const byText = (needle: string) => rule.conditions.find((c) => c.text.includes(needle))!;
    expect(byText('is_admin').result).toBe('true');
    expect(byText('tier').result).toBe('false');
    expect(rule.blockingCondition!.text).toContain('tier');
  });

  it('standalone: a condition through an import is judged, and is the blocker when it fails', async () => {
    // --package alone does not bring the module's imports; without them
    // `roles.admin[...]` is unsafe as a query, came back unevaluable, and the
    // tier guard behind it was blamed instead.
    const policy = [
      'package authz',
      'import rego.v1',
      'import data.roles',
      'allow if {',
      '\troles.admin[input.user]',
      '\tinput.tier == "gold"',
      '}',
    ].join('\n');
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: policy,
      input: { user: 'alice', tier: 'free' },
    });
    expect(env.ok).toBe(true);
    const rule = ruleWithConditions(env);
    expect(rule.source).toBe('standalone-eval');
    const byText = (needle: string) => rule.conditions.find((c) => c.text.includes(needle))!;
    // No data.roles was supplied, so the reference is undefined: a real blocker.
    expect(byText('roles.admin').result).toBe('false');
    expect(rule.blockingCondition!.text).toContain('roles.admin');
    expect(byText('tier').result).toBe('unevaluable');
  });

  it('standalone: an import alias resolves in the query', async () => {
    const policy = [
      'package a.b.c',
      'import rego.v1',
      'import input.tier as t',
      'allow if {',
      '\tinput.user == "alice"',
      '\tt == "gold"',
      '}',
    ].join('\n');
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.a.b.c.allow',
      source: policy,
      input: { user: 'alice', tier: 'free' },
    });
    expect(env.ok).toBe(true);
    const rule = ruleWithConditions(env);
    expect(rule.source).toBe('standalone-eval');
    const byText = (needle: string) => rule.conditions.find((c) => c.text.includes(needle))!;
    expect(byText('alice').result).toBe('true');
    expect(byText('t == "gold"').result).toBe('false');
    expect(rule.blockingCondition!.text).toContain('t == "gold"');
  });

  it('a sibling rule that does not hold is itself the blocker, on either path', async () => {
    const policy = [
      'package authz',
      'import rego.v1',
      'is_admin if input.role == "admin"',
      'allow if {',
      '\tis_admin',
      '\tinput.tier == "gold"',
      '}',
    ].join('\n');
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: policy,
      input: { role: 'user', tier: 'gold' },
    });
    expect(env.ok).toBe(true);
    const rule = ruleWithConditions(env);
    const byText = (needle: string) => rule.conditions.find((c) => c.text.includes(needle))!;
    // With the tier guard satisfied the indexer keeps this rule, so it is
    // traced rather than evaluated standalone; the blocker must come out the
    // same either way.
    expect(byText('is_admin').result).toBe('false');
    expect(rule.blockingCondition!.text).toContain('is_admin');
  });

  it('RBAC: a comparison between two input refs that fails is correctly the blocker', async () => {
    // Ownership check: resource.owner must equal the caller. Here owner=alice,
    // caller=bob -> the guard is false (a real row with value:false), and it is
    // the blocker.
    const rbac = [
      'package authz',
      'import rego.v1',
      'allow if {',
      '\tinput.action == "delete"',
      '\tinput.resource.owner == input.user',
      '}',
    ].join('\n');
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source: rbac,
      input: { action: 'delete', resource: { owner: 'alice' }, user: 'bob' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.queryResult).toBe('undefined');
    const rule = ruleWithConditions(env);
    // action == "delete" holds; the ownership comparison is the blocker.
    expect(rule.conditions.find((c) => c.text.includes('action'))!.result).toBe('true');
    expect(rule.conditions.find((c) => c.text.includes('owner'))!.result).toBe('false');
    expect(rule.blockingCondition!.text).toContain('owner');
  });
});

describe('rego_explain_undefined with a default rule', () => {
  // `default allow := false` gives the query a value, so it is never undefined.
  // Skipping the analysis for that meant the tool had nothing to say about the
  // shape almost every real policy is written in.
  const source = [
    'package authz',
    '',
    'import rego.v1',
    '',
    'default allow := false',
    '',
    'allow if {',
    '\tinput.user.role == "admin"',
    '\tinput.env == "prod"',
    '}',
    '',
    'allow if {',
    '\tinput.action == "read"',
    '\tinput.user.id == input.resource.owner',
    '}',
    '',
  ].join('\n');

  it('names the blocking condition in every clause', async () => {
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source,
      input: {
        user: { role: 'viewer', id: 'u1' },
        env: 'dev',
        action: 'write',
        resource: { owner: 'u2' },
      },
    });

    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.queryResult).toBe('default');
    expect(env.data?.value).toBe(false);
    expect(env.data?.defaultValue).toBe(false);
    expect(env.data?.rulesFound).toBe(2);
    expect(env.data?.summary).toContain('falls back to its default');

    const clauses = (env.data?.rules ?? []).filter((r) => !r.isDefault);
    expect(clauses).toHaveLength(2);
    // Each clause is analysed on its own: matching on the rule name alone made
    // every clause look traced because the default rule was, and none of them
    // were then evaluated.
    expect(clauses[0]?.blockingCondition?.text).toBe('input.user.role == "admin"');
    expect(clauses[1]?.blockingCondition?.text).toBe('input.action == "read"');
    // Conditions up to and including the blocker are judged; the ones after
    // it are not reached, as on the traced path.
    for (const c of clauses) {
      const blocker = c.conditions.findIndex((cond) => cond.result === 'false');
      expect(blocker).toBeGreaterThanOrEqual(0);
      for (const cond of c.conditions.slice(0, blocker + 1)) {
        expect(cond.result).not.toBe('unevaluable');
      }
    }
  }, 60_000);

  it('reports the first satisfied condition as satisfied and the next as the blocker', async () => {
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source,
      input: {
        user: { role: 'admin', id: 'u1' },
        env: 'staging',
        action: 'write',
        resource: { owner: 'u2' },
      },
    });

    expect(env.data?.queryResult).toBe('default');
    const first = (env.data?.rules ?? []).filter((r) => !r.isDefault)[0];
    expect(first?.conditions[0]?.result).toBe('true');
    expect(first?.blockingCondition?.text).toBe('input.env == "prod"');
  }, 60_000);

  it('stays "defined" when a clause actually matched', async () => {
    const server = makeServer();
    registerRegoExplainUndefined(server, config);
    const env = await callTool<ExplainOutput>(server, 'rego_explain_undefined', {
      query: 'data.authz.allow',
      source,
      input: {
        user: { role: 'admin', id: 'u1' },
        env: 'prod',
        action: 'write',
        resource: { owner: 'u2' },
      },
    });

    expect(env.data?.queryResult).toBe('defined');
    expect(env.data?.value).toBe(true);
    expect(env.data?.rulesFound).toBe(0);
  }, 60_000);
});
