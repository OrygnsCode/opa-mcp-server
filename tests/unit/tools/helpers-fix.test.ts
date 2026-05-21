import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseConfig, callTool, fixturePath, makeServer, spawnUnreachable } from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';
import {
  parseFixOutput,
  registerRegoFix,
  type FixedFile,
  type RegoFixOutput,
} from '../../../src/tools/helpers/fix.js';

const mockRun = vi.mocked(runBinary);
const okSpawn = { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1 };

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue({ ...okSpawn });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── parseFixOutput unit tests ────────────────────────────────────────────────
// These test the parser in isolation so edge cases are fast and deterministic.

describe('parseFixOutput()', () => {
  it('returns zero fixCount and empty array for "No fixes to apply."', () => {
    const result = parseFixOutput('No fixes to apply.');
    expect(result.fixCount).toBe(0);
    expect(result.fixedFiles).toHaveLength(0);
  });

  it('returns zero fixCount for empty stdout', () => {
    expect(parseFixOutput('').fixCount).toBe(0);
    expect(parseFixOutput('  \n  ').fixCount).toBe(0);
  });

  it('parses a single in-place fix (no file move)', () => {
    const stdout = [
      '1 fix to apply:',
      'In project root: /abs/policies',
      'policy.rego:',
      '- opa-fmt',
    ].join('\n');
    const { fixCount, fixedFiles } = parseFixOutput(stdout);
    expect(fixCount).toBe(1);
    expect(fixedFiles).toHaveLength(1);
    expect(fixedFiles[0]!.path).toContain('policy.rego');
    expect(fixedFiles[0]!.newPath).toBeUndefined();
    expect(fixedFiles[0]!.rules).toEqual(['opa-fmt']);
  });

  it('parses a file-move fix (directory-package-mismatch)', () => {
    const stdout = [
      '1 fix to apply:',
      'In project root: /abs/policies',
      'rbac.rego -> rbac/rbac.rego:',
      '- directory-package-mismatch',
    ].join('\n');
    const { fixCount, fixedFiles } = parseFixOutput(stdout);
    expect(fixCount).toBe(1);
    const f = fixedFiles[0]!;
    expect(f.path).toContain('rbac.rego');
    expect(f.newPath).toBeDefined();
    expect(f.newPath).toContain('rbac');
    expect(f.rules).toEqual(['directory-package-mismatch']);
  });

  it('parses multiple rules on a single file', () => {
    const stdout = [
      '2 fixes to apply:',
      'In project root: /abs/policies',
      'policy.rego:',
      '- opa-fmt',
      '- no-whitespace-comment',
    ].join('\n');
    const { fixCount, fixedFiles } = parseFixOutput(stdout);
    expect(fixCount).toBe(2);
    expect(fixedFiles).toHaveLength(1);
    expect(fixedFiles[0]!.rules).toEqual(['opa-fmt', 'no-whitespace-comment']);
  });

  it('parses multiple files each with their own rules', () => {
    const stdout = [
      '3 fixes to apply:',
      'In project root: /abs/policies',
      'a.rego:',
      '- opa-fmt',
      'b.rego:',
      '- use-rego-v1',
      '- use-assignment-operator',
    ].join('\n');
    const { fixCount, fixedFiles } = parseFixOutput(stdout);
    expect(fixCount).toBe(3);
    expect(fixedFiles).toHaveLength(2);
    expect(fixedFiles[0]!.rules).toEqual(['opa-fmt']);
    expect(fixedFiles[1]!.rules).toEqual(['use-rego-v1', 'use-assignment-operator']);
  });

  it('handles "1 fix to apply" (singular) correctly', () => {
    const stdout = ['1 fix to apply:', 'In project root: /abs', 'x.rego:', '- opa-fmt'].join('\n');
    expect(parseFixOutput(stdout).fixCount).toBe(1);
  });

  it('handles "10 fixes to apply" (plural) correctly', () => {
    const stdout = ['10 fixes to apply:', 'In project root: /abs'].join('\n');
    expect(parseFixOutput(stdout).fixCount).toBe(10);
  });
});

// ─── rego_fix tool tests ──────────────────────────────────────────────────────

describe('rego_fix tool', () => {
  it('returns structured output with fixCount and fixedFiles on success', async () => {
    const stdout = [
      '1 fix to apply:',
      'In project root: /abs/policies',
      'rbac.rego:',
      '- opa-fmt',
    ].join('\n');
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout });
    const server = makeServer();
    registerRegoFix(server, baseConfig);
    const env = await callTool<RegoFixOutput>(server, 'rego_fix', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.fixCount).toBe(1);
    expect(env.data?.fixedFiles).toHaveLength(1);
    expect(env.data?.dryRun).toBe(false);
  });

  it('echoes dryRun: true in output when requested', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: 'No fixes to apply.' });
    const server = makeServer();
    registerRegoFix(server, baseConfig);
    const env = await callTool<RegoFixOutput>(server, 'rego_fix', {
      paths: [fixturePath('policies', 'valid')],
      dryRun: true,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.dryRun).toBe(true);
  });

  it('returns fixCount 0 and empty fixedFiles when nothing to fix', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: 'No fixes to apply.' });
    const server = makeServer();
    registerRegoFix(server, baseConfig);
    const env = await callTool<RegoFixOutput>(server, 'rego_fix', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(true);
    expect(env.data?.fixCount).toBe(0);
    expect(env.data?.fixedFiles).toHaveLength(0);
  });

  it('surfaces newPath on fixedFile when directory-package-mismatch is applied', async () => {
    const stdout = [
      '1 fix to apply:',
      'In project root: /abs/policies',
      'rbac.rego -> rbac/rbac.rego:',
      '- directory-package-mismatch',
    ].join('\n');
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout });
    const server = makeServer();
    registerRegoFix(server, baseConfig);
    const env = await callTool<RegoFixOutput>(server, 'rego_fix', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(true);
    const f = env.data?.fixedFiles[0] as FixedFile;
    expect(f.newPath).toBeDefined();
    expect(f.rules).toContain('directory-package-mismatch');
  });

  it('returns REGAL_NOT_FOUND when the binary is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerRegoFix(server, baseConfig);
    const env = await callTool(server, 'rego_fix', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('REGAL_NOT_FOUND');
  });

  it('returns UNKNOWN_ERROR when regal fix exits non-zero', async () => {
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      exitCode: 1,
      stderr: 'failed to fix: could not parse module',
    });
    const server = makeServer();
    registerRegoFix(server, baseConfig);
    const env = await callTool(server, 'rego_fix', {
      paths: [fixturePath('policies', 'valid')],
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('UNKNOWN_ERROR');
  });

  it('returns PATH_NOT_ALLOWED for paths outside allowed roots', async () => {
    const server = makeServer();
    registerRegoFix(server, baseConfig);
    const env = await callTool(server, 'rego_fix', {
      paths: ['/etc/passwd'],
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects configFile outside allowed roots', async () => {
    const server = makeServer();
    registerRegoFix(server, baseConfig);
    const env = await callTool(server, 'rego_fix', {
      paths: [fixturePath('policies', 'valid')],
      configFile: '/etc/regal/config.yaml',
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects a configFile that does not exist inside the allowed root', async () => {
    const server = makeServer();
    registerRegoFix(server, baseConfig);
    const env = await callTool(server, 'rego_fix', {
      paths: [fixturePath('policies', 'valid')],
      configFile: fixturePath('nonexistent-fix-config.yaml'),
    });
    expect(env.ok).toBe(false);
    expect((env as { error: { code: string } }).error.code).toBe('PATH_NOT_FOUND');
  });
});
