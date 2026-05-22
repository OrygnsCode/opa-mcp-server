/**
 * Integration tests for rego_policy_diff -- runs against the real OPA binary.
 * All policies use inline source so no fixture files are modified.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../src/config.js';
import { OpaCli } from '../../src/lib/opa-cli.js';
import {
  diffValues,
  extractResultValue,
  registerRegoPolicyDiff,
  type RegoPolicyDiffOutput,
} from '../../src/tools/helpers/policy-diff.js';
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
  logFile: join(tmpdir(), 'orygn-opa-mcp-policy-diff-it.log'),
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

// Canonical policy allowing only "admin" role
const policyAdmin = [
  'package rbac',
  'import rego.v1',
  'default allow := false',
  'allow if { input.role == "admin" }',
].join('\n');

// Wider policy -- also allows "superuser"
const policyAdminSuperuser = [
  'package rbac',
  'import rego.v1',
  'default allow := false',
  'allow if { input.role == "admin" }',
  'allow if { input.role == "superuser" }',
].join('\n');

// Policy returning a structured object
const policyObject = [
  'package rbac',
  'import rego.v1',
  'default allow := false',
  'allow if { input.role == "admin" }',
  'roles := {"admin", "editor"}',
].join('\n');

const policyObjectV2 = [
  'package rbac',
  'import rego.v1',
  'default allow := false',
  'allow if { input.role == "admin" }',
  'roles := {"admin", "editor", "viewer"}',
].join('\n');

describe('rego_policy_diff integration (real OPA binary)', () => {
  it('returns equal: true when both policies produce the same result', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, config);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: policyAdmin,
      sourceB: policyAdmin,
      query: 'data.rbac.allow',
      input: { role: 'admin' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(true);
    expect(env.data?.resultA).toBe(true);
    expect(env.data?.resultB).toBe(true);
    expect(env.data?.changedPaths).toHaveLength(0);
  });

  it('returns equal: false when policies differ on a discriminating input', async () => {
    // superuser is allowed in B but not in A
    const server = makeServer();
    registerRegoPolicyDiff(server, config);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: policyAdmin,
      sourceB: policyAdminSuperuser,
      query: 'data.rbac.allow',
      input: { role: 'superuser' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(false);
    // A: false (default allow := false fires), B: true (superuser rule matches)
    expect(env.data?.resultA).toBe(false);
    expect(env.data?.resultB).toBe(true);
  });

  it('returns equal: true on a non-discriminating input (both policies agree)', async () => {
    // admin is allowed in both
    const server = makeServer();
    registerRegoPolicyDiff(server, config);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: policyAdmin,
      sourceB: policyAdminSuperuser,
      query: 'data.rbac.allow',
      input: { role: 'admin' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(true);
  });

  it('surfaces changedPaths for object queries with structural differences', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, config);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: policyObject,
      sourceB: policyObjectV2,
      query: 'data.rbac',
      input: { role: 'admin' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(false);
    // allow should be same (both true for admin), roles should differ
    expect(env.data?.changedPaths).toContain('roles');
    expect(env.data?.changedPaths).not.toContain('allow');
  });

  it('returns equal: true when both sides return undefined (unknown query)', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, config);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: policyAdmin,
      sourceB: policyAdmin,
      query: 'data.rbac.nonexistent',
      input: { role: 'admin' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(true);
    expect(env.data?.resultA).toBeUndefined();
    expect(env.data?.resultB).toBeUndefined();
  });

  it('returns INVALID_REGO when policy A has a parse error', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, config);
    const env = await callTool(server, 'rego_policy_diff', {
      sourceA: 'package bad\n[broken syntax',
      sourceB: policyAdmin,
      query: 'data.bad.allow',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('INVALID_REGO');
  });
});

// ─── OpaCli.eval() round-trip sanity checks ──────────────────────────────────
// These verify that the extractResultValue parser correctly handles the
// exact stdout shape produced by the real OPA binary.

describe('extractResultValue() with real OPA output', () => {
  const opa = new OpaCli(config);

  it('extracts true from a truthy policy eval', async () => {
    const result = await opa.eval({
      source: policyAdmin,
      query: 'data.rbac.allow',
      input: { role: 'admin' },
    });
    expect(result.exitCode).toBe(0);
    expect(extractResultValue(result.stdout)).toBe(true);
  });

  it('returns undefined for an undefined query result', async () => {
    // data.rbac.allow has a default so it always returns false, not undefined.
    // Use a path that is genuinely absent from the policy to get an empty result.
    const result = await opa.eval({
      source: policyAdmin,
      query: 'data.rbac.nonexistent',
      input: { role: 'nobody' },
    });
    expect(result.exitCode).toBe(0);
    expect(extractResultValue(result.stdout)).toBeUndefined();
  });

  it('extracts an object for a package-level query', async () => {
    const result = await opa.eval({
      source: policyObject,
      query: 'data.rbac',
      input: { role: 'admin' },
    });
    expect(result.exitCode).toBe(0);
    const value = extractResultValue(result.stdout) as { allow: boolean };
    expect(typeof value).toBe('object');
    expect(value.allow).toBe(true);
  });
});

// ─── diffValues() property checks ────────────────────────────────────────────

describe('diffValues() invariants', () => {
  it('is reflexive: diffValues(x, x) === []', () => {
    expect(diffValues(true, true)).toHaveLength(0);
    expect(diffValues({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toHaveLength(0);
    expect(diffValues(undefined, undefined)).toHaveLength(0);
  });

  it('is not symmetric on undefined vs defined', () => {
    const aToB = diffValues(undefined, true);
    const bToA = diffValues(true, undefined);
    expect(aToB).toEqual(['.']);
    expect(bToA).toEqual(['.']);
  });
});
