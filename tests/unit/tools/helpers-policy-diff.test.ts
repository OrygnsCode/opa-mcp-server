import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseConfig, callTool, fixturePath, makeServer, spawnUnreachable } from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';
import {
  diffValues,
  extractResultValue,
  registerRegoPolicyDiff,
  type RegoPolicyDiffOutput,
} from '../../../src/tools/helpers/policy-diff.js';

const mockRun = vi.mocked(runBinary);
const okSpawn = { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };

// OPA eval --format=json output helpers
const opaResult = (value: unknown): string =>
  JSON.stringify({
    result: [{ expressions: [{ value, text: 'data.test', location: { row: 1, col: 1 } }] }],
  });
const opaEmpty = '{}';
const opaError = (msg: string): string =>
  JSON.stringify({ errors: [{ message: msg, code: 'rego_parse_error' }] });

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue({ ...okSpawn });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── extractResultValue() ─────────────────────────────────────────────────────

describe('extractResultValue()', () => {
  it('returns undefined for empty stdout', () => {
    expect(extractResultValue('')).toBeUndefined();
    expect(extractResultValue('   ')).toBeUndefined();
  });

  it('returns undefined for "{}" (OPA undefined result)', () => {
    expect(extractResultValue('{}')).toBeUndefined();
  });

  it('extracts a boolean true value', () => {
    expect(extractResultValue(opaResult(true))).toBe(true);
  });

  it('extracts a boolean false value', () => {
    expect(extractResultValue(opaResult(false))).toBe(false);
  });

  it('extracts a plain object value', () => {
    const obj = { allow: true, roles: ['admin'] };
    expect(extractResultValue(opaResult(obj))).toEqual(obj);
  });

  it('extracts a null value', () => {
    expect(extractResultValue(opaResult(null))).toBeNull();
  });

  it('returns undefined for {"result":[]} (empty result array)', () => {
    expect(extractResultValue(JSON.stringify({ result: [] }))).toBeUndefined();
  });

  it('returns the full result array for multiple result rows', () => {
    const multiRow = {
      result: [
        { expressions: [{ value: true }], bindings: { x: 1 } },
        { expressions: [{ value: true }], bindings: { x: 2 } },
      ],
    };
    const extracted = extractResultValue(JSON.stringify(multiRow));
    expect(Array.isArray(extracted)).toBe(true);
    expect((extracted as unknown[]).length).toBe(2);
  });

  it('returns undefined on unparseable stdout', () => {
    expect(extractResultValue('not json')).toBeUndefined();
  });
});

// ─── diffValues() ─────────────────────────────────────────────────────────────

describe('diffValues()', () => {
  it('returns [] for two identical primitives', () => {
    expect(diffValues(true, true)).toHaveLength(0);
    expect(diffValues(42, 42)).toHaveLength(0);
    expect(diffValues('a', 'a')).toHaveLength(0);
  });

  it('returns ["."] for two different primitives at root', () => {
    expect(diffValues(true, false)).toEqual(['.']);
    expect(diffValues(1, 2)).toEqual(['.']);
  });

  it('returns ["."] when one side is undefined and other is not', () => {
    expect(diffValues(undefined, true)).toEqual(['.']);
    expect(diffValues(true, undefined)).toEqual(['.']);
    expect(diffValues(undefined, undefined)).toHaveLength(0);
  });

  it('returns ["."] when types differ (object vs primitive)', () => {
    expect(diffValues({ a: 1 }, 1)).toEqual(['.']);
    expect(diffValues(null, {})).toEqual(['.']);
  });

  it('returns [] for two identical shallow objects', () => {
    expect(diffValues({ a: 1, b: 2 }, { a: 1, b: 2 })).toHaveLength(0);
  });

  it('returns the differing key for a single changed field', () => {
    const result = diffValues({ allow: true }, { allow: false });
    expect(result).toEqual(['allow']);
  });

  it('returns the key for a field present in A but missing in B', () => {
    const result = diffValues({ allow: true, extra: 1 }, { allow: true });
    expect(result).toEqual(['extra']);
  });

  it('returns the key for a field present in B but missing in A', () => {
    const result = diffValues({ allow: true }, { allow: true, extra: 1 });
    expect(result).toEqual(['extra']);
  });

  it('returns nested dot-path for deeply changed field', () => {
    const a = { user: { role: 'admin' } };
    const b = { user: { role: 'viewer' } };
    expect(diffValues(a, b)).toEqual(['user.role']);
  });

  it('returns ["."] for arrays with different lengths', () => {
    expect(diffValues([1, 2], [1])).toEqual(['.']);
    expect(diffValues([], [1])).toEqual(['.']);
  });

  it('returns [] for two identical arrays', () => {
    expect(diffValues([1, 2, 3], [1, 2, 3])).toHaveLength(0);
  });

  it('returns bracket-path for a changed array element', () => {
    expect(diffValues([1, 2, 3], [1, 9, 3])).toEqual(['[1]']);
  });

  it('returns multiple paths when several things differ', () => {
    const a = { allow: true, role: 'admin' };
    const b = { allow: false, role: 'viewer' };
    const result = diffValues(a, b);
    expect(result).toContain('allow');
    expect(result).toContain('role');
    expect(result).toHaveLength(2);
  });

  it('uses path prefix correctly in nested arrays', () => {
    const a = { items: [1, 2] };
    const b = { items: [1, 9] };
    expect(diffValues(a, b)).toEqual(['items[1]']);
  });
});

// ─── rego_policy_diff tool ────────────────────────────────────────────────────

describe('rego_policy_diff tool', () => {
  it('returns equal: true when both policies produce identical results', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaResult(true) });
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaResult(true) });
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: 'package x\nimport rego.v1\nallow if true',
      sourceB: 'package x\nimport rego.v1\nallow if true',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(true);
    expect(env.data?.changedPaths).toHaveLength(0);
    expect(env.data?.resultA).toBe(true);
    expect(env.data?.resultB).toBe(true);
  });

  it('returns equal: false and changedPaths when results differ', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaResult(true) });
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaEmpty });
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: 'package x',
      sourceB: 'package x',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(false);
    expect(env.data?.changedPaths).toEqual(['.']);
    // Both evals use inline source, so both go through withTempSource()'s async
    // writeFile. With Promise.all the write completion order is non-deterministic
    // across platforms -- assert the set of values rather than their assignment.
    const results = [env.data?.resultA, env.data?.resultB];
    expect(results).toContain(true);
    expect(results).toContain(undefined);
  });

  it('returns equal: true when both sides return undefined (empty result)', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaEmpty });
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaEmpty });
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: 'package x',
      sourceB: 'package x',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(true);
    expect(env.data?.resultA).toBeUndefined();
    expect(env.data?.resultB).toBeUndefined();
  });

  it('echoes the query in output', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaEmpty });
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaEmpty });
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: 'package x',
      sourceB: 'package x',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.query).toBe('data.x.allow');
  });

  it('returns INVALID_REGO when policy A fails to evaluate', async () => {
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      exitCode: 2,
      stdout: opaError('unexpected token'),
      stderr: '1 error occurred',
    });
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaResult(true) });
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool(server, 'rego_policy_diff', {
      sourceA: 'package bad\n[broken',
      sourceB: 'package x',
      query: 'data.bad.allow',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('INVALID_REGO');
  });

  it('returns INVALID_REGO when policy B fails to evaluate', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaResult(true) });
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      exitCode: 2,
      stderr: 'rego_parse_error',
    });
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool(server, 'rego_policy_diff', {
      sourceA: 'package x',
      sourceB: 'package bad\n[broken',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('INVALID_REGO');
  });

  it('returns OPA_BINARY_NOT_FOUND when the binary is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool(server, 'rego_policy_diff', {
      sourceA: 'package x',
      sourceB: 'package x',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('OPA_BINARY_NOT_FOUND');
  });

  it('returns INVALID_INPUT when neither sourceA nor pathA is given', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool(server, 'rego_policy_diff', {
      sourceB: 'package x',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT when both sourceA and pathA are given', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool(server, 'rego_policy_diff', {
      sourceA: 'package x',
      pathA: fixturePath('policies', 'valid', 'rbac.rego'),
      sourceB: 'package x',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT when neither sourceB nor pathB is given', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool(server, 'rego_policy_diff', {
      sourceA: 'package x',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT when both input and inputPath are given', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool(server, 'rego_policy_diff', {
      sourceA: 'package x',
      sourceB: 'package x',
      query: 'data.x.allow',
      input: { role: 'admin' },
      inputPath: fixturePath('inputs', 'rbac.json'),
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('returns PATH_NOT_ALLOWED for pathA outside allowed roots', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool(server, 'rego_policy_diff', {
      pathA: '/etc/passwd',
      sourceB: 'package x',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('returns PATH_NOT_ALLOWED for pathB outside allowed roots', async () => {
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool(server, 'rego_policy_diff', {
      sourceA: 'package x',
      pathB: '/etc/passwd',
      query: 'data.x.allow',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('surfaces changedPaths for object results with nested differences', async () => {
    const objA = { allow: true, reasons: ['admin-grant'] };
    const objB = { allow: false, reasons: [] };
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaResult(objA) });
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaResult(objB) });
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      sourceA: 'package x',
      sourceB: 'package x',
      query: 'data.x',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(false);
    expect(env.data?.changedPaths).toContain('allow');
    expect(env.data?.changedPaths).toContain('reasons');
  });

  it('accepts pathA pointing to fixture file', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaResult(true) });
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: opaResult(true) });
    const server = makeServer();
    registerRegoPolicyDiff(server, baseConfig);
    const env = await callTool<RegoPolicyDiffOutput>(server, 'rego_policy_diff', {
      pathA: fixturePath('policies', 'valid', 'rbac.rego'),
      pathB: fixturePath('policies', 'valid', 'rbac.rego'),
      query: 'data.rbac.allow',
      input: { role: 'admin' },
    });
    expect(env.ok).toBe(true);
    expect(env.data?.equal).toBe(true);
    // Verify subprocess was called twice (both evals ran)
    expect(mockRun).toHaveBeenCalledTimes(2);
  });
});
