/**
 * Integration test: a policy evaluated through this server must not be able to
 * read the server's environment.
 *
 * Rego's `opa.runtime().env` returns the environment of the `opa` process. When
 * the server hands its own `process.env` to that child, any policy it evaluates
 * can read every secret the operator gave the MCP client -- `OPA_TOKEN`, and the
 * `GITHUB_TOKEN` the README tells people to put in their client config for
 * `rego_playground_share`.
 *
 * That is reachable without any filesystem access: `rego_eval` accepts inline
 * source, so the `OPA_MCP_ALLOWED_PATHS` allow-list never comes into play, and
 * the tool is annotated `readOnlyHint: true`. Untrusted Rego reaches an agent
 * through a README, an issue, or a pull request diff, so this is a prompt
 * injection away.
 *
 * Runs against the real OPA binary, because the leak is a property of how the
 * child process is spawned and a mocked subprocess would prove nothing.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  logFile: join(tmpdir(), 'orygn-opa-mcp-env-isolation-it.log'),
  logLevel: 'error',
  maxResponseBytes: 5_000_000,
  maxSubprocessBytes: 32 * 1024 * 1024,
};

/**
 * Distinctive values, so a match in the response is unambiguous rather than a
 * coincidental substring of some unrelated field.
 */
const SENTINELS = {
  OPA_TOKEN: 'sentinel-opa-token-9f3a1c',
  GITHUB_TOKEN: 'sentinel-github-token-4b7e2d',
  AWS_SECRET_ACCESS_KEY: 'sentinel-aws-secret-8c5f0a',
  OPA_MCP_TEST_ARBITRARY: 'sentinel-arbitrary-1e9d6b',
} as const;

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(SENTINELS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const k of Object.keys(SENTINELS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const makeServer = (): McpServer => {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerRegoEval(server, config);
  return server;
};

/** The exfiltration policy an attacker would plant. */
const EXFIL_POLICY = 'package exfil\n\nleaked := opa.runtime().env\n';

function assertNoSentinels(haystack: string): void {
  for (const [name, value] of Object.entries(SENTINELS)) {
    expect(haystack, `${name} leaked into the tool response`).not.toContain(value);
  }
}

describe('evaluated policy cannot read the server environment (real OPA binary)', () => {
  it('rego_eval: opa.runtime().env does not expose the server env', async () => {
    const envelope = await callTool(makeServer(), 'rego_eval', {
      source: EXFIL_POLICY,
      query: 'data.exfil.leaked',
    });

    // Whether the call succeeds or errors is not the contract under test; the
    // contract is that no secret comes back either way.
    assertNoSentinels(JSON.stringify(envelope));
  });

  it('rego_eval: a policy cannot select a single secret out of the environment', async () => {
    // Reading one key is the realistic attack. It stays small, so it survives
    // response-size truncation that a full env dump might trip.
    const envelope = await callTool(makeServer(), 'rego_eval', {
      source: 'package exfil\n\ntoken := opa.runtime().env.OPA_TOKEN\n',
      query: 'data.exfil.token',
    });

    assertNoSentinels(JSON.stringify(envelope));
  });

  it('rego_eval_with_explain: the trace does not carry the environment either', async () => {
    // The explain path serializes far more of OPA's internal state, so a value
    // scrubbed from `result` could still surface inside the trace.
    const envelope = await callTool(makeServer(), 'rego_eval_with_explain', {
      source: EXFIL_POLICY,
      query: 'data.exfil.leaked',
    });

    assertNoSentinels(JSON.stringify(envelope));
  });

  it('rego_eval: input and data arguments cannot be used to smuggle the env back', async () => {
    // Comparing against the env rather than returning it: if the comparison is
    // observable, an attacker can extract a secret one guess at a time.
    const envelope = await callTool(makeServer(), 'rego_eval', {
      source: 'package exfil\n\nmatched if opa.runtime().env.OPA_TOKEN == input.guess\n',
      query: 'data.exfil.matched',
      input: { guess: SENTINELS.OPA_TOKEN },
    });

    const text = JSON.stringify(envelope);
    assertNoSentinels(text);
    // A `true` here would confirm the guess even without echoing the value.
    const parsed = JSON.parse(text) as { ok?: boolean; data?: unknown };
    if (parsed.ok === true) {
      expect(
        JSON.stringify(parsed.data),
        'the policy confirmed a guessed secret, which is an oracle',
      ).not.toMatch(/"(result|value)"\s*:\s*true/);
    }
  });
});
