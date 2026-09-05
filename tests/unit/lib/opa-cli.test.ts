import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../../src/config.js';
import { OpaCli } from '../../../src/lib/opa-cli.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

const WINDOWS = process.platform === 'win32';

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
  maxSubprocessBytes: 32 * 1024 * 1024,
};

const okSpawn = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
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
      expect(opts.args[1]).toMatch(/orygn-opa-mcp-[^/\\]+[/\\]input\.rego$/);
      expect(opts.stdin).toBeUndefined();
    });
  });

  describe('fmtList()', () => {
    it('builds [fmt, --list, ...paths]', async () => {
      await opa.fmtList({ paths: ['/abs/policy.rego'] });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args.slice(0, 2)).toEqual(['fmt', '--list']);
      expect(args[args.length - 1]).toBe('/abs/policy.rego');
    });

    it('does not include --write', async () => {
      await opa.fmtList({ paths: ['/abs/p.rego'] });
      expect(mockRun.mock.calls[0]![1].args).not.toContain('--write');
    });

    it('adds --rego-v1 when set', async () => {
      await opa.fmtList({ paths: ['/abs/p.rego'], regoV1: true });
      expect(mockRun.mock.calls[0]![1].args).toContain('--rego-v1');
    });

    it('adds --v0-compatible and --v1-compatible when set', async () => {
      await opa.fmtList({ paths: ['/abs/p.rego'], v0Compatible: true, v1Compatible: true });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toContain('--v0-compatible');
      expect(args).toContain('--v1-compatible');
    });

    it('throws when paths is empty', async () => {
      await expect(opa.fmtList({ paths: [] })).rejects.toThrow(/at least one path/);
    });
  });

  describe('fmtWrite()', () => {
    it('builds [fmt, --write, ...paths]', async () => {
      await opa.fmtWrite({ paths: ['/abs/policy.rego'] });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args.slice(0, 2)).toEqual(['fmt', '--write']);
      expect(args[args.length - 1]).toBe('/abs/policy.rego');
    });

    it('does not include --list', async () => {
      await opa.fmtWrite({ paths: ['/abs/p.rego'] });
      expect(mockRun.mock.calls[0]![1].args).not.toContain('--list');
    });

    it('adds --rego-v1 when set', async () => {
      await opa.fmtWrite({ paths: ['/abs/p.rego'], regoV1: true });
      expect(mockRun.mock.calls[0]![1].args).toContain('--rego-v1');
    });

    it('passes multiple paths as positional args', async () => {
      await opa.fmtWrite({ paths: ['/abs/a.rego', '/abs/b.rego'] });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args[args.length - 2]).toBe('/abs/a.rego');
      expect(args[args.length - 1]).toBe('/abs/b.rego');
    });

    it('throws when paths is empty', async () => {
      await expect(opa.fmtWrite({ paths: [] })).rejects.toThrow(/at least one path/);
    });
  });

  describe('check()', () => {
    it('uses inline source via temp file when provided', async () => {
      await opa.check({ source: 'package y' });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args.slice(0, 2)).toEqual(['check', '--format=json']);
      expect(opts.args[opts.args.length - 1]).toMatch(/\.rego$/);
    });

    it("runs from the temp file's directory, where the loader can open it", async () => {
      await opa.check({ source: 'package y' });
      const [, opts] = mockRun.mock.calls[0]!;
      const file = opts.args[opts.args.length - 1]!;
      if (WINDOWS) expect(opts.cwd).toBe(dirname(file));
      else expect(opts.cwd).toBeUndefined();
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

    it('omits --json-include when includeLocations is not set', async () => {
      await opa.parse({ source: 'package z' });
      expect(mockRun.mock.calls[0]![1].args).not.toContain('--json-include');
    });

    it('adds --json-include locations,-comments when includeLocations: true', async () => {
      await opa.parse({ source: 'package z', includeLocations: true });
      const args = mockRun.mock.calls[0]![1].args;
      const idx = args.indexOf('--json-include');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('locations,-comments');
    });

    it('omits --json-include when includeLocations: false', async () => {
      await opa.parse({ source: 'package z', includeLocations: false });
      expect(mockRun.mock.calls[0]![1].args).not.toContain('--json-include');
    });

    it('places --json-include before the temp file path', async () => {
      await opa.parse({ source: 'package z', includeLocations: true });
      const args = mockRun.mock.calls[0]![1].args;
      const jsonIncludeIdx = args.indexOf('--json-include');
      const tempFileIdx = args.length - 1;
      expect(jsonIncludeIdx).toBeGreaterThan(-1);
      expect(jsonIncludeIdx).toBeLessThan(tempFileIdx);
    });
  });

  describe('inspect()', () => {
    it("runs from the target's directory, where the loader can open it", async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orygn-inspect-'));
      try {
        const file = join(dir, 'p.rego');
        await writeFile(file, 'package p');
        await opa.inspect({ target: file });
        const [, opts] = mockRun.mock.calls[0]!;
        expect(opts.args).toEqual(['inspect', '--format=json', '--annotations', file]);
        if (WINDOWS) expect(opts.cwd).toBe(dir);
        else expect(opts.cwd).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('passes the target path positionally', async () => {
      await opa.inspect({ target: '/abs/bundle.tar.gz' });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toEqual([
        'inspect',
        '--format=json',
        '--annotations',
        '/abs/bundle.tar.gz',
      ]);
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
    it('passes each import as --import, alias included', async () => {
      await opa.eval({
        query: 'lib.ok; t == "gold"',
        source: 'package authz',
        package: 'authz',
        imports: ['data.lib', 'input.tier as t'],
      });
      const [, opts] = mockRun.mock.calls[0]!;
      const flags = opts.args.map((a, i) => (a === '--import' ? opts.args[i + 1] : undefined));
      expect(flags.filter(Boolean)).toEqual(['data.lib', 'input.tier as t']);
    });

    it('passes --package so a bare rule reference resolves in that package', async () => {
      await opa.eval({
        query: 'is_admin; input.tier == "gold"',
        source: 'package authz',
        package: 'authz',
      });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toContain('--package');
      expect(opts.args[opts.args.indexOf('--package') + 1]).toBe('authz');
    });

    it('emits the basic argv form for a simple query against paths', async () => {
      await opa.eval({ query: 'data.x.allow', paths: ['/abs/p'] });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.args).toEqual(['eval', '--format=json', '--data', '/abs/p', 'data.x.allow']);
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

    it('re-hydrates a JSON-string input before piping it as stdin', async () => {
      // MCP clients serialize structured args (z.unknown()) as JSON strings;
      // without re-hydration OPA would receive a quoted string, not the object,
      // and every `input.*` reference would be undefined.
      await opa.eval({ query: 'input.x', input: '{"x":1}' });
      const [, opts] = mockRun.mock.calls[0]!;
      expect(opts.stdin).toBe('{"x":1}');
    });
  });

  describe('test()', () => {
    it('passes --verbose / --coverage / --bench / --run / --var-values / --threshold when set', async () => {
      await opa.test({
        paths: ['/abs/tests'],
        verbose: true,
        coverage: true,
        bench: true,
        runPattern: '^TestAllow',
        varValues: true,
        threshold: 80,
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
        '--var-values',
        '--threshold',
        '80',
        '/abs/tests',
      ]);
    });

    it('passes --threshold as a string-encoded number', async () => {
      await opa.test({ paths: ['/abs/tests'], threshold: 75.5 });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args).toContain('--threshold');
      expect(args[args.indexOf('--threshold') + 1]).toBe('75.5');
    });

    it('omits --threshold when not set', async () => {
      await opa.test({ paths: ['/abs/tests'] });
      expect(mockRun.mock.calls[0]![1].args).not.toContain('--threshold');
    });

    it('passes --var-values when varValues: true', async () => {
      await opa.test({ paths: ['/abs/tests'], varValues: true });
      expect(mockRun.mock.calls[0]![1].args).toContain('--var-values');
    });

    it('omits --var-values when varValues is false', async () => {
      await opa.test({ paths: ['/abs/tests'], varValues: false });
      expect(mockRun.mock.calls[0]![1].args).not.toContain('--var-values');
    });

    it('omits --var-values when varValues is not set', async () => {
      await opa.test({ paths: ['/abs/tests'] });
      expect(mockRun.mock.calls[0]![1].args).not.toContain('--var-values');
    });

    it('places --var-values before --threshold in argv', async () => {
      await opa.test({ paths: ['/abs/tests'], varValues: true, threshold: 70 });
      const args = mockRun.mock.calls[0]![1].args;
      const varValuesIdx = args.indexOf('--var-values');
      const thresholdIdx = args.indexOf('--threshold');
      expect(varValuesIdx).toBeGreaterThan(-1);
      expect(thresholdIdx).toBeGreaterThan(-1);
      expect(varValuesIdx).toBeLessThan(thresholdIdx);
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

    it('re-hydrates a JSON-string input before piping it as stdin', async () => {
      await opa.bench({ query: 'data.x', input: '{"a":"b"}' });
      const [, opts] = mockRun.mock.calls[0]!;
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
    it('emits --bundle as a flag, an explicit output path, and the bundle after --', async () => {
      await opa.sign({
        bundle: 'bundle',
        signingKey: '/abs/key.pem',
        outputDir: '/abs/parent/bundle',
        cwd: tmpdir(),
      });
      const call = mockRun.mock.calls[0]![1];
      expect(call.args).toEqual([
        'sign',
        '--bundle',
        '--signing-key',
        '/abs/key.pem',
        '--output-file-path',
        '/abs/parent/bundle',
        '--',
        'bundle',
      ]);
      expect(call.cwd).toBe(tmpdir());
    });

    it('runs without a working directory when none is given', async () => {
      await opa.sign({ bundle: '/abs/b.tar.gz', signingKey: '/abs/k', outputDir: '/abs' });
      expect(mockRun.mock.calls[0]![1].cwd).toBeUndefined();
    });

    it('places signingAlg and claimsFile before the output path', async () => {
      await opa.sign({
        bundle: '/abs/b',
        signingKey: '/abs/k',
        signingAlg: 'ES256',
        claimsFile: '/abs/c.json',
        outputDir: '/abs/out',
      });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args.slice(0, 8)).toEqual([
        'sign',
        '--bundle',
        '--signing-key',
        '/abs/k',
        '--signing-alg',
        'ES256',
        '--claims-file',
        '/abs/c.json',
      ]);
      expect(args.slice(-4)).toEqual(['--output-file-path', '/abs/out', '--', '/abs/b']);
    });
  });

  describe('bundleVerify()', () => {
    it('verifies through opa build into a temp output that is removed afterwards', async () => {
      await opa.bundleVerify({ bundle: '/abs/signed', verificationKey: '/abs/pub.pem' });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args[0]).toBe('build');
      expect(args[1]).toBe('--bundle');
      expect(args).not.toContain('eval');
      expect(args[args.indexOf('--verification-key') + 1]).toBe('/abs/pub.pem');
      const out = args[args.indexOf('-o') + 1]!;
      expect(out.startsWith(tmpdir())).toBe(true);
      expect(out.endsWith('verified.tar.gz')).toBe(true);
      expect(existsSync(dirname(out))).toBe(false);
      expect(args.slice(-2)).toEqual(['--', '/abs/signed']);
    });

    it('forwards the working directory and --v0-compatible', async () => {
      await opa.bundleVerify({
        bundle: 'signed',
        verificationKey: '/abs/k',
        cwd: tmpdir(),
        v0Compatible: true,
      });
      const call = mockRun.mock.calls[0]![1];
      expect(call.cwd).toBe(tmpdir());
      expect(call.args).toContain('--v0-compatible');
      expect(call.args.slice(-2)).toEqual(['--', 'signed']);
    });

    it('passes verificationKeyId, signingAlg and scope', async () => {
      await opa.bundleVerify({
        bundle: '/abs/s',
        verificationKey: '/abs/k',
        verificationKeyId: 'k1',
        signingAlg: 'HS256',
        scope: 'w',
      });
      const args = mockRun.mock.calls[0]![1].args;
      expect(args[args.indexOf('--verification-key-id') + 1]).toBe('k1');
      expect(args[args.indexOf('--signing-alg') + 1]).toBe('HS256');
      expect(args[args.indexOf('--scope') + 1]).toBe('w');
      expect(args).not.toContain('--v0-compatible');
    });

    it('removes the temp directory when opa fails', async () => {
      mockRun.mockResolvedValueOnce({
        exitCode: 1,
        stdout: 'error: load error',
        stderr: '',
        timedOut: false,
        aborted: false,
        durationMs: 1,
      });
      const result = await opa.bundleVerify({ bundle: '/abs/s', verificationKey: '/abs/k' });
      expect(result.exitCode).toBe(1);
      const out = mockRun.mock.calls[0]![1].args.at(-3)!;
      expect(existsSync(dirname(out))).toBe(false);
    });
  });

  describe('run()', () => {
    it('forwards stdin when provided', async () => {
      await opa.run(['fmt', '/abs/p.rego'], 'package x');
      expect(mockRun).toHaveBeenCalledWith('opa', {
        args: ['fmt', '/abs/p.rego'],
        timeoutMs: 30_000,
        maxOutputBytes: 32 * 1024 * 1024,
        stdin: 'package x',
      });
    });

    it('omits stdin when not provided', async () => {
      await opa.run(['version']);
      expect(mockRun).toHaveBeenCalledWith('opa', {
        args: ['version'],
        timeoutMs: 30_000,
        maxOutputBytes: 32 * 1024 * 1024,
      });
    });

    it('forwards cwd when provided', async () => {
      await opa.run(['sign'], undefined, undefined, [], tmpdir());
      expect(mockRun).toHaveBeenCalledWith(
        'opa',
        expect.objectContaining({ args: ['sign'], cwd: tmpdir() }),
      );
    });

    it('names a missing working directory instead of spawning into it', async () => {
      // spawn would fail with the same ENOENT a missing binary produces, which
      // the tool layer reports as OPA_BINARY_NOT_FOUND.
      const result = await opa.run(['sign'], undefined, undefined, [], '/definitely/not/here');
      expect(mockRun).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/working directory does not exist/);
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
