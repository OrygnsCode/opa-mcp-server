/**
 * The generated skeleton has to compile against the policy it was generated
 * for, whatever kinds of rules the policy holds. A function rule referenced
 * without arguments used to fail the whole test file, and a set rule got a
 * boolean comparison. Run against the real OPA binary.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerRegoGenerateTestSkeleton } from '../../src/tools/helpers/generate-test-skeleton.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

const OPA = process.env['OPA_BINARY'] ?? 'opa';

const POLICY = [
  'package authz',
  '',
  'import rego.v1',
  '',
  'default allow := false',
  '',
  'allow if input.role == "admin"',
  '',
  'deny contains msg if {',
  '\tinput.role == "guest"',
  '\tmsg := "guests may not write"',
  '}',
  '',
  'perms[input.user] := "read" if input.role == "viewer"',
  '',
  'is_owner(user) if user == input.owner',
  '',
  'label := "prod" if input.env == "prod"',
  '',
].join('\n');

let workDir: string;
let config: Config;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-skeleton-'));
  config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: OPA,
    regalBinary: 'regal',
    conftestBinary: 'conftest',
    subprocessTimeoutMs: 30_000,
    httpTimeoutMs: 15_000,
    allowedPaths: [],
    logFile: join(workDir, 'server.log'),
    logLevel: 'error',
    maxResponseBytes: 100_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function compiles(testFile: string): Promise<{ ok: boolean; output: string }> {
  await writeFile(join(workDir, 'authz.rego'), POLICY, 'utf8');
  await writeFile(join(workDir, 'authz_test.rego'), testFile, 'utf8');
  const r = spawnSync(OPA, ['check', '--strict', 'authz.rego', 'authz_test.rego'], {
    cwd: workDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ok: r.status === 0, output: (r.stderr + r.stdout).trim() };
}

describe('rego_generate_test_skeleton output compiles', () => {
  for (const tableStyle of [false, true]) {
    it(`for boolean, set, object, function and value rules (tableStyle: ${tableStyle})`, async () => {
      const server = makeServer();
      registerRegoGenerateTestSkeleton(server, config);
      const env = await callTool<{ testFile: string; ruleNames: string[] }>(
        server,
        'rego_generate_test_skeleton',
        { source: POLICY, tableStyle },
      );
      expect(env.ok, JSON.stringify(env.error)).toBe(true);
      expect(env.data?.ruleNames).toEqual(
        expect.arrayContaining(['allow', 'deny', 'perms', 'is_owner', 'label']),
      );
      const file = env.data!.testFile;
      // The function is called, not referenced bare, and the set is not
      // compared to a boolean.
      expect(file).toMatch(/data\.authz\.is_owner\(null\)/);
      expect(file).toMatch(/deny with input as[\s\S]*?(set\(\)|actual == tc\.expected)/);
      const result = await compiles(file);
      expect(
        result.ok,
        `${result.output}

${file}`,
      ).toBe(true);
    }, 30_000);
  }
});
