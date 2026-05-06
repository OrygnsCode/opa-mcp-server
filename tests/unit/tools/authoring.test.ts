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
    const env = await callTool<{ formatted: string; changed: boolean }>(
      server,
      'rego_format',
      { source },
    );
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
    const env = await callTool<{ valid: boolean; errors: unknown[] }>(
      server,
      'rego_check',
      { source: 'package x' },
    );
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
    mockRun.mockResolvedValueOnce(
      spawnSuccess(JSON.stringify({ namespaces: { 'data.x': [] } })),
    );
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
  it('returns the parsed capabilities for current=true', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(JSON.stringify({ builtins: [{ name: 'http.send' }] })),
    );
    const server = makeServer();
    registerAuthoringTools(server, baseConfig);
    const env = await callTool<{ builtins?: unknown[] }>(server, 'rego_capabilities', {
      current: true,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.builtins).toBeDefined();
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
