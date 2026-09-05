/**
 * Integration tests for paths on a different drive from the working
 * directory, run against the real binaries. Windows only.
 *
 * OPA's loader reads every path as an optional `prefix:path` pair split on
 * the first colon, so an absolute Windows path loses its drive letter and the
 * remainder is resolved against the drive the child is running on. A module
 * still mounts at its own `package`, but it is opened the same way, and
 * conftest opens its policy directory and configs through the same loader.
 * On a machine where everything sits on one drive that always works. A CI
 * runner that keeps its workspace on one drive and its temp directory on
 * another is exactly where it does not.
 *
 * A second drive is simulated with `subst`, which maps a free drive letter to
 * a directory without privileges. The tests are skipped when no letter is
 * free. The first case keeps the working directory where the tests run and
 * puts the module on the substituted drive. The second moves the working
 * directory onto the substituted drive, so the temp files the server writes
 * for inline input land on the other one, which is the runner's layout.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerAuthoringTools } from '../../src/tools/authoring/index.js';
import { registerConftestTools } from '../../src/tools/conftest/index.js';
import { registerEvaluationTools } from '../../src/tools/evaluation/index.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

const WINDOWS = process.platform === 'win32';
/** The Windows file-not-found OPA reports when it opens a path on the wrong drive. */
const LOAD_ERROR = 'GetFileAttributesEx';

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
    regalBinary: process.env['REGAL_BINARY'] ?? 'regal',
    conftestBinary: process.env['CONFTEST_BINARY'] ?? 'conftest',
    subprocessTimeoutMs: 60_000,
    httpTimeoutMs: 15_000,
    // The allow-list holds both spellings of the same directory: the drive
    // the module is reached through, and the temp directory itself.
    allowedPaths: letter !== undefined ? [`${letter}:\\`, workDir] : [workDir],
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

describe('temp files on a drive other than the working directory', () => {
  let originalCwd: string | undefined;

  // The tests run in their own process, so moving it onto the substituted
  // drive affects nothing else. Every temp file the server writes for inline
  // input then sits on the system drive, away from the working directory.
  beforeAll(() => {
    if (!WINDOWS || !mapped || letter === undefined) return;
    originalCwd = process.cwd();
    process.chdir(`${letter}:\\`);
  });

  afterAll(() => {
    if (originalCwd !== undefined) process.chdir(originalCwd);
  });

  it.runIf(WINDOWS)(
    'checks an inline module',
    async (ctx) => {
      if (!mapped || letter === undefined) ctx.skip('no free drive letter to substitute');
      const server = makeServer();
      registerAuthoringTools(server, config);
      const env = await callTool<{ errors?: unknown[] }>(server, 'rego_check', {
        source: 'package p\n\nimport rego.v1\n\nallow := true\n',
      });
      const text = JSON.stringify(env);
      expect(text).not.toContain(LOAD_ERROR);
      expect(env.ok, text).toBe(true);
      expect(env.data?.errors ?? []).toHaveLength(0);
    },
    60_000,
  );

  it.runIf(WINDOWS)(
    'inspects a module by its absolute path',
    async (ctx) => {
      if (!mapped || letter === undefined) ctx.skip('no free drive letter to substitute');
      const server = makeServer();
      registerAuthoringTools(server, config);
      const env = await callTool<Record<string, unknown>>(server, 'rego_inspect', {
        target: join(workDir, 'p.rego'),
      });
      const text = JSON.stringify(env);
      expect(text).not.toContain(LOAD_ERROR);
      expect(env.ok, text).toBe(true);
    },
    60_000,
  );

  it.runIf(WINDOWS)(
    'tests an inline config against an inline policy',
    async (ctx) => {
      if (!mapped || letter === undefined) ctx.skip('no free drive letter to substitute');
      const server = makeServer();
      registerConftestTools(server, config);
      const env = await callTool<Record<string, unknown>>(server, 'conftest_test', {
        inlineConfig: 'kind: Deployment\n',
        inlineConfigParser: 'yaml',
        inlinePolicy:
          'package main\n\nimport rego.v1\n\ndeny contains msg if {\n\tinput.kind == "Pod"\n\tmsg := "no pods"\n}\n',
      });
      const text = JSON.stringify(env);
      expect(text).not.toContain(LOAD_ERROR);
      expect(env.ok, text).toBe(true);
    },
    60_000,
  );
});
