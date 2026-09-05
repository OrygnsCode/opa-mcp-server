/**
 * Integration test for a Rego module on a different drive from the server's
 * working directory, run against the real OPA binary. Windows only.
 *
 * OPA reads every load path as an optional `prefix:path` pair split on the
 * first colon. A module still mounts at its own `package`, which is why the
 * drive-letter fix left modules absolute, but OPA opens the module by the
 * remainder after the colon, a root-relative path resolved against the drive
 * the child is running on. On a machine where everything sits on one drive
 * that always works. A CI runner that keeps its workspace on one drive and its
 * temp directory on another is exactly where it does not, and every module
 * under the temp directory failed to open with a Windows file-not-found.
 *
 * A second drive is simulated with `subst`, which maps a free drive letter to
 * a directory without privileges. The test is skipped when no letter is free.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

const WINDOWS = process.platform === 'win32';

/** A drive letter with nothing behind it, or undefined when none is free. */
function freeDriveLetter(): string | undefined {
  for (const letter of ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'Y']) {
    if (!existsSync(`${letter}:\\`)) return letter;
  }
  return undefined;
}

function subst(args: string[]): boolean {
  const r = spawnSync('cmd', ['/c', 'subst', ...args], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

let workDir: string;
let letter: string | undefined;
let mapped = false;
let config: Config;

beforeAll(async () => {
  if (!WINDOWS) return;
  workDir = await mkdtemp(join(tmpdir(), 'orygn-cross-drive-'));
  await writeFile(
    join(workDir, 'p.rego'),
    'package p\n\nimport rego.v1\n\nallow := true\n',
    'utf8',
  );
  letter = freeDriveLetter();
  if (letter !== undefined) mapped = subst([`${letter}:`, workDir]);

  config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: process.env['OPA_BINARY'] ?? 'opa',
    regalBinary: 'regal',
    conftestBinary: 'conftest',
    subprocessTimeoutMs: 60_000,
    httpTimeoutMs: 15_000,
    // The allow-list holds the drive the module is reached through.
    allowedPaths: letter !== undefined ? [`${letter}:\\`] : [],
    logFile: join(workDir, 'server.log'),
    logLevel: 'error',
    maxResponseBytes: 100_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
});

afterAll(async () => {
  if (mapped && letter !== undefined) subst([`${letter}:`, '/D']);
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('a module on a drive other than the working directory', () => {
  it.runIf(WINDOWS)(
    'is evaluated rather than reported missing',
    async (ctx) => {
      if (!mapped || letter === undefined) ctx.skip('no free drive letter to substitute');
      // The server's own working directory is wherever the tests run, on the
      // system drive; the module sits on the substituted one.
      const modulePath = `${letter}:\\p.rego`;
      expect(existsSync(modulePath)).toBe(true);

      const server = makeServer();
      registerEvaluationTools(server, config);
      const env = await callTool<{ result: unknown }>(server, 'rego_eval', {
        query: 'data.p.allow',
        paths: [modulePath],
      });

      expect(env.ok, JSON.stringify(env.error)).toBe(true);
      const value = (env.data?.result as Array<{ expressions: Array<{ value: unknown }> }>)?.[0]
        ?.expressions?.[0]?.value;
      expect(value).toBe(true);
    },
    60_000,
  );
});
