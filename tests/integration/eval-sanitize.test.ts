/**
 * Integration test: inline-source eval output must not leak the temp file path
 * OPA writes the source to. Trace (`explanation`) and coverage paths are
 * normalized to <inline>, matching rego_check's behavior. Runs against the
 * real OPA binary.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../src/config.js';
import { registerRegoEval } from '../../src/tools/evaluation/eval.js';
import { callTool } from '../unit/tools/_helpers.js';

const config: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: process.env['OPA_BINARY'] ?? 'opa',
  regalBinary: process.env['REGAL_BINARY'] ?? 'regal',
  conftestBinary: process.env['CONFTEST_BINARY'] ?? 'conftest',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-opa-mcp-eval-sanitize-it.log'),
  logLevel: 'error',
  maxResponseBytes: 1_000_000,
};

const policy = 'package authz\nimport rego.v1\nallow if input.role == "admin"';

const makeServer = () => {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerRegoEval(server, config);
  return server;
};

describe('inline-source eval path sanitization (real OPA binary)', () => {
  it('rego_eval_with_explain: trace shows <inline>, never a temp path', async () => {
    const env = await callTool<{ explanation?: unknown[] }>(
      makeServer(),
      'rego_eval_with_explain',
      {
        source: policy,
        query: 'data.authz.allow',
        input: { role: 'admin' },
      },
    );
    expect(env.ok).toBe(true);
    const serialized = JSON.stringify(env.data);
    expect(serialized).not.toMatch(/orygn-opa-mcp-/);
    // The temp file path is replaced by the sentinel rather than dropped.
    expect(serialized).toContain('<inline>');
  });

  it('rego_eval_with_coverage: coverage keys carry no temp path', async () => {
    const env = await callTool<{ coverage?: unknown }>(makeServer(), 'rego_eval_with_coverage', {
      source: policy,
      query: 'data.authz.allow',
      input: { role: 'admin' },
    });
    expect(env.ok).toBe(true);
    expect(JSON.stringify(env.data)).not.toMatch(/orygn-opa-mcp-/);
  });
});
