/**
 * Integration tests, against the real OPA binary, for loading a pre-1.0
 * policy and for evaluating a query against several inputs in one call.
 *
 * OPA 1.x refuses v0 Rego unless `--v0-compatible` is passed, so a policy that
 * has not been migrated could not be evaluated, tested or checked at all. That
 * matters most while migrating it: the original is the reference the migrated
 * copy has to agree with.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerAuthoringTools } from '../../src/tools/authoring/index.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import { registerHelperTools } from '../../src/tools/helpers/index.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

// Pre-1.0 Rego: no `if`, a partial set written `deny[msg] { ... }`.
const V0_POLICY = `package legacy

default allow = false

deny[msg] {
	input.user == "mallory"
	msg = "mallory is blocked"
}

allow {
	input.role == "admin"
	count(deny) == 0
}
`;

const V0_TEST = `package legacy

test_admin_allowed {
	allow with input as {"role": "admin", "user": "alice"}
}
`;

let workDir: string;
let policyDir: string;
let policyFile: string;
let inputDir: string;
let config: Config;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-v0-eval-'));
  policyDir = join(workDir, 'policy');
  inputDir = join(workDir, 'inputs');
  await mkdir(policyDir, { recursive: true });
  await mkdir(inputDir, { recursive: true });
  policyFile = join(policyDir, 'legacy.rego');
  await writeFile(policyFile, V0_POLICY, 'utf8');
  await writeFile(join(policyDir, 'legacy_test.rego'), V0_TEST, 'utf8');
  await writeFile(join(inputDir, 'admin.json'), '{"role":"admin","user":"alice"}\n', 'utf8');

  config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: process.env['OPA_BINARY'] ?? 'opa',
    regalBinary: 'regal',
    conftestBinary: 'conftest',
    subprocessTimeoutMs: 60_000,
    httpTimeoutMs: 15_000,
    allowedPaths: [workDir],
    logFile: join(workDir, 'server.log'),
    logLevel: 'error',
    maxResponseBytes: 100_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

const server = () => {
  const s = makeServer();
  registerEvaluationTools(s, config);
  registerAuthoringTools(s, config);
  return s;
};

type EvalOut = { result?: Array<{ expressions: Array<{ value: unknown }> }>; hint?: string };
const valueOf = (out: EvalOut | undefined): unknown => out?.result?.[0]?.expressions[0]?.value;

describe('a v0 policy', () => {
  it('does not load without v0Compatible', async () => {
    const env = await callTool(server(), 'rego_eval', {
      query: 'data.legacy.allow',
      paths: [policyFile],
      input: { role: 'admin' },
    });
    expect(env.ok).toBe(false);
  });

  it('evaluates with v0Compatible', async () => {
    const env = await callTool<EvalOut>(server(), 'rego_eval', {
      query: 'data.legacy.allow',
      source: V0_POLICY,
      input: { role: 'admin', user: 'alice' },
      v0Compatible: true,
    });
    expect(env.ok).toBe(true);
    expect(valueOf(env.data)).toBe(true);
  });

  it('checks, tests and runs through opa exec with v0Compatible', async () => {
    const s = server();
    const check = await callTool<{ valid: boolean }>(s, 'rego_check', {
      paths: [policyFile],
      v0Compatible: true,
    });
    expect(check.data?.valid).toBe(true);

    const test = await callTool<{ passed: number; failed: number }>(s, 'rego_test', {
      paths: [policyDir],
      v0Compatible: true,
    });
    expect(test.ok).toBe(true);
    expect(test.data?.passed).toBe(1);

    const exec = await callTool<{ results: Array<{ result?: unknown }> }>(s, 'opa_exec', {
      inputPaths: [inputDir],
      decision: 'legacy/allow',
      dataPaths: [policyDir],
      v0Compatible: true,
    });
    expect(exec.ok).toBe(true);
    expect(exec.data?.results[0]?.result).toBe(true);
  });
});

describe('a query against a v0 policy', () => {
  // OPA reads the query as v0 too, where `in` and `every` are keywords only
  // once imported.
  it('can use the v1 keywords', async () => {
    const s = server();
    const membership = await callTool<EvalOut>(s, 'rego_eval', {
      query: '"mallory is blocked" in data.legacy.deny',
      source: V0_POLICY,
      input: { user: 'mallory' },
      v0Compatible: true,
    });
    expect(membership.ok, JSON.stringify(membership.error)).toBe(true);
    expect(valueOf(membership.data)).toBe(true);

    const every = await callTool<EvalOut>(s, 'rego_eval', {
      query: 'every m in data.legacy.deny { startswith(m, "mallory") }',
      source: V0_POLICY,
      input: { user: 'mallory' },
      v0Compatible: true,
    });
    expect(every.ok, JSON.stringify(every.error)).toBe(true);
    expect(valueOf(every.data)).toBe(true);

    const batch = await callTool<{ errorCount: number }>(s, 'rego_eval', {
      query: '"mallory is blocked" in data.legacy.deny',
      source: V0_POLICY,
      inputs: [{ user: 'mallory' }, { user: 'alice' }],
      v0Compatible: true,
    });
    expect(batch.ok, JSON.stringify(batch.error)).toBe(true);
    expect(batch.data?.errorCount).toBe(0);

    const compiled = await callTool(s, 'rego_compile_query', {
      query: '"mallory is blocked" in data.legacy.deny',
      source: V0_POLICY,
      unknowns: ['input'],
      v0Compatible: true,
    });
    expect(compiled.ok, JSON.stringify(compiled.error)).toBe(true);
  });
});

describe('the other tools on a v0 policy read without v0Compatible', () => {
  it('rego_check_schema reports the parse error, not a missing annotation', async () => {
    const dir = join(workDir, 'schema-check');
    await mkdir(join(dir, 'schemas'), { recursive: true });
    await writeFile(
      join(dir, 'annotated.rego'),
      '# METADATA\n# schemas:\n#   - input: schema.req\npackage annotated\n\nallow {\n\tinput.role == "admin"\n}\n',
    );
    await writeFile(
      join(dir, 'schemas', 'req.json'),
      JSON.stringify({ type: 'object', properties: { role: { type: 'string' } } }),
    );
    const env = await callTool<{ valid: boolean; errors: Array<{ code?: string }> }>(
      server(),
      'rego_check_schema',
      { paths: [join(dir, 'annotated.rego')], schemaPath: join(dir, 'schemas') },
    );
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors[0]?.code).toBe('rego_parse_error');
  });

  it('rego_check_schema skips a data file, and refuses what opa cannot read', async () => {
    const dir = join(workDir, 'schema-dir-cases');
    await mkdir(join(dir, 'schemas'), { recursive: true });
    await mkdir(join(dir, 'bundle'), { recursive: true });
    await writeFile(join(dir, 'policy.rego'), 'package p\n\nallow if input.nosuch == "x"\n');
    await writeFile(join(dir, 'data.json'), '{"a": 1}');
    await writeFile(join(dir, 'schemas', 'input.json'), '{"type": "object"}');
    await writeFile(
      join(dir, 'bundle', 'policy.rego'),
      'package p\n\nallow if input.nosuch == "x"\n',
    );
    await writeFile(join(dir, 'bundle', '.manifest'), '{"roots": ["other"]}');
    const s = server();

    const withData = await callTool(s, 'rego_check_schema', {
      paths: [join(dir, 'policy.rego'), join(dir, 'data.json')],
      schemaPath: join(dir, 'schemas'),
    });
    expect(withData.error?.code).toBe('INVALID_INPUT');
    expect(withData.error?.message).toMatch(/carries none/);

    const badManifest = await callTool(s, 'rego_check_schema', {
      paths: [join(dir, 'bundle')],
      schemaPath: join(dir, 'schemas'),
    });
    expect(badManifest.error?.code).toBe('INVALID_INPUT');
    expect(badManifest.error?.message).toMatch(/could not read the annotations/);
  });

  it('rego_check_schema warns when the schema lets unknown fields through, as opa judges it', async () => {
    const s = server();
    const source = 'package p\n\nallow if input.anything == "x"\n';
    for (const inlineSchema of [
      { type: 'object' },
      { oneOf: [{ type: 'object', properties: { kind: { type: 'string' } } }] },
      { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
    ]) {
      const env = await callTool<{ valid: boolean }>(s, 'rego_check_schema', {
        source,
        inlineSchema,
      });
      expect(env.data?.valid, JSON.stringify(inlineSchema)).toBe(true);
      expect(env.warnings?.[0], JSON.stringify(inlineSchema)).toMatch(/does not name/);
    }
    const typed = await callTool<{ valid: boolean }>(s, 'rego_check_schema', {
      source: 'package p\n\nallow if startswith(input, "a")\n',
      inlineSchema: { type: 'string' },
    });
    expect(typed.data?.valid).toBe(true);
    expect(typed.warnings).toBeUndefined();
  });

  it("rego_policy_diff passes on opa's error for the side that failed", async () => {
    const s = makeServer();
    registerHelperTools(s, config);
    const env = await callTool(s, 'rego_policy_diff', {
      query: 'data.legacy.deny',
      sourceA: V0_POLICY,
      sourceB: 'package legacy\n\ndeny contains "mallory is blocked" if input.user == "mallory"\n',
      input: { user: 'mallory' },
    });
    expect(env.error?.code).toBe('INVALID_REGO');
    expect(env.error?.message).toBe('Policy A failed to evaluate.');
    expect(env.error?.hint).toMatch(/v0CompatibleA/);
    const details = env.error?.details as { errors?: Array<{ message?: string }> };
    expect(details.errors?.[0]?.message).toMatch(/`if` keyword is required/);
  });
});

describe('rego_eval without a policy', () => {
  it('evaluates a built-in on its own', async () => {
    const env = await callTool<EvalOut>(server(), 'rego_eval', {
      query: 'regex.match(`^prod-`, "prod-api")',
    });
    expect(env.ok).toBe(true);
    expect(valueOf(env.data)).toBe(true);
  });

  it('treats an empty source as no policy', async () => {
    const env = await callTool<EvalOut>(server(), 'rego_eval', { query: '1 + 1', source: '' });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(valueOf(env.data)).toBe(2);
  });

  it('flags a data query that had nothing to read', async () => {
    const env = await callTool<EvalOut>(server(), 'rego_eval', { query: 'data.legacy.allow' });
    expect(env.ok).toBe(true);
    expect(env.data?.result).toBeUndefined();
    expect(env.data?.hint).toMatch(/No policy or data was loaded/);
  });
});

describe('rego_eval with inputs', () => {
  it('evaluates each input and reports each one, in order', async () => {
    const env = await callTool<{
      batch: Array<{ index: number; result?: Array<{ expressions: Array<{ value: unknown }> }> }>;
      errorCount: number;
    }>(server(), 'rego_eval', {
      query: 'data.legacy.allow',
      source: V0_POLICY,
      v0Compatible: true,
      inputs: [
        { role: 'admin', user: 'alice' },
        { role: 'admin', user: 'mallory' },
        { role: 'viewer', user: 'bob' },
        { role: 'admin', user: 'carol' },
        { role: 'admin', user: 'dave' },
      ],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.errorCount).toBe(0);
    expect(env.data?.batch.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
    expect(env.data?.batch.map((e) => e.result?.[0]?.expressions[0]?.value)).toEqual([
      true,
      false,
      false,
      true,
      true,
    ]);
  });

  it('reports an input that raises a runtime error without failing the others', async () => {
    // Two values for one complete rule: a conflict error for that input only.
    const conflicting = `package c
import rego.v1

v := input.a if input.a
v := input.b if input.b
`;
    const env = await callTool<{
      batch: Array<{ result?: unknown[]; error?: { code: string } }>;
      errorCount: number;
    }>(server(), 'rego_eval', {
      query: 'data.c.v',
      source: conflicting,
      inputs: [{ a: 1 }, { a: 1, b: 2 }, { b: 3 }],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.errorCount).toBe(1);
    expect(env.data?.batch[1]?.error?.code).toBe('EVAL_ERROR');
    expect(env.data?.batch[0]?.result).toHaveLength(1);
    expect(env.data?.batch[2]?.result).toHaveLength(1);
  });

  it('fails the call once for a policy that does not compile', async () => {
    const env = await callTool(server(), 'rego_eval', {
      query: 'data.p.allow',
      source: 'package p\n\nallow if {\n',
      inputs: [{ a: 1 }, { a: 2 }, { a: 3 }],
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_REGO');
  });

  it('fails the call once for data that does not load', async () => {
    const bad = join(workDir, 'bad.json');
    await writeFile(bad, '{bad');
    const env = await callTool(server(), 'rego_eval', {
      query: 'data',
      paths: [bad],
      inputs: [{ a: 1 }, { a: 2 }, { a: 3 }],
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('EVAL_ERROR');
  });

  it('refuses a partial evaluation of each input with nothing named unknown', async () => {
    const env = await callTool(server(), 'rego_eval', {
      query: 'data.legacy.allow',
      source: V0_POLICY,
      v0Compatible: true,
      partial: true,
      inputs: [{ role: 'admin' }, { role: 'viewer' }],
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('returns the residual of a partial evaluation for each input', async () => {
    const env = await callTool<{ batch: Array<{ partial?: { queries?: unknown[] } }> }>(
      server(),
      'rego_eval',
      {
        query: 'data.p.allow',
        source: 'package p\n\nallow if {\n\tinput.role == "admin"\n\tinput.region == "eu"\n}\n',
        partial: true,
        unknowns: ['input.region'],
        inputs: [{ role: 'admin' }, { role: 'viewer' }],
      },
    );
    expect(env.ok).toBe(true);
    // The admin keeps a residual on region; the viewer's is empty.
    expect(env.data?.batch[0]?.partial?.queries?.length).toBe(1);
    expect(env.data?.batch[1]?.partial?.queries ?? []).toHaveLength(0);
  });
});
