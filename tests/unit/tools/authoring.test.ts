import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  baseConfig,
  callTool,
  fixturePath,
  makeServer,
  spawnFailure,
  spawnSuccess,
  spawnTimedOut,
  spawnUnreachable,
} from './_helpers.js';

import { registerRegoCheckSchema } from '../../../src/tools/authoring/check-schema.js';
import type { RegoCheckSchemaOutput } from '../../../src/tools/authoring/check-schema.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

import { registerAuthoringTools } from '../../../src/tools/authoring/index.js';

const mockRun = vi.mocked(runBinary);

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rego_format', () => {
  it('returns formatted source and changed=false on idempotent input', async () => {
    const source = 'package x\n\nallow := true\n';
    mockRun.mockResolvedValueOnce(spawnSuccess(source));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ formatted: string; changed: boolean }>(server, 'rego_format', {
      source,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.formatted).toBe(source);
    expect(env.data?.changed).toBe(false);
  });

  it('reports changed=true when output differs from input', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('package x\n\nallow := true\n'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ changed: boolean }>(server, 'rego_format', {
      source: 'package x\nallow{true}',
    });
    expect(env.data?.changed).toBe(true);
  });

  it('maps a parse failure to INVALID_REGO', async () => {
    mockRun.mockResolvedValueOnce(
      spawnFailure(1, JSON.stringify({ errors: [{ code: 'rego_parse_error' }] })),
    );
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_format', { source: 'broken' });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_REGO');
  });

  it('maps a missing binary to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_format', { source: 'package x' });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
    expect(env.error?.hint).toMatch(/OPA_BINARY/);
  });

  it('maps a timeout to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_format', { source: 'package x' });
    expect(env.error?.code).toBe('TIMEOUT');
  });
});

describe('rego_format -- string interpolation version guard', () => {
  const versionOutput = (v: string) =>
    spawnSuccess(
      `Version: ${v}\nBuild Commit: abc123\nGo Version: go1.22\nPlatform: linux/amd64\n`,
    );

  // Source with $"..." interpolation but no \{ -- warning-only case
  const interpNoEscape = 'package x\n\ngreeting := $"Hello {input.name}!"\n';
  // Source with $"..." interpolation AND \{ -- blocking case
  const interpWithEscape = 'package x\n\ngreeting := $"A literal \\{brace} here"\n';

  it('does not call opa version when source has no string interpolation', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('package x\n\nallow := true\n'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    await callTool(server, 'rego_format', { source: 'package x\nallow{true}' });
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('calls opa version before fmt when source contains $"..." interpolation', async () => {
    mockRun.mockResolvedValueOnce(versionOutput('1.12.2'));
    mockRun.mockResolvedValueOnce(spawnSuccess(interpNoEscape));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    await callTool(server, 'rego_format', { source: interpNoEscape });
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('returns OPA_VERSION_UNSUPPORTED for OPA 1.12.0 with \\{ in interpolation', async () => {
    mockRun.mockResolvedValueOnce(versionOutput('1.12.0'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_format', { source: interpWithEscape });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('OPA_VERSION_UNSUPPORTED');
    expect(env.error?.message).toMatch(/1\.12\.0/);
    expect(env.error?.hint).toMatch(/1\.12\.2/);
    // fmt must not be called -- blocked before reaching it
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('returns OPA_VERSION_UNSUPPORTED for OPA 1.12.1 with \\{ in interpolation', async () => {
    mockRun.mockResolvedValueOnce(versionOutput('1.12.1'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_format', { source: interpWithEscape });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('OPA_VERSION_UNSUPPORTED');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('adds warning but still formats when OPA 1.12.0 is used without \\{ in interpolation', async () => {
    mockRun.mockResolvedValueOnce(versionOutput('1.12.0'));
    mockRun.mockResolvedValueOnce(spawnSuccess(interpNoEscape));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ formatted: string; changed: boolean }>(server, 'rego_format', {
      source: interpNoEscape,
    });
    expect(env.ok).toBe(true);
    expect(env.warnings).toBeDefined();
    expect(env.warnings!.length).toBeGreaterThan(0);
    expect(env.warnings![0]).toMatch(/1\.12\.0/);
    expect(env.warnings![0]).toMatch(/1\.12\.2/);
  });

  it('formats without warning on OPA 1.12.2 (bug fixed)', async () => {
    mockRun.mockResolvedValueOnce(versionOutput('1.12.2'));
    mockRun.mockResolvedValueOnce(spawnSuccess(interpNoEscape));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_format', { source: interpNoEscape });
    expect(env.ok).toBe(true);
    expect(env.warnings).toBeUndefined();
  });

  it('formats without warning on OPA 2.0.0 (not in affected range)', async () => {
    mockRun.mockResolvedValueOnce(versionOutput('2.0.0'));
    mockRun.mockResolvedValueOnce(spawnSuccess(interpNoEscape));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_format', { source: interpNoEscape });
    expect(env.ok).toBe(true);
    expect(env.warnings).toBeUndefined();
  });

  it('formats without warning when OPA version string cannot be parsed', async () => {
    // Version returns 0 exit but unrecognized output -- version() returns null
    mockRun.mockResolvedValueOnce(spawnSuccess('no version info here\n'));
    mockRun.mockResolvedValueOnce(spawnSuccess(interpNoEscape));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_format', { source: interpNoEscape });
    expect(env.ok).toBe(true);
    expect(env.warnings).toBeUndefined();
  });
});

describe('rego_check', () => {
  it('reports valid: true with empty errors on success', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ valid: boolean; errors: unknown[] }>(server, 'rego_check', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.errors).toEqual([]);
  });

  it('parses diagnostics from stderr (where opa puts them)', async () => {
    mockRun.mockResolvedValueOnce(
      spawnFailure(
        1,
        JSON.stringify({
          errors: [
            {
              code: 'rego_unsafe_var_error',
              message: 'var x is unsafe',
              location: { file: 'a.rego', row: 2, col: 1 },
            },
          ],
        }),
      ),
    );
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ valid: boolean; errors: Array<{ code?: string }> }>(
      server,
      'rego_check',
      { source: 'package x\nallow if y' },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors[0]?.code).toBe('rego_unsafe_var_error');
  });

  it('rejects calls without source or paths', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_check', {});
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects calls with both source and paths', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_check', {
      source: 'package x',
      paths: ['/abs/p'],
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects paths outside allowed roots', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_check', { paths: ['/outside/p.rego'] });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('accepts a fixture path that exists', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ valid: boolean }>(server, 'rego_check', {
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(true);
  });
});

describe('rego_lint', () => {
  it('returns violations from the regal JSON output', async () => {
    const violations = [
      { title: 'directory-package-mismatch', category: 'idiomatic', level: 'error' },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ violations })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ violations: typeof violations }>(server, 'rego_lint', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.violations).toEqual(violations);
  });

  it('maps missing regal binary to REGAL_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_lint', { source: 'package x' });
    expect(env.error?.code).toBe('REGAL_NOT_FOUND');
    expect(env.error?.hint).toMatch(/Regal/);
  });

  it('rejects calls without source or paths', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_lint', {});
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects calls with both source and paths', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_lint', {
      source: 'package x',
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects paths outside allowed roots', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_lint', { paths: ['/outside/x.rego'] });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('accepts a fixture path that exists', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ violations: [] })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ violations: unknown[] }>(server, 'rego_lint', {
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.violations).toEqual([]);
  });

  it('returns UNKNOWN_ERROR when regal stdout is not parseable JSON', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('not json from regal'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_lint', { source: 'package x' });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('forwards every rule-level enable/disable flag and config-file path', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ violations: [] })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    // configFile must exist and be inside an allowed root -- use any real fixture file.
    await callTool(server, 'rego_lint', {
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
      configFile: fixturePath('inputs', 'rbac.json'),
      disable: ['print-or-trace-call'],
      enable: ['no-defined-rule'],
      disableCategory: ['style'],
      enableCategory: ['bugs'],
      failLevel: 'warning',
      ignoreFiles: ['vendor/**'],
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--config-file');
    expect(args).toContain('--disable');
    expect(args).toContain('--enable');
    expect(args).toContain('--disable-category');
    expect(args).toContain('--enable-category');
    expect(args).toContain('--fail-level');
    expect(args).toContain('warning');
    expect(args).toContain('--ignore-files');
  });

  it('rewrites temp-file paths in violation locations to <inline> for inline source', async () => {
    const violations = [
      {
        title: 'use-rego-v1',
        category: 'imports',
        level: 'error',
        location: {
          file: '/tmp/orygn-regal-mcp-abc123/input.rego',
          row: 1,
          col: 1,
        },
      },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ violations })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{
      violations: Array<{ location?: { file?: string; row?: number } }>;
    }>(server, 'rego_lint', { source: 'package x' });
    expect(env.ok).toBe(true);
    expect(env.data?.violations[0]?.location?.file).toBe('<inline>');
    expect(env.data?.violations[0]?.location?.row).toBe(1);
  });

  it('preserves on-disk paths in violation locations when paths are used', async () => {
    const violations = [
      {
        title: 'use-rego-v1',
        category: 'imports',
        level: 'error',
        location: { file: '/abs/policies/rbac.rego', row: 1, col: 1 },
      },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ violations })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ violations: Array<{ location?: { file?: string } }> }>(
      server,
      'rego_lint',
      { paths: [fixturePath('policies', 'valid', 'rbac.rego')] },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.violations[0]?.location?.file).toBe('/abs/policies/rbac.rego');
  });

  it('handles violations with no location field gracefully', async () => {
    const violations = [{ title: 'orphaned', category: 'bugs', level: 'error' }];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ violations })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ violations: typeof violations }>(server, 'rego_lint', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.violations[0]).toMatchObject({ title: 'orphaned' });
  });
});

describe('rego_parse_ast', () => {
  it('returns the parsed AST on success', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ package: { path: [] } })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ ast: { package: unknown } }>(server, 'rego_parse_ast', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.ast.package).toBeDefined();
  });

  it('maps non-zero exit to INVALID_REGO', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'parse error'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_parse_ast', { source: 'broken' });
    expect(env.error?.code).toBe('INVALID_REGO');
  });
});

describe('rego_inspect', () => {
  it('returns inspect JSON for a valid target', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ namespaces: { 'data.x': [] } })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ namespaces?: unknown }>(server, 'rego_inspect', {
      target: fixturePath('policies', 'valid', 'rbac.rego'),
    });
    expect(env.ok).toBe(true);
    expect(env.data?.namespaces).toBeDefined();
  });

  it('rejects targets outside allowed roots', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_inspect', { target: '/outside/x.tar.gz' });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('maps non-zero exit to INVALID_BUNDLE', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'not a bundle'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_inspect', {
      target: fixturePath('policies', 'valid', 'rbac.rego'),
    });
    expect(env.error?.code).toBe('INVALID_BUNDLE');
  });
});

describe('rego_capabilities', () => {
  it('returns builtin names and count by default (names_only: true)', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(
        JSON.stringify({
          builtins: [{ name: 'http.send' }, { name: 'plus' }],
          future_keywords: ['every'],
          features: ['rego_v1'],
        }),
      ),
    );
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{
      builtin_names?: string[];
      builtin_count?: number;
      future_keywords?: unknown[];
      features?: unknown[];
    }>(server, 'rego_capabilities', { current: true });
    expect(env.ok).toBe(true);
    expect(env.data?.builtin_names).toEqual(['http.send', 'plus']);
    expect(env.data?.builtin_count).toBe(2);
    expect(env.data?.future_keywords).toEqual(['every']);
    expect(env.data?.features).toEqual(['rego_v1']);
  });

  it('does not include full builtin specs in the default names_only response', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(
        JSON.stringify({ builtins: [{ name: 'http.send', decl: { type: 'function' } }] }),
      ),
    );
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ builtins?: unknown[]; builtin_names?: string[] }>(
      server,
      'rego_capabilities',
      { current: true },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.builtins).toBeUndefined();
    expect(env.data?.builtin_names).toEqual(['http.send']);
  });

  it('returns full builtins when names_only: false', async () => {
    const builtins = [{ name: 'http.send', decl: { type: 'function' } }];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify({ builtins })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ builtins?: unknown[] }>(server, 'rego_capabilities', {
      current: true,
      names_only: false,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.builtins).toEqual(builtins);
  });

  it('handles builtins array with entries missing a name field gracefully', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(JSON.stringify({ builtins: [{ name: 'valid' }, { decl: {} }] })),
    );
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ builtin_names?: string[]; builtin_count?: number }>(
      server,
      'rego_capabilities',
      { current: true },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.builtin_names).toEqual(['valid']);
    expect(env.data?.builtin_count).toBe(1);
  });

  it('parses newline-separated versions when neither flag is set', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('v0.68.0\nv0.69.0\n'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ versions?: string[] }>(server, 'rego_capabilities', {});
    expect(env.data?.versions).toEqual(['v0.68.0', 'v0.69.0']);
  });

  it('rejects current and version together', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_capabilities', {
      current: true,
      version: 'v0.69.0',
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });
});

describe('authoring tools — common-error coverage', () => {
  it('rego_check returns INVALID_REGO with stderr fallback when stderr is not JSON', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'plain text error from check'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_check', { source: 'broken' });
    expect(env.error?.code).toBe('INVALID_REGO');
  });

  it('rego_capabilities returns INVALID_INPUT when version is unrecognized', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'unknown capabilities version'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_capabilities', { version: 'v999.0.0' });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('rego_capabilities returns UNKNOWN_ERROR when stdout is not parseable JSON', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('garbage', ''));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_capabilities', { current: true });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('rego_parse_ast returns UNKNOWN_ERROR when opa parse stdout is unparseable', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('also garbage'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_parse_ast', { source: 'package x' });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('rego_inspect returns UNKNOWN_ERROR when opa inspect stdout is unparseable', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('not json'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_inspect', {
      target: fixturePath('policies', 'valid', 'rbac.rego'),
    });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('rego_deps returns UNKNOWN_ERROR when opa deps stdout is unparseable', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('not json'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_deps', {
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
      ref: 'data.x',
    });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });
});

describe('rego_deps', () => {
  it('returns base + virtual dep refs', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(JSON.stringify({ base: ['input.user'], virtual: ['data.rbac'] })),
    );
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ base?: unknown[]; virtual?: unknown[] }>(server, 'rego_deps', {
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
      ref: 'data.rbac.allow',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.base).toEqual(['input.user']);
    expect(env.data?.virtual).toEqual(['data.rbac']);
  });

  it('rejects paths outside allowed roots', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_deps', {
      paths: ['/outside/x'],
      ref: 'data.x',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('maps non-zero exit to INVALID_REGO', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'compile error'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_deps', {
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
      ref: 'data.rbac.allow',
    });
    expect(env.error?.code).toBe('INVALID_REGO');
  });
});

// ─── path-validation security tests ───────────────────────────────────────────
// These are adversarial: they verify that newly-validated parameters cannot be
// used to make tools read arbitrary files outside the allow-list.

describe('rego_check -- capabilities and schemaDir path validation', () => {
  it('rejects capabilities outside allowed roots', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_check', {
      source: 'package x',
      capabilities: '/etc/opa-capabilities.json',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects schemaDir outside allowed roots', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_check', {
      source: 'package x',
      schemaDir: '/etc/schemas',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects a capabilities file that does not exist inside the allowed root', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_check', {
      source: 'package x',
      capabilities: fixturePath('nonexistent-caps.json'),
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
  });

  it('accepts capabilities and schemaDir inside the allowed root and passes resolved paths to opa', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const capsFile = fixturePath('inputs', 'rbac.json');
    const schDir = fixturePath('policies', 'valid');
    const env = await callTool<{ valid: boolean }>(server, 'rego_check', {
      source: 'package x',
      capabilities: capsFile,
      schemaDir: schDir,
    });
    expect(env.ok).toBe(true);
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--capabilities');
    expect(args).toContain('--schema');
  });
});

describe('rego_lint -- configFile path validation', () => {
  it('rejects configFile outside allowed roots', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_lint', {
      source: 'package x',
      configFile: '/etc/regal/config.yaml',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects a configFile that does not exist inside the allowed root', async () => {
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_lint', {
      source: 'package x',
      configFile: fixturePath('nonexistent-config.yaml'),
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
  });
});

// ── v0 source samples used across rego_migrate_v1 tests ────────────────────
// Classic Rego v0 pattern: rule head uses `{...}` without `if`.
const v0Source = `package example\n\nallow {\n  input.user == "admin"\n}\n`;
// The expected v1 output after opa fmt --rego-v1 (adds `if`).
const v1Source = `package example\n\nimport rego.v1\n\nallow if {\n  input.user == "admin"\n}\n`;

describe('rego_migrate_v1', () => {
  it('returns migrated source with changed=true and valid=true on a typical v0 policy', async () => {
    // First call: opa fmt --rego-v1 (returns migrated source)
    mockRun.mockResolvedValueOnce(spawnSuccess(v1Source));
    // Second call: opa check --v1-compatible (no errors)
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{
      original: string;
      migrated: string;
      changed: boolean;
      valid: boolean;
      errors: unknown[];
    }>(server, 'rego_migrate_v1', { source: v0Source });

    expect(env.ok).toBe(true);
    expect(env.data?.original).toBe(v0Source);
    expect(env.data?.migrated).toBe(v1Source);
    expect(env.data?.changed).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.errors).toEqual([]);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('passes --rego-v1 to fmt and --v1-compatible to check in argv', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(v1Source));
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    await callTool(server, 'rego_migrate_v1', { source: v0Source });

    const fmtArgs = mockRun.mock.calls[0]![1].args;
    const checkArgs = mockRun.mock.calls[1]![1].args;

    expect(fmtArgs[0]).toBe('fmt');
    expect(fmtArgs).toContain('--rego-v1');

    expect(checkArgs[0]).toBe('check');
    expect(checkArgs).toContain('--v1-compatible');
  });

  it('reports changed=false when source is already v1-compatible', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(v1Source));
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ changed: boolean }>(server, 'rego_migrate_v1', {
      source: v1Source,
    });
    expect(env.data?.changed).toBe(false);
  });

  it('returns ok=true with valid=false and errors when check finds remaining issues', async () => {
    const checkErrors = [
      {
        code: 'rego_type_error',
        message: 'function rego.v1.http.send not allowed in v1',
        location: { file: '<input>', row: 5, col: 3 },
      },
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(v1Source));
    mockRun.mockResolvedValueOnce(spawnFailure(1, JSON.stringify({ errors: checkErrors })));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{
      migrated: string;
      valid: boolean;
      errors: typeof checkErrors;
    }>(server, 'rego_migrate_v1', { source: v0Source });

    // ok: true even though check found issues -- migration happened; caller fixes remainder
    expect(env.ok).toBe(true);
    expect(env.data?.migrated).toBe(v1Source);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors).toHaveLength(1);
    expect(env.data?.errors[0]?.code).toBe('rego_type_error');
  });

  it('returns empty errors array when check exits non-zero but produces no JSON', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(v1Source));
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'something went wrong -- non-json'));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ valid: boolean; errors: unknown[] }>(server, 'rego_migrate_v1', {
      source: v0Source,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors).toEqual([]);
  });

  it('maps fmt parse failure to INVALID_REGO and does not call check', async () => {
    const fmtError = JSON.stringify({
      errors: [{ code: 'rego_parse_error', message: 'bad syntax' }],
    });
    mockRun.mockResolvedValueOnce(spawnFailure(2, fmtError));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_migrate_v1', { source: '!@#invalid' });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_REGO');
    // check subprocess must NOT have been called
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('maps missing opa binary in fmt phase to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_migrate_v1', { source: v0Source });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('maps timeout in fmt phase to TIMEOUT and does not call check', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_migrate_v1', { source: v0Source });
    expect(env.error?.code).toBe('TIMEOUT');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('maps missing opa binary in check phase to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(v1Source));
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_migrate_v1', { source: v0Source });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('maps timeout in check phase to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(v1Source));
    mockRun.mockResolvedValueOnce(spawnTimedOut());
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool(server, 'rego_migrate_v1', { source: v0Source });
    expect(env.error?.code).toBe('TIMEOUT');
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('always echoes the original source in output even when changed', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(v1Source));
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ original: string }>(server, 'rego_migrate_v1', {
      source: v0Source,
    });
    expect(env.data?.original).toBe(v0Source);
  });

  it('check step uses the fmt output (not the original source) when fmt changes code', async () => {
    // If fmt changes the source, check must run on the MIGRATED code.
    // We verify this indirectly: both calls happen, and the second is `check` not `fmt`.
    mockRun.mockResolvedValueOnce(spawnSuccess(v1Source));
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    await callTool(server, 'rego_migrate_v1', { source: v0Source });

    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun.mock.calls[0]![1].args[0]).toBe('fmt');
    expect(mockRun.mock.calls[1]![1].args[0]).toBe('check');
  });
});

// ─── rego_check_schema ────────────────────────────────────────────────────────

describe('rego_check_schema', () => {
  // ── Happy path: inline schema + inline source ─────────────────────────────

  it('returns valid: true with empty errors when opa check exits 0', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      source: 'package x\nimport rego.v1\nallow if input.user == "admin"',
      inlineSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { user: { type: 'string' } },
      },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.errors).toEqual([]);
  });

  it('returns valid: false with errors when opa check reports schema violations', async () => {
    const schemaErrors = [
      {
        code: 'rego_type_error',
        message: 'undefined ref: input.foo',
        location: { file: 'policy.rego', row: 3, col: 5 },
      },
    ];
    mockRun.mockResolvedValueOnce(spawnFailure(1, JSON.stringify({ errors: schemaErrors })));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      source: 'package x\nimport rego.v1\nallow if input.foo == "bar"',
      inlineSchema: {
        type: 'object',
        properties: { user: { type: 'string' } },
      },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors).toHaveLength(1);
    expect(env.data?.errors[0]?.code).toBe('rego_type_error');
    expect(env.data?.errors[0]?.message).toContain('input.foo');
  });

  // ── Happy path: schema file path ──────────────────────────────────────────

  it('accepts a schemaPath inside allowed roots and passes --schema to opa', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const schemaFile = fixturePath('inputs', 'rbac.json');
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      source: 'package x',
      schemaPath: schemaFile,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(true);
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--schema');
  });

  // ── Happy path: file-based policy paths ───────────────────────────────────

  it('accepts policy paths instead of inline source', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
      inlineSchema: { type: 'object', properties: { user: { type: 'string' } } },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(true);
  });

  // ── strict flag ───────────────────────────────────────────────────────────

  it('passes --strict to opa when strict: true', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    await callTool(server, 'rego_check_schema', {
      source: 'package x',
      inlineSchema: { type: 'object' },
      strict: true,
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--strict');
  });

  it('does not pass --strict when strict is omitted', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    await callTool(server, 'rego_check_schema', {
      source: 'package x',
      inlineSchema: { type: 'object' },
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).not.toContain('--strict');
  });

  // ── Policy input validation ───────────────────────────────────────────────

  it('rejects calls without source or paths', async () => {
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.message).toMatch(/source.*paths/i);
  });

  it('rejects calls with both source and paths', async () => {
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      source: 'package x',
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  // ── Schema input validation ───────────────────────────────────────────────

  it('rejects calls without inlineSchema or schemaPath', async () => {
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      source: 'package x',
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.message).toMatch(/inlineSchema.*schemaPath/i);
  });

  it('rejects calls with both inlineSchema and schemaPath', async () => {
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      source: 'package x',
      inlineSchema: { type: 'object' },
      schemaPath: fixturePath('inputs', 'rbac.json'),
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  // ── Path validation ───────────────────────────────────────────────────────

  it('rejects policy paths outside allowed roots', async () => {
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      paths: ['/outside/policy.rego'],
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects schemaPath outside allowed roots', async () => {
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      source: 'package x',
      schemaPath: '/etc/schemas/input.json',
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects a schemaPath that does not exist inside the allowed root', async () => {
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      source: 'package x',
      schemaPath: fixturePath('nonexistent-schema.json'),
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
  });

  it('rejects a policy path that does not exist inside the allowed root', async () => {
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      paths: [fixturePath('policies', 'nonexistent.rego')],
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
  });

  // ── Binary / subprocess error propagation ────────────────────────────────

  it('maps a missing opa binary to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      source: 'package x',
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
    expect(env.error?.hint).toMatch(/OPA_BINARY/);
  });

  it('maps a subprocess timeout to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      source: 'package x',
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('TIMEOUT');
  });

  // ── Non-JSON stderr fallback ──────────────────────────────────────────────

  it('returns INVALID_REGO with details when opa exits non-zero but stderr is not JSON', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'opa: error: module compile failed'));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool(server, 'rego_check_schema', {
      source: 'broken rego ###',
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_REGO');
    expect((env.error?.details as { stderr?: string } | undefined)?.stderr).toMatch(
      /module compile failed/,
    );
  });

  // ── Inline source: temp path sanitization ────────────────────────────────

  it('replaces temp file paths with <inline> in error locations when source is inline', async () => {
    const errors = [
      {
        code: 'rego_type_error',
        message: 'undefined ref: input.missing',
        location: {
          file: '/tmp/orygn-opa-mcp-abc123/input.rego',
          row: 3,
          col: 10,
        },
      },
    ];
    mockRun.mockResolvedValueOnce(spawnFailure(1, JSON.stringify({ errors })));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      source: 'package x\nimport rego.v1\nallow if input.missing == "x"',
      inlineSchema: { type: 'object', properties: { user: { type: 'string' } } },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors[0]?.location?.file).toBe('<inline>');
    expect(env.data?.errors[0]?.location?.row).toBe(3);
  });

  it('preserves on-disk file paths in error locations when paths are used', async () => {
    const errors = [
      {
        code: 'rego_type_error',
        message: 'undefined ref: input.missing',
        location: { file: '/abs/policies/policy.rego', row: 5, col: 3 },
      },
    ];
    mockRun.mockResolvedValueOnce(spawnFailure(1, JSON.stringify({ errors })));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
      inlineSchema: { type: 'object', properties: { user: { type: 'string' } } },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors[0]?.location?.file).toBe('/abs/policies/policy.rego');
  });

  // ── Error records with no location field ─────────────────────────────────

  it('handles error records with no location field without throwing', async () => {
    const errors = [{ code: 'rego_type_error', message: 'undefined ref: input.x' }];
    mockRun.mockResolvedValueOnce(spawnFailure(1, JSON.stringify({ errors })));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      source: 'package x\nallow if input.x',
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors[0]?.code).toBe('rego_type_error');
  });

  // ── Inline schema is serialized and passed to OPA ─────────────────────────

  it('passes --schema flag to opa for inline schema', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    await callTool(server, 'rego_check_schema', {
      source: 'package x',
      inlineSchema: { type: 'object', properties: { action: { type: 'string' } } },
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--schema');
    // The argument after --schema must be a path (the temp file), not the JSON itself
    const schemaIdx = args.indexOf('--schema');
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaArg = args[schemaIdx + 1];
    expect(typeof schemaArg).toBe('string');
    // It should be a file path containing our prefix, not raw JSON
    expect(schemaArg).toMatch(/orygn-schema-/);
    expect(schemaArg).toMatch(/schema\.json$/);
  });

  // ── Multiple errors in a single response ─────────────────────────────────

  it('surfaces all errors from opa output when multiple schema violations exist', async () => {
    const errors = [
      {
        code: 'rego_type_error',
        message: 'undefined ref: input.foo',
        location: { file: 'p.rego', row: 3, col: 5 },
      },
      {
        code: 'rego_type_error',
        message: 'undefined ref: input.bar',
        location: { file: 'p.rego', row: 4, col: 5 },
      },
    ];
    mockRun.mockResolvedValueOnce(spawnFailure(1, JSON.stringify({ errors })));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      source: 'package x\nallow if input.foo\nallow if input.bar',
      inlineSchema: { type: 'object', properties: { user: { type: 'string' } } },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors).toHaveLength(2);
    expect(env.data?.errors[1]?.message).toContain('input.bar');
  });

  // ── opa exits non-zero but errors array is empty ──────────────────────────

  it('returns valid: false with empty errors when opa stderr has empty errors array', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, JSON.stringify({ errors: [] })));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      source: 'package x',
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors).toEqual([]);
  });

  // ── opa exits non-zero but errors key is absent from stderr JSON ──────────

  it('returns valid: false with empty errors when opa stderr JSON has no errors key', async () => {
    // Defensive: OPA could theoretically emit a JSON object without an 'errors' key.
    // The handler must not crash and must default to empty errors array.
    mockRun.mockResolvedValueOnce(spawnFailure(1, JSON.stringify({ warnings: ['something'] })));
    const server = makeServer();
    registerRegoCheckSchema(server, baseConfig);
    const env = await callTool<RegoCheckSchemaOutput>(server, 'rego_check_schema', {
      source: 'package x',
      inlineSchema: { type: 'object' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.valid).toBe(false);
    expect(env.data?.errors).toEqual([]);
  });
});
