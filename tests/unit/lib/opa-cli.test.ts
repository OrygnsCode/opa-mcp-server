import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../../src/config.js';
import { OpaCli } from '../../../src/lib/opa-cli.js';

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

describe('OpaCli', () => {
  let opa: OpaCli;

  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue(okSpawn);
    opa = new OpaCli(baseConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('version()', () => {
    it('parses the version line from opa output', async () => {
      mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: 'Version: 0.69.0\nBuild: ...' });
      expect(await opa.version()).toBe('0.69.0');
    });

    it('returns null when the binary fails', async () => {
      mockRun.mockResolvedValueOnce({ ...okSpawn, exitCode: 1, stderr: 'oops' });
      expect(await opa.version()).toBeNull();
    });

    it('returns null when output does not match', async () => {
      mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: 'unexpected output' });
      expect(await opa.version()).toBeNull();
    });
  });

  describe('fmt()', () => {
    it('writes source to a temp file and passes the path to opa fmt', async () => {
      await opa.fmt({ source: 'package x' });
      expect(mockRun).toHaveBeenCalledOnce();
      const [binary, opts] = mockRun.mock.calls[0]!;
      expect(binary).toBe('opa');
      expect(opts.args[0]).toBe('fmt');
      expect(opts.args[1]).toMatch(/orygn-opa-mcp-.*\.rego$/);
      expect(opts.stdin).toBeUndefined();
    });
  });

  describe('check()', () => {
    it('uses inline source via temp file when provided', async () => {
      await opa.check({ source: 'package y' });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args.slice(0, 2)).toEqual(['check', '--format=json']);
      expect(opts.args[opts.args.length - 1]).toMatch(/\.rego$/);
    });

    it('passes paths through directly when no source', async () => {
      await opa.check({ paths: ['/abs/policy.rego'] });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toEqual(['check', '--format=json', '/abs/policy.rego']);
    });

    it('adds --strict, --capabilities, and --schema when set', async () => {
      await opa.check({
        paths: ['/abs/policy.rego'],
        strict: true,
        capabilities: '/abs/caps.json',
        schemaDir: '/abs/schemas',
      });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toContain('--strict');
      expect(opts.args).toContain('--capabilities');
      expect(opts.args).toContain('/abs/caps.json');
      expect(opts.args).toContain('--schema');
      expect(opts.args).toContain('/abs/schemas');
    });

    it('throws when neither source nor paths are provided', async () => {
      await expect(opa.check({})).rejects.toThrow(/either source or at least one path/);
    });
  });

  describe('parse()', () => {
    it('uses --format=json with a temp source path', async () => {
      await opa.parse({ source: 'package z' });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args[0]).toBe('parse');
      expect(opts.args).toContain('--format=json');
      expect(opts.args[opts.args.length - 1]).toMatch(/\.rego$/);
    });
  });

  describe('inspect()', () => {
    it('passes the target path positionally', async () => {
      await opa.inspect({ target: '/abs/bundle.tar.gz' });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toEqual(['inspect', '--format=json', '/abs/bundle.tar.gz']);
    });
  });

  describe('capabilities()', () => {
    it('runs without flags by default', async () => {
      await opa.capabilities();
      expect(mockRun.mock.calls[0]![1].args).toEqual(['capabilities']);
    });

    it('adds --current and --version when set', async () => {
      await opa.capabilities({ current: true, version: 'v0.69.0' });
      expect(mockRun.mock.calls[0]![1].args).toEqual([
        'capabilities',
        '--current',
        '--version',
        'v0.69.0',
      ]);
    });
  });

  describe('deps()', () => {
    it('passes data flags per path and ref last', async () => {
      await opa.deps({ paths: ['/a', '/b'], ref: 'data.example.allow' });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toEqual([
        'deps',
        '--format=json',
        '--data',
        '/a',
        '--data',
        '/b',
        'data.example.allow',
      ]);
    });

    it('throws when paths is empty', async () => {
      await expect(opa.deps({ paths: [], ref: 'data.x' })).rejects.toThrow(/at least one path/);
    });
  });

  describe('eval()', () => {
    it('emits the basic argv form for a simple query against paths', async () => {
      await opa.eval({ query: 'data.x.allow', paths: ['/abs/p'] });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toEqual([
        'eval',
        '--format=json',
        '--data',
        '/abs/p',
        'data.x.allow',
      ]);
    });

    it('writes inline source to a temp file and adds it to --data', async () => {
      await opa.eval({ query: 'data.x.allow', source: 'package x\nallow := true' });
      const [, opts] = mockRun.mock.calls[0]!;
      const dataIndex = opts.args.indexOf('--data');
      expect(dataIndex).toBeGreaterThan(-1);
      expect(opts.args[dataIndex + 1]).toMatch(/\.rego$/);
      expect(opts.args[opts.args.length - 1]).toBe('data.x.allow');
    });

    it('pipes inline input via --stdin-input', async () => {
      await opa.eval({ query: 'input.x', input: { x: 1 } });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toContain('--stdin-input');
      expect(opts.stdin).toBe('{"x":1}');
    });

    it('uses --input file path when inputPath is set', async () => {
      await opa.eval({ query: 'input.x', inputPath: '/abs/i.json' });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toContain('--input');
      expect(opts.args).toContain('/abs/i.json');
      expect(opts.args).not.toContain('--stdin-input');
    });

    it('attaches explain, profile, coverage, metrics flags when set', async () => {
      await opa.eval({
        query: 'data.x',
        explain: 'full',
        profile: true,
        coverage: true,
        metrics: true,
        instrument: true,
      });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toContain('--explain');
      expect(args).toContain('full');
      expect(args).toContain('--profile');
      expect(args).toContain('--coverage');
      expect(args).toContain('--metrics');
      expect(args).toContain('--instrument');
    });

    it('emits --partial and per-ref --unknowns', async () => {
      await opa.eval({ query: 'data.x', partial: true, unknowns: ['input.user', 'input.action'] });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toContain('--partial');
      const u1 = args.indexOf('--unknowns');
      expect(u1).toBeGreaterThan(-1);
      expect(args[u1 + 1]).toBe('input.user');
      expect(args.lastIndexOf('--unknowns')).toBeGreaterThan(u1);
    });
  });

  describe('test()', () => {
    it('passes --verbose / --coverage / --bench / --run when set', async () => {
      await opa.test({
        paths: ['/abs/tests'],
        verbose: true,
        coverage: true,
        bench: true,
        runPattern: '^TestAllow',
      });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toEqual([
        'test',
        '--format=json',
        '--verbose',
        '--coverage',
        '--bench',
        '--run',
        '^TestAllow',
        '/abs/tests',
      ]);
    });

    it('throws when paths is empty', async () => {
      await expect(opa.test({ paths: [] })).rejects.toThrow(/at least one path/);
    });
  });

  describe('bench()', () => {
    it('emits the basic bench argv form', async () => {
      await opa.bench({ query: 'data.x', paths: ['/abs/p'], count: 10 });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toEqual([
        'bench',
        '--format=json',
        '--data',
        '/abs/p',
        '--count',
        '10',
        'data.x',
      ]);
    });

    it('pipes inline input via --stdin-input', async () => {
      await opa.bench({ query: 'data.x', input: { a: 'b' } });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toContain('--stdin-input');
      expect(opts.stdin).toBe('{"a":"b"}');
    });
  });

  describe('build()', () => {
    it('emits all bundle build flags in order', async () => {
      await opa.build({
        paths: ['/abs/policies'],
        output: '/abs/bundle.tar.gz',
        optimize: 2,
        revision: 'rev-1',
        target: 'rego',
        entrypoints: ['main/allow'],
        signingKey: '/abs/key.pem',
        signingAlg: 'RS256',
        claimsFile: '/abs/claims.json',
        capabilities: '/abs/caps.json',
      });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args[0]).toBe('build');
      expect(args).toContain('-o');
      expect(args).toContain('/abs/bundle.tar.gz');
      expect(args).toContain('--optimize');
      expect(args).toContain('2');
      expect(args).toContain('--revision');
      expect(args).toContain('rev-1');
      expect(args).toContain('--target');
      expect(args).toContain('rego');
      expect(args).toContain('--entrypoint');
      expect(args).toContain('main/allow');
      expect(args).toContain('--signing-key');
      expect(args).toContain('--signing-alg');
      expect(args).toContain('--claims-file');
      expect(args).toContain('--capabilities');
      expect(args[args.length - 1]).toBe('/abs/policies');
    });

    it('throws when paths is empty', async () => {
      await expect(opa.build({ paths: [], output: '/x.tar.gz' })).rejects.toThrow(
        /at least one input path/,
      );
    });
  });

  describe('sign()', () => {
    it('emits sign argv with the bundle as a flag (not positional)', async () => {
      await opa.sign({ bundle: '/abs/bundle.tar.gz', signingKey: '/abs/key.pem' });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toEqual([
        'sign',
        '--signing-key',
        '/abs/key.pem',
        '--bundle',
        '/abs/bundle.tar.gz',
      ]);
    });
  });

  describe('run()', () => {
    it('forwards stdin when provided', async () => {
      await opa.run(['fmt', '/abs/p.rego'], 'package x');
      expect(mockRun).toHaveBeenCalledWith('opa', {
        args: ['fmt', '/abs/p.rego'],
        timeoutMs: 30_000,
        stdin: 'package x',
      });
    });

    it('omits stdin when not provided', async () => {
      await opa.run(['version']);
      expect(mockRun).toHaveBeenCalledWith('opa', {
        args: ['version'],
        timeoutMs: 30_000,
      });
    });

    it('uses the configured opa binary path', async () => {
      const customOpa = new OpaCli({ ...baseConfig, opaBinary: '/custom/opa' });
      await customOpa.run(['version']);
      expect(mockRun).toHaveBeenCalledWith(
        '/custom/opa',
        expect.objectContaining({ args: ['version'] }),
      );
    });
  });
});
