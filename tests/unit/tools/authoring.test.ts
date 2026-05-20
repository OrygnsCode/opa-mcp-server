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
          file: '/tmp/orygn-opa-mcp-9b1a4e2c-d4f3-4f8b-9e3a-1c2d3e4f5a6b.rego',
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
