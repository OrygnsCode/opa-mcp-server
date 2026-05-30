import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../../src/config.js';
import { RegalCli } from '../../../src/lib/regal-cli.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

const mockRun = vi.mocked(runBinary);

const baseConfig: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: 'opa',
  regalBinary: 'regal',
  conftestBinary: 'conftest',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: '/tmp/test.log',
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

const okSpawn = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  durationMs: 1,
};

describe('RegalCli', () => {
  let regal: RegalCli;

  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue(okSpawn);
    regal = new RegalCli(baseConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('version()', () => {
    it('parses a "Version:" line', async () => {
      mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: 'Version: 0.30.0\nGo: ...' });
      expect(await regal.version()).toBe('0.30.0');
    });

    it('falls back to a bare semver match', async () => {
      mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: 'regal v0.30.0' });
      expect(await regal.version()).toBe('0.30.0');
    });

    it('returns null when the binary is unreachable', async () => {
      mockRun.mockResolvedValueOnce({ ...okSpawn, exitCode: 1 });
      expect(await regal.version()).toBeNull();
    });
  });

  describe('lint()', () => {
    it('passes paths through directly', async () => {
      await regal.lint({ paths: ['/abs/policies'] });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args.slice(0, 3)).toEqual(['lint', '--format=json', '--no-color']);
      expect(args[args.length - 1]).toBe('/abs/policies');
    });

    it('writes inline source to a temp file and lints it', async () => {
      await regal.lint({ source: 'package x' });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args[args.length - 1]).toMatch(/orygn-regal-mcp-[^/\\]+[/\\]input\.rego$/);
    });

    it('throws when neither source nor paths are provided', async () => {
      await expect(regal.lint({})).rejects.toThrow(/either source or at least one path/);
    });

    it('emits per-rule and per-category enable/disable flags', async () => {
      await regal.lint({
        paths: ['/abs/p'],
        disable: ['print-or-trace-call'],
        disableCategory: ['style'],
        enable: ['no-defined-rule-not-used'],
        enableCategory: ['idiomatic'],
      });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toContain('--disable');
      expect(args).toContain('print-or-trace-call');
      expect(args).toContain('--disable-category');
      expect(args).toContain('style');
      expect(args).toContain('--enable');
      expect(args).toContain('no-defined-rule-not-used');
      expect(args).toContain('--enable-category');
      expect(args).toContain('idiomatic');
    });

    it('emits --disable-all and --enable-all when set', async () => {
      await regal.lint({ paths: ['/abs/p'], disableAll: true, enableAll: true });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toContain('--disable-all');
      expect(args).toContain('--enable-all');
    });

    it('auto-disables directory-package-mismatch when source is inline', async () => {
      await regal.lint({ source: 'package x' });
      const args = mockRun.mock.calls[0]![1].args;
      const disabledRules = args
        .map((a, i) => (a === '--disable' ? args[i + 1] : null))
        .filter((r): r is string => r !== null);
      expect(disabledRules).toContain('directory-package-mismatch');
    });

    it('does NOT auto-disable directory-package-mismatch when paths are used', async () => {
      await regal.lint({ paths: ['/abs/p'] });
      const args = mockRun.mock.calls[0]![1].args;
      const disabledRules = args
        .map((a, i) => (a === '--disable' ? args[i + 1] : null))
        .filter((r): r is string => r !== null);
      expect(disabledRules).not.toContain('directory-package-mismatch');
    });

    it('respects an explicit enable for directory-package-mismatch on inline source', async () => {
      await regal.lint({ source: 'package x', enable: ['directory-package-mismatch'] });
      const args = mockRun.mock.calls[0]![1].args;
      const disabledRules = args
        .map((a, i) => (a === '--disable' ? args[i + 1] : null))
        .filter((r): r is string => r !== null);
      const enabledRules = args
        .map((a, i) => (a === '--enable' ? args[i + 1] : null))
        .filter((r): r is string => r !== null);
      expect(disabledRules).not.toContain('directory-package-mismatch');
      expect(enabledRules).toContain('directory-package-mismatch');
    });

    it('does not double-emit --disable when caller already disabled the rule', async () => {
      await regal.lint({ source: 'package x', disable: ['directory-package-mismatch'] });
      const args = mockRun.mock.calls[0]![1].args;
      const occurrences = args.filter((a) => a === 'directory-package-mismatch').length;
      expect(occurrences).toBe(1);
    });

    it('emits --config-file, --fail-level, and --ignore-files when set', async () => {
      await regal.lint({
        paths: ['/abs/p'],
        configFile: '/abs/.regal.yaml',
        failLevel: 'warning',
        ignoreFiles: ['vendor/**', '*.test.rego'],
      });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toContain('--config-file');
      expect(args).toContain('/abs/.regal.yaml');
      expect(args).toContain('--fail-level');
      expect(args).toContain('warning');
      const ignoreCount = args.filter((a) => a === '--ignore-files').length;
      expect(ignoreCount).toBe(2);
    });
  });

  describe('fix()', () => {
    it('passes paths as positional args with --no-color', async () => {
      await regal.fix({ paths: ['/abs/policy.rego'] });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args[0]).toBe('fix');
      expect(args).toContain('--no-color');
      expect(args[args.length - 1]).toBe('/abs/policy.rego');
    });

    it('adds --dry-run when dryRun is true', async () => {
      await regal.fix({ paths: ['/abs/policy.rego'], dryRun: true });
      expect(mockRun.mock.calls[0]![1].args).toContain('--dry-run');
    });

    it('adds --force when force is true', async () => {
      await regal.fix({ paths: ['/abs/policy.rego'], force: true });
      expect(mockRun.mock.calls[0]![1].args).toContain('--force');
    });

    it('omits --dry-run and --force when not set', async () => {
      await regal.fix({ paths: ['/abs/policy.rego'] });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).not.toContain('--dry-run');
      expect(args).not.toContain('--force');
    });

    it('emits per-rule disable and enable flags', async () => {
      await regal.fix({
        paths: ['/abs/p'],
        disable: ['directory-package-mismatch'],
        enable: ['opa-fmt'],
      });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toContain('--disable');
      expect(args).toContain('directory-package-mismatch');
      expect(args).toContain('--enable');
      expect(args).toContain('opa-fmt');
    });

    it('emits --config-file and --ignore-files when set', async () => {
      await regal.fix({
        paths: ['/abs/p'],
        configFile: '/abs/.regal.yaml',
        ignoreFiles: ['vendor/**'],
      });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toContain('--config-file');
      expect(args).toContain('/abs/.regal.yaml');
      expect(args).toContain('--ignore-files');
      expect(args).toContain('vendor/**');
    });

    it('throws when paths is empty', async () => {
      await expect(regal.fix({ paths: [] })).rejects.toThrow(/at least one path/);
    });
  });

  describe('run()', () => {
    it('uses the configured regal binary', async () => {
      const customRegal = new RegalCli({ ...baseConfig, regalBinary: '/custom/regal' });
      await customRegal.run(['version']);
      expect(mockRun).toHaveBeenCalledWith(
        '/custom/regal',
        expect.objectContaining({ args: ['version'] }),
      );
    });
  });
});
