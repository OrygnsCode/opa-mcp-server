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
};

interface ExplainOutput {
  queryResult: 'undefined' | 'defined';
  value?: unknown;
  rulesFound: number;
  rules: Array<{
    isDefault: boolean;
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
