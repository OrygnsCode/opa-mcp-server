/**
 * `opa_exec` with `dataPaths`, against the real OPA binary.
 *
 * `opa exec` loads policy only through `--bundle`, which takes an archive or a
 * bundle directory. A `.rego` file passed there fails as "gzip: invalid
 * header", two plain directories fail as bundles with overlapping roots, and a
 * data file not named data.json is skipped. The tool builds plain paths into
 * one bundle first so they load as `opa eval --data` would load them.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

interface ExecOutput {
  results: Array<{ path: string; result?: unknown; error?: { code: string } }>;
}

let work: string;
let config: Config;
const p = (...parts: string[]) => join(work, ...parts);

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'orygn-exec-data-paths-'));
  await mkdir(p('policy'), { recursive: true });
  await mkdir(p('data'), { recursive: true });
  await mkdir(p('inputs'), { recursive: true });
  await writeFile(
    p('policy', 'authz.rego'),
    'package authz\n\nimport rego.v1\n\ndefault allow := false\n\nallow if input.user in data.admins\n',
  );
  // Not named data.json: a bundle would skip it, `opa eval --data` loads it.
  await writeFile(p('data', 'admins.json'), '{"admins": ["alice"]}');
  await writeFile(p('conflict.json'), '{"admins": ["mallory"]}');
  await writeFile(p('inputs', 'alice.json'), '{"user": "alice"}');
  await writeFile(p('inputs', 'bob.json'), '{"user": "bob"}');
  await writeFile(p('legacy.rego'), 'package authz\n\nallow {\n\tinput.user == "alice"\n}\n');

  config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: process.env['OPA_BINARY'] ?? 'opa',
    regalBinary: 'regal',
    conftestBinary: 'conftest',
    subprocessTimeoutMs: 60_000,
    httpTimeoutMs: 15_000,
    allowedPaths: [work],
    logFile: p('server.log'),
    logLevel: 'error',
    maxResponseBytes: 100_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

const exec = (args: Record<string, unknown>) => {
  const server = makeServer();
  registerEvaluationTools(server, config);
  return callTool<ExecOutput>(server, 'opa_exec', {
    inputPaths: [p('inputs')],
    decision: 'authz/allow',
    ...args,
  });
};

/** Each input file's decision, keyed by file name. */
const decisions = (out: ExecOutput | undefined): Record<string, unknown> =>
  Object.fromEntries(
    (out?.results ?? []).map((r): [string, unknown] => [
      r.path.replace(/\\/g, '/').split('/').pop() ?? r.path,
      r.result,
    ]),
  );

describe('opa_exec dataPaths', () => {
  it('loads a policy file and a data file, as opa eval --data would', async () => {
    const env = await exec({ dataPaths: [p('policy', 'authz.rego'), p('data', 'admins.json')] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(decisions(env.data)).toEqual({ 'alice.json': true, 'bob.json': false });
  });

  it('loads two plain directories together', async () => {
    const env = await exec({ dataPaths: [p('policy'), p('data')] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(decisions(env.data)).toEqual({ 'alice.json': true, 'bob.json': false });
  });

  it('still loads a bundle archive as a bundle', async () => {
    const archive = p('bundle.tar.gz');
    execFileSync(config.opaBinary, [
      'build',
      '-o',
      archive,
      p('policy', 'authz.rego'),
      p('data', 'admins.json'),
    ]);
    const env = await exec({ dataPaths: [archive] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(decisions(env.data)).toEqual({ 'alice.json': true, 'bob.json': false });
  });

  it('refuses a bundle mixed with plain paths', async () => {
    const env = await exec({ dataPaths: [p('bundle.tar.gz'), p('data', 'admins.json')] });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('says why when two data files set the same key', async () => {
    const env = await exec({
      dataPaths: [p('policy'), p('data', 'admins.json'), p('conflict.json')],
    });
    expect(env.error?.code).toBe('INVALID_REGO');
    expect(env.error?.message).toMatch(/merge error/);
  });

  it('builds and runs a v0 policy file with v0Compatible', async () => {
    const env = await exec({ dataPaths: [p('legacy.rego')], v0Compatible: true });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(decisions(env.data)['alice.json']).toBe(true);
  });
});
