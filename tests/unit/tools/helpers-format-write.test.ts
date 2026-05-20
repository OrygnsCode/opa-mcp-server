import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseConfig, callTool, fixturePath, makeServer, spawnUnreachable } from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';
import {
  parseFmtListOutput,
  registerRegoFormatWrite,
  type RegoFormatWriteOutput,
} from '../../../src/tools/helpers/format-write.js';

const mockRun = vi.mocked(runBinary);
const okSpawn = { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue({ ...okSpawn });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── parseFmtListOutput unit tests ───────────────────────────────────────────

describe('parseFmtListOutput()', () => {
  it('returns empty array for empty stdout', () => {
    expect(parseFmtListOutput('')).toHaveLength(0);
    expect(parseFmtListOutput('  \n  ')).toHaveLength(0);
  });

  it('parses a single path', () => {
    const result = parseFmtListOutput('/abs/policies/rbac.rego\n');
    expect(result).toEqual(['/abs/policies/rbac.rego']);
  });

  it('parses multiple paths', () => {
    const result = parseFmtListOutput('/abs/a.rego\n/abs/b.rego\n/abs/c.rego');
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('/abs/a.rego');
    expect(result[2]).toBe('/abs/c.rego');
  });

  it('strips surrounding whitespace from each line', () => {
    const result = parseFmtListOutput('  /abs/policy.rego  \n');
    expect(result[0]).toBe('/abs/policy.rego');
  });

  it('ignores blank lines between entries', () => {
    const result = parseFmtListOutput('/abs/a.rego\n\n/abs/b.rego\n');
    expect(result).toHaveLength(2);
  });
});

// ─── rego_format_write tool tests ────────────────────────────────────────────

describe('rego_format_write tool', () => {
  it('returns empty formattedFiles and formattedCount 0 when no files need formatting', async () => {
    // fmtList returns empty stdout (all files already canonical)
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: '' });
    const server = makeServer();
    registerRegoFormatWrite(server, baseConfig);
    const env = await callTool<RegoFormatWriteOutput>(server, 'rego_format_write', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.formattedCount).toBe(0);
    expect(env.data?.formattedFiles).toHaveLength(0);
    expect(env.data?.dryRun).toBe(false);
    // Only fmtList called -- fmtWrite skipped when nothing to do
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('calls fmtWrite and returns formattedFiles on success', async () => {
    const changedPath = fixturePath('policies', 'valid', 'rbac.rego');
    // fmtList returns one file
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: changedPath + '\n' });
    // fmtWrite succeeds
    mockRun.mockResolvedValueOnce({ ...okSpawn });
    const server = makeServer();
    registerRegoFormatWrite(server, baseConfig);
    const env = await callTool<RegoFormatWriteOutput>(server, 'rego_format_write', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.formattedCount).toBe(1);
    expect(env.data?.formattedFiles[0]).toBe(changedPath);
    expect(env.data?.dryRun).toBe(false);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('echoes dryRun: true and does NOT call fmtWrite', async () => {
    const changedPath = fixturePath('policies', 'valid', 'rbac.rego');
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: changedPath + '\n' });
    const server = makeServer();
    registerRegoFormatWrite(server, baseConfig);
    const env = await callTool<RegoFormatWriteOutput>(server, 'rego_format_write', {
      paths: [fixturePath('policies', 'valid')],
      dryRun: true,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.dryRun).toBe(true);
    expect(env.data?.formattedCount).toBe(1);
    // Only one call (fmtList) -- fmtWrite must not be called in dryRun
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('returns INVALID_REGO when fmtList exits non-zero (parse error)', async () => {
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      exitCode: 2,
      stderr: 'failed to format: 1 error occurred: bad.rego:1: rego_parse_error: ...',
    });
    const server = makeServer();
    registerRegoFormatWrite(server, baseConfig);
    const env = await callTool(server, 'rego_format_write', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('INVALID_REGO');
    // fmtWrite must NOT be called after a list failure
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('returns OPA_NOT_FOUND when the binary is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerRegoFormatWrite(server, baseConfig);
    const env = await callTool(server, 'rego_format_write', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('OPA_BINARY_NOT_FOUND');
  });

  it('returns PATH_NOT_ALLOWED for paths outside allowed roots', async () => {
    const server = makeServer();
    registerRegoFormatWrite(server, baseConfig);
    const env = await callTool(server, 'rego_format_write', {
      paths: ['/etc/passwd'],
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('PATH_NOT_ALLOWED');
    // No subprocess call should happen for disallowed paths
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('surfaces formattedFiles from multiple changed files', async () => {
    const a = fixturePath('policies', 'valid', 'rbac.rego');
    const b = fixturePath('policies', 'valid', 'authz.rego');
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: `${a}\n${b}\n` });
    mockRun.mockResolvedValueOnce({ ...okSpawn });
    const server = makeServer();
    registerRegoFormatWrite(server, baseConfig);
    const env = await callTool<RegoFormatWriteOutput>(server, 'rego_format_write', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.formattedCount).toBe(2);
    expect(env.data?.formattedFiles).toContain(a);
    expect(env.data?.formattedFiles).toContain(b);
  });
});
