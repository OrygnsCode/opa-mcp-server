/**
 * The analysis tools and conftest on a pre-1.0 policy, against the real
 * binaries.
 *
 * OPA 1.x refuses v0 Rego unless told to read it. These tools used to have
 * no way to say so, and one of them failed quietly: rego_infer_input_schema
 * skipped every file it could not parse and returned an empty schema.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerConftestTools } from '../../src/tools/conftest/index.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import { registerHelperTools } from '../../src/tools/helpers/index.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

const OPA = process.env['OPA_BINARY'] ?? 'opa';

// Pre-1.0 Rego, with nothing a migration would have to rename or replace, so
// `opa fmt --v0-v1` alone turns it into its v1 twin.
const V0 = `package gate

default allow = false

admins = {"alice", "root"}

allow {
	input.method == "GET"
	input.path[0] == "public"
}

allow {
	admins[input.user]
	input.mfa == true
}

deny[msg] {
	input.method == "DELETE"
	not admins[input.user]
	msg := sprintf("%v may not delete", [input.user])
}
`;

let work: string;
let config: Config;
let v1Twin: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'orygn-v0-analysis-'));
  await writeFile(join(work, 'gate.rego'), V0, 'utf8');
  const fmt = spawnSync(OPA, ['fmt', '--v0-v1', join(work, 'gate.rego')], { encoding: 'utf8' });
  expect(fmt.status, fmt.stderr).toBe(0);
  v1Twin = fmt.stdout;
  config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: OPA,
    regalBinary: 'regal',
    conftestBinary: process.env['CONFTEST_BINARY'] ?? 'conftest',
    subprocessTimeoutMs: 60_000,
    httpTimeoutMs: 15_000,
    allowedPaths: [work],
    logFile: join(work, 'server.log'),
    logLevel: 'error',
    maxResponseBytes: 1_000_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

const server = () => {
  const s = makeServer();
  registerHelperTools(s, config);
  registerEvaluationTools(s, config);
  registerConftestTools(s, config);
  return s;
};

/**
 * An AST with every location, the `import rego.v1` the formatter adds, and a
 * head's `assign` flag removed. That flag records `:=` against `=` in a rule
 * head, and nothing in the verify engine reads it (its `assign` cases are the
 * body operator, the same in both versions).
 */
function comparable(ast: unknown): unknown {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k, v]) => k !== 'location' && !(k === 'assign' && typeof v === 'boolean'))
        .map(([k, v]) => [k, strip(v)]),
    );
  };
  const out = strip(ast) as { imports?: unknown[] };
  out.imports = (out.imports ?? []).filter((i) => !JSON.stringify(i).includes('"v1"'));
  if (out.imports.length === 0) delete out.imports;
  return out;
}

describe('rego_verify on v0', () => {
  it('parses a v0 policy to the same AST as its v1 twin, which is all the engine reads', () => {
    const parse = (args: string[], src: string) => {
      const file = join(work, `p-${args.length}.rego`);
      spawnSync(process.execPath, [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(src)})`,
      ]);
      const r = spawnSync(OPA, ['parse', '--format=json', ...args, file], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout) as unknown;
    };
    expect(comparable(parse(['--v0-compatible'], V0))).toEqual(comparable(parse([], v1Twin)));
  });

  // A rule the engine encodes, so the verdicts are real ones and not two
  // matching `inconclusive`s.
  const encodable = 'package verdicts\n\ndefault allow = false\n\nallow {\n\tinput.b == 2\n}\n';
  const encodableTwin =
    'package verdicts\n\nimport rego.v1\n\ndefault allow := false\n\nallow if {\n\tinput.b == 2\n}\n';

  it.each(['always_true', 'never_true', 'satisfiable'] as const)(
    'gives allow %s the same verdict for a v0 policy and its twin',
    async (kind) => {
      const s = server();
      const a = await callTool<{ verdict: string }>(s, 'rego_verify', {
        source: encodable,
        rule: 'allow',
        kind,
        v0Compatible: true,
      });
      const b = await callTool<{ verdict: string }>(s, 'rego_verify', {
        source: encodableTwin,
        rule: 'allow',
        kind,
      });
      expect(a.ok, JSON.stringify(a.error)).toBe(true);
      expect(b.ok, JSON.stringify(b.error)).toBe(true);
      expect(a.data?.verdict).not.toBe('inconclusive');
      expect(a.data?.verdict).toBe(b.data?.verdict);
    },
  );
});

describe('the analysis tools on v0', () => {
  it('rego_explain_undefined finds the condition that blocks a v0 rule', async () => {
    const env = await callTool<{ summary: string }>(server(), 'rego_explain_undefined', {
      query: 'data.gate.allow',
      source: V0,
      input: { method: 'POST', user: 'alice', mfa: false },
      v0Compatible: true,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.summary).toMatch(/mfa/);
  });

  it('rego_policy_diff compares a v0 original with its v1 twin', async () => {
    const env = await callTool<{ equal: boolean }>(server(), 'rego_policy_diff', {
      sourceA: V0,
      v0CompatibleA: true,
      sourceB: v1Twin,
      query: 'data.gate',
      input: { method: 'DELETE', user: 'bob' },
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.equal).toBe(true);
  });

  it('rego_describe_policy and rego_generate_test_skeleton read a v0 policy', async () => {
    const s = server();
    const described = await callTool(s, 'rego_describe_policy', { source: V0, v0Compatible: true });
    expect(described.ok, JSON.stringify(described.error)).toBe(true);
    const skeleton = await callTool<{ testFile?: string; tests?: string }>(
      s,
      'rego_generate_test_skeleton',
      { source: V0, v0Compatible: true },
    );
    expect(skeleton.ok, JSON.stringify(skeleton.error)).toBe(true);
  });

  it('rego_infer_input_schema reads v0 files, and says so when it cannot', async () => {
    const s = server();
    const without = await callTool<{ inputPaths: string[] }>(s, 'rego_infer_input_schema', {
      paths: [join(work, 'gate.rego')],
    });
    expect(without.error?.code).toBe('INVALID_REGO');
    expect(without.error?.hint).toMatch(/set `v0Compatible`/);

    const withFlag = await callTool<{ inputPaths: string[] }>(s, 'rego_infer_input_schema', {
      paths: [join(work, 'gate.rego')],
      v0Compatible: true,
    });
    expect(withFlag.data?.inputPaths).toEqual(
      expect.arrayContaining(['input.method', 'input.mfa', 'input.user']),
    );
  });
});

describe('conftest on v0', () => {
  it('conftest_test and conftest_verify read a v0 policy with v0Compatible', async (ctx) => {
    const conftest = process.env['CONFTEST_BINARY'] ?? 'conftest';
    const version = spawnSync(conftest, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (version.status !== 0) ctx.skip('conftest not available');
    const policy = `package main

deny[msg] {
	input.kind == "Pod"
	msg := "no pods"
}
`;
    const s = server();
    // Without the flag conftest reads v1 and refuses the policy; the error
    // says so and points at v0Compatible.
    const refused = await callTool(s, 'conftest_test', {
      inlineConfig: 'kind: Pod\n',
      inlinePolicy: policy,
    });
    expect(refused.error?.code).toBe('INVALID_REGO');
    expect(refused.error?.hint).toMatch(/v0Compatible/);

    const tested = await callTool<{ failures: number }>(s, 'conftest_test', {
      inlineConfig: 'kind: Pod\n',
      inlinePolicy: policy,
      v0Compatible: true,
    });
    expect(tested.ok, JSON.stringify(tested.error)).toBe(true);
    expect(JSON.stringify(tested.data)).toContain('no pods');

    const dir = await mkdtemp(join(work, 'cft-'));
    await writeFile(join(dir, 'p.rego'), policy, 'utf8');
    await writeFile(
      join(dir, 'p_test.rego'),
      'package main\n\ntest_denies {\n\tdeny["no pods"] with input as {"kind": "Pod"}\n}\n',
      'utf8',
    );
    const verified = await callTool<{ passed: boolean; summary: { failed: number } }>(
      s,
      'conftest_verify',
      { policy: dir, v0Compatible: true },
    );
    expect(verified.ok, JSON.stringify(verified.error)).toBe(true);
    expect(verified.data?.passed).toBe(true);
    expect(verified.data?.summary.failed).toBe(0);
  });
});
