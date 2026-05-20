import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseConfig, callTool, fixturePath, makeServer, spawnUnreachable } from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';
import { registerRegoInferInputSchema } from '../../../src/tools/helpers/infer-input-schema.js';
import type { RegoInferInputSchemaOutput } from '../../../src/tools/helpers/infer-input-schema.js';

const mockRun = vi.mocked(runBinary);

const okSpawn = { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };

/** Build a minimal OPA parse AST containing the given input refs. */
function makeParseAst(refs: Array<Array<{ type: 'string' | 'var'; value: string }>>): string {
  const terms = refs.map((parts) => ({
    type: 'ref',
    value: [
      { type: 'var', value: 'input' },
      ...parts.map((p) => ({ type: p.type, value: p.value })),
    ],
  }));
  return JSON.stringify({
    package: {
      path: [
        { type: 'var', value: 'data' },
        { type: 'string', value: 'x' },
      ],
    },
    rules: [
      {
        head: { name: 'allow', value: { type: 'boolean', value: true } },
        body: [{ terms }],
      },
    ],
  });
}

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue({ ...okSpawn });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rego_infer_input_schema', () => {
  it('infers flat input fields as object properties', async () => {
    const ast = makeParseAst([
      [{ type: 'string', value: 'action' }],
      [{ type: 'string', value: 'user' }],
    ]);
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: ast });
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool<RegoInferInputSchemaOutput>(server, 'rego_infer_input_schema', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    const schema = env.data?.schema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('action');
    expect(props).toHaveProperty('user');
  });

  it('infers nested input fields as nested object properties', async () => {
    const ast = makeParseAst([
      [
        { type: 'string', value: 'user' },
        { type: 'string', value: 'role' },
      ],
    ]);
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: ast });
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool<RegoInferInputSchemaOutput>(server, 'rego_infer_input_schema', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    const schema = env.data?.schema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    const user = props['user'] as Record<string, unknown>;
    expect(user['type']).toBe('object');
    const userProps = user['properties'] as Record<string, unknown>;
    expect(userProps).toHaveProperty('role');
  });

  it('marks a field as array type when a wildcard var is present in the path', async () => {
    const ast = makeParseAst([
      [
        { type: 'string', value: 'groups' },
        { type: 'var', value: '_' }, // wildcard
        { type: 'string', value: 'name' },
      ],
    ]);
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: ast });
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool<RegoInferInputSchemaOutput>(server, 'rego_infer_input_schema', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    const schema = env.data?.schema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    const groups = props['groups'] as Record<string, unknown>;
    expect(groups['type']).toBe('array');
    const items = groups['items'] as Record<string, unknown>;
    expect(items['properties'] as Record<string, unknown>).toHaveProperty('name');
  });

  it('populates inputPaths with human-readable dot-notation strings', async () => {
    const ast = makeParseAst([
      [
        { type: 'string', value: 'user' },
        { type: 'string', value: 'role' },
      ],
      [{ type: 'string', value: 'action' }],
    ]);
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: ast });
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool<RegoInferInputSchemaOutput>(server, 'rego_infer_input_schema', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.inputPaths).toContain('input.user.role');
    expect(env.data?.inputPaths).toContain('input.action');
  });

  it('deduplicates identical refs that appear more than once', async () => {
    const singleRef = [{ type: 'string' as const, value: 'action' }];
    const ast = makeParseAst([singleRef, singleRef, singleRef]);
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: ast });
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool<RegoInferInputSchemaOutput>(server, 'rego_infer_input_schema', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.inputPaths.filter((p) => p === 'input.action')).toHaveLength(1);
  });

  it('returns a warning when no input refs are found', async () => {
    const ast = JSON.stringify({ package: {}, rules: [] });
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: ast });
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool<RegoInferInputSchemaOutput>(server, 'rego_infer_input_schema', {
      source: 'package x',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.inputPaths).toHaveLength(0);
    expect(env.warnings?.length).toBeGreaterThan(0);
  });

  it('returns INVALID_REGO when opa parse exits non-zero', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, exitCode: 1, stderr: 'parse error' });
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool(server, 'rego_infer_input_schema', { source: 'not valid rego' });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('INVALID_REGO');
  });

  it('returns OPA_BINARY_NOT_FOUND when the binary is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool(server, 'rego_infer_input_schema', { source: 'package x' });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('OPA_BINARY_NOT_FOUND');
  });

  it('returns error when neither source nor paths are provided', async () => {
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool(server, 'rego_infer_input_schema', {});
    expect(env.ok).toBe(false);
  });

  it('accepts a file path and parses it directly', async () => {
    const ast = makeParseAst([[{ type: 'string', value: 'subject' }]]);
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: ast });
    const server = makeServer();
    registerRegoInferInputSchema(server, baseConfig);
    const env = await callTool<RegoInferInputSchemaOutput>(server, 'rego_infer_input_schema', {
      paths: [fixturePath('policies', 'valid', 'rbac.rego')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.filesAnalyzed).toBe(1);
  });
});
