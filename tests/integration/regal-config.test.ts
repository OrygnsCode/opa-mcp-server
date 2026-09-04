/**
 * Real-binary tests for how regal finds its configuration.
 *
 * Regal locates `.regal/config.yaml` by walking up from its own working
 * directory, never from the files it is asked to lint. Spawned without one it
 * inherited this server's, which for a stdio server is wherever the client
 * launched it. Two consequences, both verified against regal 0.30.0 before
 * being asserted: a project's own configuration was ignored, and a
 * configuration sitting above the server's directory was applied to every
 * call, including inline source that belongs to no project.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerAuthoringTools } from '../../src/tools/authoring/index.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

const REGAL = process.env['REGAL_BINARY'] ?? 'regal';

/** A rule regal reports unless configuration turns it off. */
const CAMEL_POLICY = 'package q\n\nallowThing if true\n';

/** Turns off the two rules the fixture would otherwise trip. */
const CONFIG = `rules:
  style:
    prefer-snake-case:
      level: ignore
    opa-fmt:
      level: ignore
`;

interface LintOutput {
  violations?: Array<{ title?: string }>;
}

let available = false;
let workDir: string;
let projectDir: string;
let server: ReturnType<typeof makeServer>;

const titles = (env: { data?: LintOutput }): string[] =>
  (env.data?.violations ?? []).map((v) => v.title ?? '');

beforeAll(async () => {
  const v = spawnSync(REGAL, ['version'], { encoding: 'utf8', windowsHide: true });
  available = v.status === 0;

  workDir = await mkdtemp(join(tmpdir(), 'orygn-regal-config-'));
  projectDir = join(workDir, 'project');
  await mkdir(join(projectDir, '.regal'), { recursive: true });
  await writeFile(join(projectDir, '.regal', 'config.yaml'), CONFIG);
  await writeFile(join(projectDir, 'camel.rego'), CAMEL_POLICY);

  const config: Config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: process.env['OPA_BINARY'] ?? 'opa',
    regalBinary: REGAL,
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
  registerAuthoringTools(server, config);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('rego_lint honours the linted project configuration', () => {
  it('applies a .regal config that sits beside the linted file', async (ctx) => {
    if (!available) ctx.skip('regal not available');
    const env = await callTool<LintOutput>(server, 'rego_lint', {
      paths: [join(projectDir, 'camel.rego')],
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    // Both are set to ignore in the project's own configuration.
    expect(titles(env)).not.toContain('prefer-snake-case');
    expect(titles(env)).not.toContain('opa-fmt');
  });

  it('applies it when the whole directory is linted', async (ctx) => {
    if (!available) ctx.skip('regal not available');
    const env = await callTool<LintOutput>(server, 'rego_lint', { paths: [projectDir] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(titles(env)).not.toContain('prefer-snake-case');
  });

  it('still reports rules the configuration does not turn off', async (ctx) => {
    if (!available) ctx.skip('regal not available');
    // The point is that configuration is read, not that everything is muted.
    const env = await callTool<LintOutput>(server, 'rego_lint', { paths: [projectDir] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(titles(env).length).toBeGreaterThan(0);
  });

  it('does not apply a configuration from outside the linted tree to inline source', async (ctx) => {
    if (!available) ctx.skip('regal not available');
    // Inline source belongs to no project. It must not silently inherit
    // whatever configuration happens to sit above the server's directory.
    const env = await callTool<LintOutput>(server, 'rego_lint', { source: CAMEL_POLICY });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(titles(env)).toContain('prefer-snake-case');
  });

  it('an explicit configFile still wins', async (ctx) => {
    if (!available) ctx.skip('regal not available');
    const other = join(workDir, 'other.yaml');
    await writeFile(other, CONFIG);
    const env = await callTool<LintOutput>(server, 'rego_lint', {
      source: CAMEL_POLICY,
      configFile: other,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(titles(env)).not.toContain('prefer-snake-case');
  });
});
