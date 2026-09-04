/**
 * Real-binary tests that data files load where the policy expects them.
 *
 * OPA reads every path argument as an optional `prefix:path` and splits on the
 * first colon. Every absolute Windows path starts with one, so a data file
 * passed by absolute path mounted under `data.C` and the policy saw nothing,
 * while the tool reported success. `.rego` files were unaffected, because a
 * module mounts at its `package`, which is why only data was silently wrong.
 *
 * These assertions hold on every platform. On POSIX they passed before the fix
 * as well; on Windows they did not, which is exactly what makes them a useful
 * guard rather than a platform-specific one.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import type { RegoTestOutput } from '../../src/tools/evaluation/test.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

interface EvalOutput {
  result?: unknown;
}

let workDir: string;
let server: ReturnType<typeof makeServer>;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-data-loading-'));

  // A data document at the bundle root, and one nested so it mounts at
  // data.cfg. Both are the shapes a policy repository actually uses.
  await writeFile(join(workDir, 'data.json'), JSON.stringify({ tier: 'gold' }));
  await mkdir(join(workDir, 'cfg'), { recursive: true });
  await writeFile(join(workDir, 'cfg', 'data.json'), JSON.stringify({ region: 'eu' }));

  await writeFile(
    join(workDir, 'policy.rego'),
    'package p\n\nis_gold if data.tier == "gold"\n\nin_eu if data.cfg.region == "eu"\n',
  );
  await writeFile(
    join(workDir, 'policy_test.rego'),
    'package p\n\ntest_is_gold if is_gold\n\ntest_in_eu if in_eu\n',
  );

  const config: Config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: process.env['OPA_BINARY'] ?? 'opa',
    regalBinary: 'regal',
    conftestBinary: 'conftest',
    subprocessTimeoutMs: 30_000,
    httpTimeoutMs: 15_000,
    allowedPaths: [workDir],
    logFile: join(workDir, 'server.log'),
    logLevel: 'error',
    maxResponseBytes: 200_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
  server = makeServer();
  registerEvaluationTools(server, config);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('data files load where the policy expects them', () => {
  it('mounts a root data document at the root, not under the drive letter', async () => {
    const env = await callTool<EvalOutput>(server, 'rego_eval', {
      query: 'data.tier',
      paths: [join(workDir, 'data.json')],
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(JSON.stringify(env.data)).toContain('gold');
  });

  it('lets a policy read a root data document passed by absolute path', async () => {
    const env = await callTool<EvalOutput>(server, 'rego_eval', {
      query: 'data.p.is_gold',
      paths: [join(workDir, 'data.json'), join(workDir, 'policy.rego')],
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(JSON.stringify(env.data)).toContain('true');
  });

  it('mounts a nested data document at its directory path', async () => {
    const env = await callTool<EvalOutput>(server, 'rego_eval', {
      query: 'data.p.in_eu',
      paths: [workDir],
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(JSON.stringify(env.data)).toContain('true');
  });

  it('does not leave a drive letter in the loaded data tree', async () => {
    const env = await callTool<EvalOutput>(server, 'rego_eval', {
      query: 'data',
      paths: [workDir],
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    const tree = JSON.stringify(env.data);
    // A single upper-case letter key is what a mis-loaded drive path produces.
    expect(tree).not.toMatch(/"[A-Z]":\s*\{/);
    expect(tree).toContain('gold');
  });

  it('runs tests that read data, passing the suite directory by absolute path', async () => {
    const env = await callTool<RegoTestOutput>(server, 'rego_test', { paths: [workDir] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data).toMatchObject({ total: 2, passed: 2, failed: 0 });
  });

  it('still evaluates inline source with no paths at all', async () => {
    const env = await callTool<EvalOutput>(server, 'rego_eval', {
      query: 'data.x.ok',
      source: 'package x\n\nok if true\n',
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(JSON.stringify(env.data)).toContain('true');
  });
});
