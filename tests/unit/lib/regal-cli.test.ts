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
      expect(args[args.length - 1]).toMatch(/orygn-opa-mcp-.*\.rego$/);
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
