/**
 * Unit tests for ConftestCli.
 *
 * runBinary is mocked so no real conftest binary is required. Tests
 * verify that the CLI wrapper:
 *   - builds the correct argv for each method
 *   - passes AbortSignal through to runBinary
 *   - parses the version string from conftest --version output
 *   - sanitizes inline temp paths from stdout before returning
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../../src/config.js';
import { ConftestCli } from '../../../src/lib/conftest-cli.js';

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

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue({ ...okSpawn });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── version() ───────────────────────────────────────────────────────────────

describe('ConftestCli.version()', () => {
  it('passes --version flag and returns parsed version string', async () => {
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      stdout: 'conftest (version: 0.68.2)',
    });
    const cli = new ConftestCli(baseConfig);
    const v = await cli.version();
    expect(v).toBe('0.68.2');
    expect(mockRun).toHaveBeenCalledWith(
      'conftest',
      expect.objectContaining({ args: ['--version'] }),
    );
  });

  it('returns null when binary exits non-zero', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, exitCode: 1 });
    expect(await new ConftestCli(baseConfig).version()).toBeNull();
  });

  it('returns null when output contains no version pattern', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: 'something unexpected' });
    expect(await new ConftestCli(baseConfig).version()).toBeNull();
  });

  it('handles alternative version format v0.68.2', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: 'v0.68.2' });
    expect(await new ConftestCli(baseConfig).version()).toBe('0.68.2');
  });
});

// ─── test() ──────────────────────────────────────────────────────────────────

describe('ConftestCli.test()', () => {
  it('passes files as positional args with --output=json --no-color', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/policies/config.yaml'] });
    expect(mockRun).toHaveBeenCalledWith(
      'conftest',
      expect.objectContaining({
        args: expect.arrayContaining([
          'test',
          '--output=json',
          '--no-color',
          '/policies/config.yaml',
        ]),
      }),
    );
  });

  it('passes --policy when provided', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/config.yaml'], policy: '/my/policy' });
    const { args } = mockRun.mock.calls[0]![1];
    expect(args).toContain('--policy');
    expect(args).toContain('/my/policy');
  });

  it('passes --namespace when provided (and not allNamespaces)', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/config.yaml'], namespace: 'k8s' });
    const { args } = mockRun.mock.calls[0]![1];
    expect(args).toContain('--namespace');
    expect(args).toContain('k8s');
    expect(args).not.toContain('--all-namespaces');
  });

  it('passes --all-namespaces and omits --namespace when allNamespaces is true', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/config.yaml'], allNamespaces: true, namespace: 'ignored' });
    const { args } = mockRun.mock.calls[0]![1];
    expect(args).toContain('--all-namespaces');
    expect(args).not.toContain('--namespace');
  });

  it('passes multiple --data flags', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/config.yaml'], data: ['/data/a', '/data/b'] });
    const { args } = mockRun.mock.calls[0]![1];
    const dataIdx = args.indexOf('--data');
    expect(dataIdx).toBeGreaterThan(-1);
    expect(args.filter((a) => a === '--data')).toHaveLength(2);
    expect(args).toContain('/data/a');
    expect(args).toContain('/data/b');
  });

  it('passes --combine when requested', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/config.yaml'], combine: true });
    expect(mockRun.mock.calls[0]![1].args).toContain('--combine');
  });

  it('passes --fail-on-warn when requested', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/config.yaml'], failOnWarn: true });
    expect(mockRun.mock.calls[0]![1].args).toContain('--fail-on-warn');
  });

  it('passes --parser with the given value when set', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/config.tfstate'], parser: 'json' });
    const { args } = mockRun.mock.calls[0]![1];
    expect(args).toContain('--parser');
    expect(args[args.indexOf('--parser') + 1]).toBe('json');
  });

  it('does not pass --parser when omitted', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/config.yaml'] });
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--parser');
  });

  it('forwards the AbortSignal to runBinary', async () => {
    const controller = new AbortController();
    const cli = new ConftestCli(baseConfig);
    await cli.test({ files: ['/config.yaml'] }, controller.signal);
    expect(mockRun.mock.calls[0]![1].signal).toBe(controller.signal);
  });

  it('uses config.conftestBinary as the binary name', async () => {
    const cfg = { ...baseConfig, conftestBinary: '/usr/local/bin/conftest' };
    const cli = new ConftestCli(cfg);
    await cli.test({ files: ['/config.yaml'] });
    expect(mockRun).toHaveBeenCalledWith('/usr/local/bin/conftest', expect.any(Object));
  });

  it('sanitizes inline config temp path from stdout', async () => {
    // Use mockImplementation to echo the actual temp path back in stdout.
    // The last positional arg to conftest test is the temp config file.
    mockRun.mockImplementation((_binary, opts) => {
      const actualPath = opts.args[opts.args.length - 1] as string;
      return Promise.resolve({
        ...okSpawn,
        stdout: JSON.stringify([
          {
            filename: actualPath,
            namespace: 'main',
            successes: 1,
            failures: [],
            warnings: [],
            skipped: [],
            exceptions: [],
          },
        ]),
      });
    });

    const cli = new ConftestCli(baseConfig);
    const result = await cli.test({ inlineConfig: 'foo: bar' });

    // sanitizeOutput must replace the real temp path with <inline>
    expect(result.stdout).toContain('<inline>');
    expect(result.stdout).not.toMatch(/orygn-conftest-/);
  });
});

// ─── verify() ────────────────────────────────────────────────────────────────

describe('ConftestCli.verify()', () => {
  it('builds correct argv for verify', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.verify({ policy: '/my/policy', namespace: 'main' });
    const { args } = mockRun.mock.calls[0]![1];
    expect(args[0]).toBe('verify');
    expect(args).toContain('--output=json');
    expect(args).toContain('--no-color');
    expect(args).toContain('--policy');
    expect(args).toContain('/my/policy');
    expect(args).toContain('--namespace');
    expect(args).toContain('main');
  });

  it('omits --policy when not provided', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.verify({});
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--policy');
  });

  it('forwards AbortSignal', async () => {
    const controller = new AbortController();
    await new ConftestCli(baseConfig).verify({}, controller.signal);
    expect(mockRun.mock.calls[0]![1].signal).toBe(controller.signal);
  });
});

// ─── pull() ──────────────────────────────────────────────────────────────────

describe('ConftestCli.pull()', () => {
  it('builds correct argv with url and optional policy dir', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.pull({ url: 'oci://ghcr.io/org/policies:latest', policy: '/local/policy' });
    const { args } = mockRun.mock.calls[0]![1];
    expect(args[0]).toBe('pull');
    expect(args).toContain('oci://ghcr.io/org/policies:latest');
    expect(args).toContain('--policy');
    expect(args).toContain('/local/policy');
  });

  it('omits --policy when not provided', async () => {
    await new ConftestCli(baseConfig).pull({ url: 'oci://registry/repo' });
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--policy');
  });

  it('forwards AbortSignal', async () => {
    const controller = new AbortController();
    await new ConftestCli(baseConfig).pull({ url: 'oci://x' }, controller.signal);
    expect(mockRun.mock.calls[0]![1].signal).toBe(controller.signal);
  });
});

// ─── push() ──────────────────────────────────────────────────────────────────

describe('ConftestCli.push()', () => {
  it('builds correct argv with repository and optional policy dir', async () => {
    const cli = new ConftestCli(baseConfig);
    await cli.push({ repository: 'ghcr.io/org/policies:latest', policy: '/local/policy' });
    const { args } = mockRun.mock.calls[0]![1];
    expect(args[0]).toBe('push');
    expect(args).toContain('ghcr.io/org/policies:latest');
    expect(args).toContain('--policy');
    expect(args).toContain('/local/policy');
  });

  it('omits --policy when not provided', async () => {
    await new ConftestCli(baseConfig).push({ repository: 'ghcr.io/org/policies' });
    expect(mockRun.mock.calls[0]![1].args).not.toContain('--policy');
  });
});
