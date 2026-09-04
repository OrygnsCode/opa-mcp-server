/**
 * Real-binary tests for the conftest tools, driven through the registered
 * handlers the way the server runs them.
 *
 * conftest marks every array in its JSON output `omitempty`, so a file that
 * passes cleanly arrives with no `failures` key at all, and `verify` with no
 * test rules prints the literal `null`. Mocked tests written from the type
 * definitions never see either shape; these do.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerConftestTools } from '../../src/tools/conftest/index.js';
import type { ConftestTestOutput } from '../../src/tools/conftest/test.js';
import type { ConftestVerifyOutput } from '../../src/tools/conftest/verify.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

const CONFTEST = process.env['CONFTEST_BINARY'] ?? 'conftest';

const MAIN_POLICY = `package main

deny contains msg if {
	input.kind == "Bad"
	msg := "bad kind"
}

warn contains msg if {
	input.warnme == true
	msg := "just a warning"
}
`;

const EXTRA_POLICY = `package extra

deny contains "extra says no" if input.extra == "no"
`;

const MAIN_TESTS = `package main

test_deny_bad if {
	deny["bad kind"] with input as {"kind": "Bad"}
}

test_that_fails if {
	deny["nope"] with input as {"kind": "Good"}
}
`;

const PASSING_TESTS = `package main

test_deny_bad if {
	deny["bad kind"] with input as {"kind": "Bad"}
}
`;

const DOCKERFILE_POLICY = `package main

deny contains msg if {
	some i
	input[i].Cmd == "from"
	endswith(input[i].Value[0], ":latest")
	msg := "image uses the latest tag"
}
`;

let available = false;
let workDir: string;
let policyDir: string;
let passingPolicyDir: string;
let noTestsPolicyDir: string;
let server: ReturnType<typeof makeServer>;

const test = (input: Record<string, unknown>) =>
  callTool<ConftestTestOutput>(server, 'conftest_test', input);
const verify = (input: Record<string, unknown>) =>
  callTool<ConftestVerifyOutput>(server, 'conftest_verify', input);

beforeAll(async () => {
  const v = spawnSync(CONFTEST, ['--version'], { encoding: 'utf8', windowsHide: true });
  available = v.status === 0;

  workDir = await realpath(await mkdtemp(join(tmpdir(), 'orygn-conftest-tools-')));
  policyDir = join(workDir, 'policy');
  passingPolicyDir = join(workDir, 'policy-passing');
  noTestsPolicyDir = join(workDir, 'policy-no-tests');
  for (const d of [policyDir, passingPolicyDir, noTestsPolicyDir, join(workDir, 'cfg')]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(policyDir, 'main.rego'), MAIN_POLICY);
  await writeFile(join(policyDir, 'extra.rego'), EXTRA_POLICY);
  await writeFile(join(policyDir, 'main_test.rego'), MAIN_TESTS);
  await writeFile(join(passingPolicyDir, 'main.rego'), MAIN_POLICY);
  await writeFile(join(passingPolicyDir, 'main_test.rego'), PASSING_TESTS);
  await writeFile(join(noTestsPolicyDir, 'main.rego'), MAIN_POLICY);
  await writeFile(join(workDir, 'cfg', 'good.yaml'), 'kind: Good\n');
  await writeFile(join(workDir, 'cfg', 'bad.yaml'), 'kind: Bad\n');
  await writeFile(join(workDir, 'cfg', 'warn.yaml'), 'kind: Good\nwarnme: true\n');
  await writeFile(join(workDir, 'cfg', 'extra-no.yaml'), 'kind: Good\nextra: "no"\n');

  const config: Config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: process.env['OPA_BINARY'] ?? 'opa',
    regalBinary: 'regal',
    conftestBinary: CONFTEST,
    subprocessTimeoutMs: 30_000,
    httpTimeoutMs: 15_000,
    allowedPaths: [workDir],
    logFile: join(workDir, 'server.log'),
    logLevel: 'error',
    maxResponseBytes: 100_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
  server = makeServer();
  registerConftestTools(server, config);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('conftest_test against the real conftest', () => {
  it('summarises a passing file, whose result carries no array fields at all', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await test({ files: [join(workDir, 'cfg', 'good.yaml')], policy: policyDir });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.passed).toBe(true);
    expect(env.data?.results[0]?.failures).toEqual([]);
    expect(env.data?.results[0]?.warnings).toEqual([]);
    expect(env.data?.results[0]?.successes).toBeGreaterThan(0);
    expect(env.data?.summary).toMatchObject({ passed: 1, failed: 0, warnings: 0, failures: 0 });
  });

  it('reports a failing file with its message', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await test({ files: [join(workDir, 'cfg', 'bad.yaml')], policy: policyDir });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.passed).toBe(false);
    expect(env.data?.results[0]?.failures[0]?.msg).toBe('bad kind');
    expect(env.data?.summary).toMatchObject({ passed: 0, failed: 1, failures: 1 });
  });

  it('reports a warning without failing, unless failOnWarn is set', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const file = join(workDir, 'cfg', 'warn.yaml');
    const soft = await test({ files: [file], policy: policyDir });
    expect(soft.ok, JSON.stringify(soft.error)).toBe(true);
    expect(soft.data?.passed).toBe(true);
    expect(soft.data?.summary.warnings).toBe(1);
    const hard = await test({ files: [file], policy: policyDir, failOnWarn: true });
    expect(hard.ok, JSON.stringify(hard.error)).toBe(true);
    expect(hard.data?.passed).toBe(false);
  });

  it('counts a file once across namespaces', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await test({
      files: [join(workDir, 'cfg', 'extra-no.yaml'), join(workDir, 'cfg', 'good.yaml')],
      policy: policyDir,
      allNamespaces: true,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    // extra-no.yaml passes main and fails extra: one failed file. good.yaml
    // passes both: one passed file. Four entries in results, two files.
    expect(env.data?.results).toHaveLength(4);
    expect(env.data?.summary).toMatchObject({ passed: 1, failed: 1 });
  });

  it('evaluates inline YAML with the default parser', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await test({ inlineConfig: 'kind: Bad\n', policy: policyDir });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.passed).toBe(false);
    expect(env.data?.results[0]?.filename).toBe('<inline>');
  });

  it('evaluates inline JSON when told the parser', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await test({
      inlineConfig: '{"kind": "Bad"}',
      inlineConfigParser: 'json',
      policy: policyDir,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.passed).toBe(false);
  });

  it('evaluates an inline Dockerfile with an inline policy', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await test({
      inlineConfig: 'FROM alpine:latest\nRUN echo hi\n',
      inlineConfigParser: 'dockerfile',
      inlinePolicy: DOCKERFILE_POLICY,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.passed).toBe(false);
    expect(env.data?.results[0]?.failures[0]?.msg).toMatch(/latest tag/);
  });

  it('evaluates inline HCL2', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await test({
      inlineConfig: 'kind = "Bad"\n',
      inlineConfigParser: 'hcl2',
      policy: policyDir,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.passed).toBe(false);
  });

  it('rejects a parser name outside the closed set before creating any temp file', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('orygn-conftest-'));
    const env = await test({
      inlineConfig: 'kind: Good\n',
      inlineConfigParser: '../../../escaped',
      policy: policyDir,
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
    const after = (await readdir(tmpdir())).filter((n) => n.startsWith('orygn-conftest-'));
    expect(after.length).toBe(before.length);
    expect(existsSync(join(tmpdir(), '..', '..', 'escaped'))).toBe(false);
  });

  it("returns UNKNOWN_ERROR with conftest's message for a policy that does not compile", async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await test({
      inlineConfig: 'kind: Good\n',
      inlinePolicy: 'package main\n\ndeny if {\n',
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });
});

describe('conftest_verify against the real conftest', () => {
  it('reports one passing and one failing test rule in a single file', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await verify({ policy: policyDir });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.passed).toBe(false);
    // conftest emits one entry per rule, both naming the same file.
    expect(env.data?.results).toHaveLength(2);
    expect(env.data?.summary).toEqual({ passed: 0, failed: 1, totalPassed: 1, totalFailed: 1 });
  });

  it('passes when every test rule passes', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await verify({ policy: passingPolicyDir });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.passed).toBe(true);
    expect(env.data?.summary).toEqual({ passed: 1, failed: 0, totalPassed: 1, totalFailed: 0 });
  });

  it('reports NO_TESTS_FOUND when the directory holds no test rules', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await verify({ policy: noTestsPolicyDir });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('NO_TESTS_FOUND');
  });
});

describe('conftest_pull writes where it was told', () => {
  // conftest resolves --policy against the working directory instead of
  // honouring an absolute path. The tools resolve the caller's path against the
  // allow-list first, so it is always absolute: on Windows the pull failed with
  // a path of the form `.\\C:\\...`, and push read from the same path on
  // whichever drive it happened to start on.
  const URL = 'github.com/open-policy-agent/conftest//examples/kubernetes/policy';

  it('pulls into the directory that was asked for', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const dest = join(workDir, 'pulled');
    const env = await callTool<{ policyDir: string }>(server, 'conftest_pull', {
      url: URL,
      policy: dest,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.policyDir).toBe(dest);

    const files = await readdir(dest);
    expect(files.some((f) => f.endsWith('.rego'))).toBe(true);
  }, 120_000);

  it('creates a missing parent rather than failing', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const dest = join(workDir, 'nested', 'deeper', 'pulled');
    const env = await callTool<{ policyDir: string }>(server, 'conftest_pull', {
      url: URL,
      policy: dest,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect((await readdir(dest)).some((f) => f.endsWith('.rego'))).toBe(true);
  }, 120_000);

  it('refuses a destination outside the allowed roots', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await callTool(server, 'conftest_pull', {
      url: URL,
      policy: join(tmpdir(), 'orygn-not-allowed'),
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  }, 60_000);

  it('refuses the implicit default when it is outside the allowed roots', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    // Omitting `policy` used to mean conftest's own default, resolved against
    // the server's working directory, and the pull wrote there unchecked. The
    // tool documents that the policy directory must sit inside an allowed root;
    // that has to hold for the implicit one too.
    const env = await callTool(server, 'conftest_pull', { url: URL });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(env.error?.hint).toContain('OPA_MCP_ALLOWED_PATHS');
  }, 60_000);
});

describe('conftest_push resolves its policy directory', () => {
  it('refuses the implicit default when it is outside the allowed roots', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    const env = await callTool(server, 'conftest_push', { repository: '127.0.0.1:1/nope:v1' });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  }, 60_000);

  it('reads the directory it was given, not one on the current drive', async (ctx) => {
    if (!available) ctx.skip('conftest not available');
    // No registry is reachable, so this fails at the network. Reaching the
    // network at all proves the policy directory was found and packaged; a
    // mangled path fails earlier with a load error naming the wrong location.
    const env = await callTool(server, 'conftest_push', {
      repository: '127.0.0.1:1/nope:v1',
      policy: passingPolicyDir,
    });
    expect(env.ok).toBe(false);
    const detail = JSON.stringify(env.error);
    expect(detail).not.toContain('loading policies');
    expect(detail).toMatch(/dial tcp|connect|refused|no such host/i);
  }, 60_000);
});
