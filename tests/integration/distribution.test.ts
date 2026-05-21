/**
 * Build & distribution smoke tests.
 *
 * Verifies the artifacts users actually consume:
 *   1. The npm tarball contents (no source, no tests, no .github)
 *   2. The compiled dist/ tree boots and serves the MCP protocol
 *      end-to-end via stdio — exercises src/server.ts which the
 *      regular suite cannot reach without spawning a real process
 *
 * The Docker build is heavy (~minutes for multi-arch) and gated
 * behind OPA_MCP_DOCKER_SMOKE=1. Run locally to verify before
 * tagging a release; CI runs it in the release workflow.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DIST_SERVER = join(REPO_ROOT, 'dist', 'server.js');

/**
 * Wrap a Windows-shell argument in double quotes when it contains
 * whitespace. Necessary because `shell: true` concatenates args as a
 * single string and the shell splits on whitespace — paths like
 * `Github Repos\manifest.json` arrive as two arguments otherwise.
 */
function quoteForWindowsShell(arg: string): string {
  if (process.platform !== 'win32') return arg;
  if (!/\s/.test(arg)) return arg;
  // Escape any embedded double-quotes, then wrap.
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function runSync(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  // On Windows, npm/docker/mcpb resolve to `.cmd` shims that require
  // shell=true to be invoked from Node's spawn. We pass argv as a
  // separate array — there is no shell-meta interpretation happening
  // beyond whitespace splitting, which we mitigate by quoting args
  // that contain whitespace. Args we pass are static literals from
  // this file, so the Node deprecation warning is benign.
  const safeArgs = process.platform === 'win32' ? args.map(quoteForWindowsShell) : args;
  const r = spawnSync(cmd, safeArgs, {
    cwd: options.cwd ?? REPO_ROOT,
    timeout: options.timeoutMs ?? 60_000,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    env: {
      ...process.env,
      // MSYS / Git-Bash on Windows rewrites unix-style paths in argv
      // into Windows paths (e.g. `/usr/local/bin/opa` → `C:/Program
      // Files/Git/usr/local/bin/opa`). Disable that for paths we
      // pass intact to Linux containers.
      MSYS_NO_PATHCONV: '1',
      MSYS2_ARG_CONV_EXCL: '*',
    },
  });
  return {
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    exitCode: r.status,
  };
}

// ─── 1. dist/ build smoke ─────────────────────────────────────────────────

describe('built dist/ tree', () => {
  beforeAll(() => {
    // Ensure dist/ is fresh and current; CI builds before running this
    // suite, but locally we re-build to be sure.
    const r = runSync('npm', ['run', 'build'], { timeoutMs: 120_000 });
    if (r.exitCode !== 0) {
      throw new Error(`build failed: ${r.stderr}`);
    }
  }, 180_000);

  it('emits server.js with a Node shebang for direct execution', () => {
    expect(existsSync(DIST_SERVER)).toBe(true);
    const head = readFileSync(DIST_SERVER, 'utf8').slice(0, 50);
    expect(head).toMatch(/^#!\/usr\/bin\/env node/);
  });

  it('emits compiled .js for every src module', () => {
    const expected = [
      'config.js',
      'types.js',
      'server.js',
      'lib/errors.js',
      'lib/logger.js',
      'lib/opa-cli.js',
      'lib/opa-client.js',
      'lib/output.js',
      'lib/regal-cli.js',
      'lib/security.js',
      'lib/subprocess.js',
      'lib/tool-helpers.js',
      'tools/index.js',
      'tools/authoring/format.js',
      'tools/evaluation/eval.js',
      'tools/bundles/build.js',
      'tools/server-management/policies.js',
      'tools/helpers/explain-decision.js',
      'prompts/index.js',
      'resources/index.js',
    ];
    for (const rel of expected) {
      expect(existsSync(join(REPO_ROOT, 'dist', rel)), `missing dist/${rel}`).toBe(true);
    }
  });

  it('emits .d.ts declaration files for the public surface', () => {
    expect(existsSync(join(REPO_ROOT, 'dist', 'server.d.ts'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'dist', 'config.d.ts'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'dist', 'types.d.ts'))).toBe(true);
  });

  it('emits source maps so stack traces in production point at original code', () => {
    expect(existsSync(join(REPO_ROOT, 'dist', 'server.js.map'))).toBe(true);
  });
});

// ─── 2. dist/server.js end-to-end MCP smoke ───────────────────────────────

describe('dist/server.js boots and serves the MCP protocol', () => {
  let client: Client | undefined;
  let workDir: string;

  beforeAll(async () => {
    workDir = join(tmpdir(), `orygn-dist-smoke-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER],
      env: {
        ...process.env,
        OPA_MCP_LOG_FILE: join(workDir, 'server.log'),
        OPA_MCP_LOG_LEVEL: 'error',
      },
    });
    client = new Client({ name: 'dist-smoke-client', version: '0.0.0' });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('responds to tools/list with all 42 registered tools', async () => {
    const result = await client!.listTools();
    expect(result.tools).toHaveLength(42);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('rego_format');
    expect(names).toContain('opa_health');
    expect(names).toContain('rego_explain_decision');
    expect(names).toContain('opa_delete_data');
    expect(names).toContain('opa_bundle_verify');
    expect(names).toContain('rego_migrate_v1');
  });

  it('responds to prompts/list with all 3 prompts', async () => {
    const result = await client!.listPrompts();
    expect(result.prompts).toHaveLength(3);
  });

  it('responds to resources/list with all 3 resources', async () => {
    const result = await client!.listResources();
    expect(result.resources).toHaveLength(3);
    expect(result.resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['opa://builtins', 'opa://style-guide', 'opa://patterns']),
    );
  });

  it('reads opa://style-guide successfully (resource handler reachable)', async () => {
    const result = await client!.readResource({ uri: 'opa://style-guide' });
    const contents = result.contents[0];
    expect(contents).toBeDefined();
    const text = (contents as { text?: string }).text;
    expect(typeof text).toBe('string');
    expect(text).toContain('# Rego style guide');
  });
});

// ─── 3. npm pack contents ─────────────────────────────────────────────────

describe('npm pack — published tarball contents', () => {
  it('publishes only the runtime artifacts (dist/, README, LICENSE, CHANGELOG)', () => {
    const result = runSync('npm', ['pack', '--dry-run', '--json']);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as Array<{
      files?: Array<{ path: string }>;
    }>;
    const files = parsed[0]?.files?.map((f) => f.path) ?? [];

    // Must include
    expect(files).toEqual(expect.arrayContaining(['package.json', 'README.md', 'LICENSE']));
    expect(files.some((p) => p.startsWith('dist/'))).toBe(true);

    // Must NOT include
    expect(files.some((p) => p.startsWith('src/'))).toBe(false);
    expect(files.some((p) => p.startsWith('tests/'))).toBe(false);
    expect(files.some((p) => p.startsWith('.github/'))).toBe(false);
    expect(files.some((p) => p.startsWith('.vscode/'))).toBe(false);
    expect(files.some((p) => p.startsWith('examples/'))).toBe(false);
    expect(files.some((p) => p.endsWith('.test.ts'))).toBe(false);
    expect(files.some((p) => p.endsWith('.spec.ts'))).toBe(false);
    expect(files.some((p) => p === 'Dockerfile')).toBe(false);
    expect(files.some((p) => p === 'manifest.json')).toBe(false);
    expect(files.some((p) => p === 'server.json')).toBe(false);
    expect(files.some((p) => p === 'smithery.yaml')).toBe(false);
    expect(files.some((p) => p === 'tsconfig.json')).toBe(false);
    expect(files.some((p) => p === 'eslint.config.mjs')).toBe(false);
    expect(files.some((p) => p === 'LAUNCH-PLAYBOOK.md')).toBe(false);
  }, 60_000);
});

// ─── 4. Optional Docker build smoke ───────────────────────────────────────

describe.skipIf(process.env['OPA_MCP_DOCKER_SMOKE'] !== '1')(
  'Docker image build (set OPA_MCP_DOCKER_SMOKE=1 to enable)',
  () => {
    const tag = `orygn-opa-mcp-smoke:${Date.now()}`;

    afterAll(() => {
      runSync('docker', ['rmi', '-f', tag], { timeoutMs: 60_000 });
    });

    it('builds for the host platform without errors', () => {
      const r = runSync('docker', ['build', '-t', tag, '.'], { timeoutMs: 300_000 });
      expect(r.exitCode, r.stderr.slice(0, 2000)).toBe(0);
    }, 360_000);

    it('image has the OPA and Regal binaries baked in at /usr/local/bin', () => {
      const r = runSync('docker', [
        'run',
        '--rm',
        '--entrypoint',
        '/usr/local/bin/opa',
        tag,
        'version',
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/Version:/);
    }, 60_000);
  },
);

// ─── 5. Optional MCPB pack smoke (runs if @anthropic-ai/mcpb is installed) ──

describe.skipIf(runSync('mcpb', ['--version']).exitCode !== 0)('MCPB bundle pack', () => {
  let bundlePath: string;
  let workDir: string;

  beforeAll(() => {
    workDir = join(tmpdir(), `orygn-mcpb-smoke-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    bundlePath = join(workDir, 'opa-mcp.mcpb');
  });

  afterAll(() => {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('mcpb validate accepts our manifest.json', () => {
    // `mcpb validate` checks a manifest.json against the MCPB schema —
    // a separate concern from packing. Run it standalone so any
    // schema regression in our manifest fails fast.
    const r = runSync('mcpb', ['validate', join(REPO_ROOT, 'manifest.json')]);
    expect(r.exitCode, r.stderr.slice(0, 1000)).toBe(0);
  });

  it('mcpb pack produces a non-empty bundle', () => {
    const r = runSync('mcpb', ['pack', '.', bundlePath], { timeoutMs: 90_000 });
    expect(r.exitCode, r.stderr.slice(0, 1000)).toBe(0);
    expect(existsSync(bundlePath)).toBe(true);
    const stat = readFileSync(bundlePath);
    expect(stat.length).toBeGreaterThan(1000);
  }, 120_000);

  it('mcpb info reads the produced bundle without error', () => {
    const r = runSync('mcpb', ['info', bundlePath]);
    expect(r.exitCode, r.stderr.slice(0, 1000)).toBe(0);
    // `mcpb info` reports file metadata only (size, signature
    // status). Verifying it exits 0 confirms the bundle is a
    // recognized .mcpb file, which is what we care about here.
    expect(r.stdout).toMatch(/Size:/);
  });

  it('mcpb unpack restores a manifest containing our package name', () => {
    const unpackDir = join(workDir, 'unpacked');
    const r = runSync('mcpb', ['unpack', bundlePath, unpackDir]);
    expect(r.exitCode, r.stderr.slice(0, 1000)).toBe(0);
    const manifest = readFileSync(join(unpackDir, 'manifest.json'), 'utf8');
    expect(manifest).toContain('@orygn/opa-mcp');
  });
});
