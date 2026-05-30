import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mock declarations before imports so Vitest can reorder them.
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { readdir, realpath } from 'node:fs/promises';
import { runBinary } from '../../../src/lib/subprocess.js';

import { registerRegoTestMultiroot } from '../../../src/tools/evaluation/test-multiroot.js';
import type { MultiRootTestOutput } from '../../../src/tools/evaluation/test-multiroot.js';

import {
  baseConfig,
  callTool,
  fixturePath,
  fixturesDir,
  makeServer,
  spawnFailure,
  spawnSuccess,
  spawnTimedOut,
  spawnUnreachable,
} from './_helpers.js';

const mockRun = vi.mocked(runBinary);
const mockReaddir = vi.mocked(readdir);
const mockRealpath = vi.mocked(realpath);

// ─── Fixture helpers ─────────────────────────────────────────────────────────

// Paths that exist on disk and pass validatePaths({ mustExist: true }).
const root1 = () => fixturePath('policies', 'valid');
const root2 = () => fixturePath('inputs');
const sharedLib = () => fixturePath('policies');

const testRecordsPass = (pkg = 'data.example') =>
  JSON.stringify([{ package: pkg, name: 'test_allow', duration: 1 }]);

const testRecordsFail = (pkg = 'data.example') =>
  JSON.stringify([{ package: pkg, name: 'test_deny', fail: true, duration: 1 }]);

const coverageJson = (pct = 85) =>
  JSON.stringify({ coverage: pct, covered_lines: 17, not_covered_lines: 3 });

// Minimal Dirent-like object. walk() uses name, isFile(), isDirectory().
const makeDirent = (name: string, type: 'file' | 'dir') =>
  ({
    name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => false,
  }) as unknown as Awaited<ReturnType<typeof readdir>>[number];

// Wire readdir to return different entries per path.
const setupReaddir = (structure: Record<string, ReturnType<typeof makeDirent>[]>) => {
  mockReaddir.mockImplementation((p) => Promise.resolve(structure[p as string] ?? []));
};

beforeEach(() => {
  mockRun.mockReset();
  mockReaddir.mockReset();
  mockRealpath.mockReset();
  // Default: realpath returns the path unchanged (no symlinks).
  mockRealpath.mockImplementation((p) => Promise.resolve(p as string));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Explicit mode ────────────────────────────────────────────────────────────

describe('rego_test_multiroot (explicit mode)', () => {
  it('aggregates pass counts across two passing roots', async () => {
    mockRun
      .mockResolvedValueOnce(spawnSuccess(testRecordsPass('data.a')))
      .mockResolvedValueOnce(spawnSuccess(testRecordsPass('data.b')));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      roots: [{ path: root1() }, { path: root2() }],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.mode).toBe('explicit');
    expect(env.data?.totalPassed).toBe(2);
    expect(env.data?.totalFailed).toBe(0);
    expect(env.data?.totalTests).toBe(2);
    expect(env.data?.rootsRun).toBe(2);
    expect(env.data?.rootsWithErrors).toBe(0);
    expect(env.data?.rootsWithFailures).toBe(0);
    expect(env.data?.roots).toHaveLength(2);
    expect(env.data?.roots[0]!.path).toBe(root1());
    expect(env.data?.roots[1]!.path).toBe(root2());
  });

  it('counts rootsWithFailures when one root has failing tests', async () => {
    mockRun
      .mockResolvedValueOnce(spawnSuccess(testRecordsPass()))
      .mockResolvedValueOnce(spawnSuccess(testRecordsFail(), ''));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      roots: [{ path: root1() }, { path: root2() }],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.totalPassed).toBe(1);
    expect(env.data?.totalFailed).toBe(1);
    expect(env.data?.rootsWithFailures).toBe(1);
    expect(env.data?.rootsWithErrors).toBe(0);
    // Failing root still has its test records.
    expect(env.data?.roots[1]!.failed).toBe(1);
    expect(env.data?.roots[1]!.error).toBeUndefined();
  });

  it('records per-root EVAL_ERROR and continues running remaining roots', async () => {
    // Root 1: compilation error (package conflict on stderr, empty stdout, exit 1).
    mockRun
      .mockResolvedValueOnce(spawnFailure(1, '1 error occurred: package conflict', ''))
      .mockResolvedValueOnce(spawnSuccess(testRecordsPass()));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      roots: [{ path: root1() }, { path: root2() }],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.rootsWithErrors).toBe(1);
    expect(env.data?.rootsWithFailures).toBe(0);
    // Errored root contributes 0 to totals.
    expect(env.data?.totalPassed).toBe(1);
    expect(env.data?.roots[0]!.error?.code).toBe('EVAL_ERROR');
    expect(env.data?.roots[0]!.error?.message).toContain('package conflict');
    // Second root ran and succeeded.
    expect(env.data?.roots[1]!.passed).toBe(1);
    expect(env.data?.roots[1]!.error).toBeUndefined();
  });

  it('aborts all roots and returns OPA_BINARY_NOT_FOUND when binary is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool(server, 'rego_test_multiroot', {
      roots: [{ path: root1() }, { path: root2() }],
    });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
    // Should abort on first root -- second root never ran.
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('aborts all roots and returns TIMEOUT on subprocess timeout', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool(server, 'rego_test_multiroot', {
      roots: [{ path: root1() }, { path: root2() }],
    });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('TIMEOUT');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('appends include paths after the root path in opa test argv', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(testRecordsPass()));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      roots: [{ path: root1(), include: [sharedLib()] }],
    });

    const args = mockRun.mock.calls[0]![1].args;
    expect(args.indexOf('test')).toBeGreaterThanOrEqual(0);
    expect(args).toContain(root1());
    expect(args).toContain(sharedLib());
    // root path must appear before include path.
    expect(args.indexOf(root1())).toBeLessThan(args.indexOf(sharedLib()));
    // include paths propagate to the result.
    expect(env.data?.roots[0]!.include).toContain(sharedLib());
  });

  it('preserves optional root name in output', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(testRecordsPass()));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      roots: [{ path: root1(), name: 'auth-service' }],
    });

    expect(env.data?.roots[0]!.name).toBe('auth-service');
  });

  it('handles coverage mode -- computes per-root coveragePct and overallCoveragePct', async () => {
    mockRun
      .mockResolvedValueOnce(spawnSuccess(coverageJson(80)))
      .mockResolvedValueOnce(spawnSuccess(coverageJson(90)));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      roots: [{ path: root1() }, { path: root2() }],
      coverage: true,
    });

    expect(env.ok).toBe(true);
    expect(env.data?.roots[0]!.coveragePct).toBe(80);
    expect(env.data?.roots[1]!.coveragePct).toBe(90);
    // Mean of 80 and 90 = 85.
    expect(env.data?.overallCoveragePct).toBe(85);
    // Coverage mode -- opa args contain --coverage.
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--coverage');
  });

  it('records thresholdMet: false on a root that misses the threshold', async () => {
    const thresholdMsg = 'Code coverage threshold not met: got 70.00 instead of 80.00';
    mockRun
      .mockResolvedValueOnce(spawnFailure(2, thresholdMsg, ''))
      .mockResolvedValueOnce(spawnSuccess(coverageJson(90)));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      roots: [{ path: root1() }, { path: root2() }],
      threshold: 80,
    });

    expect(env.ok).toBe(true);
    expect(env.data?.roots[0]!.error?.code).toBe('COVERAGE_BELOW_THRESHOLD');
    expect(env.data?.roots[0]!.thresholdMet).toBe(false);
    expect(env.data?.roots[0]!.coveragePct).toBe(70);
    expect(env.data?.roots[1]!.thresholdMet).toBe(true);
    expect(env.data?.roots[1]!.coveragePct).toBe(90);
    // overallCoveragePct only from roots that have coverage data.
    expect(env.data?.overallCoveragePct).toBeCloseTo(80, 1);
  });

  it('emits a warning and partial results when a subprocess returns aborted', async () => {
    // root1 succeeds; root2's subprocess was killed (signal fired during run).
    mockRun.mockResolvedValueOnce(spawnSuccess(testRecordsPass())).mockResolvedValueOnce({
      exitCode: 137,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
      durationMs: 10,
    });

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      roots: [{ path: root1() }, { path: root2() }],
    });

    expect(env.ok).toBe(true);
    // Only root1 completed before the abort.
    expect(env.data?.rootsRun).toBe(1);
    expect(env.warnings?.some((w) => /cancelled/i.test(w))).toBe(true);
  });

  it('returns PATH_NOT_ALLOWED when a root path is outside allowed roots', async () => {
    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool(server, 'rego_test_multiroot', {
      roots: [{ path: '/outside/not-allowed' }],
    });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('returns INVALID_INPUT when neither roots nor scanDir is provided', async () => {
    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool(server, 'rego_test_multiroot', {});

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT when both roots and scanDir are provided', async () => {
    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool(server, 'rego_test_multiroot', {
      roots: [{ path: root1() }],
      scanDir: fixturesDir,
    });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
  });
});

// ─── Scan mode ────────────────────────────────────────────────────────────────

describe('rego_test_multiroot (scan mode)', () => {
  it('discovers two leaf roots and runs opa test once per root', async () => {
    const subA = join(fixturesDir, 'subA');
    const subB = join(fixturesDir, 'subB');

    setupReaddir({
      [fixturesDir]: [makeDirent('subA', 'dir'), makeDirent('subB', 'dir')],
      [subA]: [makeDirent('auth_test.rego', 'file')],
      [subB]: [makeDirent('billing_test.rego', 'file')],
    });

    mockRun
      .mockResolvedValueOnce(spawnSuccess(testRecordsPass('data.auth')))
      .mockResolvedValueOnce(spawnSuccess(testRecordsPass('data.billing')));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      scanDir: fixturesDir,
    });

    expect(env.ok).toBe(true);
    expect(env.data?.mode).toBe('scan');
    expect(env.data?.rootsRun).toBe(2);
    expect(env.data?.totalPassed).toBe(2);
    expect(mockRun).toHaveBeenCalledTimes(2);

    const firstCallPaths = mockRun.mock.calls[0]![1].args;
    const secondCallPaths = mockRun.mock.calls[1]![1].args;
    expect(firstCallPaths).toContain(subA);
    expect(secondCallPaths).toContain(subB);
  });

  it('excludes sharedPaths from discovery and adds them to every root invocation', async () => {
    const subA = join(fixturesDir, 'subA');
    const shared = join(fixturesDir, 'shared');

    setupReaddir({
      [fixturesDir]: [makeDirent('subA', 'dir'), makeDirent('shared', 'dir')],
      [subA]: [makeDirent('auth_test.rego', 'file')],
      // shared dir is excluded from discovery -- readdir should never be called for it.
      [shared]: [makeDirent('lib.rego', 'file')],
    });

    // Override shared path to a real fixture path that passes validation.
    const realShared = fixturePath('policies');

    mockRun.mockResolvedValueOnce(spawnSuccess(testRecordsPass()));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      scanDir: fixturesDir,
      sharedPaths: [realShared],
    });

    expect(env.ok).toBe(true);
    // Only subA is a discovered root (realShared is excluded from discovery).
    expect(env.data?.rootsRun).toBe(1);
    // realShared is included in the opa test invocation for subA.
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain(subA);
    expect(args).toContain(realShared);
  });

  it('skips directories that resolve outside scanDir via symlink', async () => {
    const escapedDir = join(fixturesDir, 'escaped');
    const validRoot = join(fixturesDir, 'valid_root');

    setupReaddir({
      [fixturesDir]: [makeDirent('escaped', 'dir'), makeDirent('valid_root', 'dir')],
      [validRoot]: [makeDirent('policy_test.rego', 'file')],
      // `escaped` will be skipped by the symlink check before readdir is called.
    });

    mockRealpath.mockImplementation((p) => {
      if (p === escapedDir) return Promise.resolve('/completely/outside');
      return Promise.resolve(p as string);
    });

    mockRun.mockResolvedValueOnce(spawnSuccess(testRecordsPass()));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      scanDir: fixturesDir,
    });

    expect(env.ok).toBe(true);
    // Only valid_root was discovered; escaped was skipped.
    expect(env.data?.rootsRun).toBe(1);
    expect(env.data?.roots[0]!.path).toBe(validRoot);
  });

  it('returns INVALID_INPUT when scan finds more roots than maxRoots', async () => {
    const subA = join(fixturesDir, 'subA');
    const subB = join(fixturesDir, 'subB');
    const subC = join(fixturesDir, 'subC');

    setupReaddir({
      [fixturesDir]: [
        makeDirent('subA', 'dir'),
        makeDirent('subB', 'dir'),
        makeDirent('subC', 'dir'),
      ],
      [subA]: [makeDirent('a_test.rego', 'file')],
      [subB]: [makeDirent('b_test.rego', 'file')],
      [subC]: [makeDirent('c_test.rego', 'file')],
    });

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool(server, 'rego_test_multiroot', {
      scanDir: fixturesDir,
      maxRoots: 2,
    });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.message).toContain('more than 2');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('returns NO_TESTS_FOUND when scan finds no *_test.rego files', async () => {
    setupReaddir({
      [fixturesDir]: [makeDirent('lib', 'dir')],
      [join(fixturesDir, 'lib')]: [makeDirent('lib.rego', 'file')],
    });

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool(server, 'rego_test_multiroot', {
      scanDir: fixturesDir,
    });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('NO_TESTS_FOUND');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('records ancestorSkipped and emits a warning when a dir has tests alongside descendant test dirs', async () => {
    // ancestor/ has a direct test file AND subchild/ also has test files.
    // ancestor/ should be skipped; subchild/ is the leaf root.
    const ancestor = join(fixturesDir, 'ancestor');
    const subchild = join(ancestor, 'subchild');

    setupReaddir({
      [fixturesDir]: [makeDirent('ancestor', 'dir')],
      [ancestor]: [
        makeDirent('ancestor_test.rego', 'file'), // direct test file
        makeDirent('subchild', 'dir'),
      ],
      [subchild]: [makeDirent('child_test.rego', 'file')],
    });

    mockRun.mockResolvedValueOnce(spawnSuccess(testRecordsPass()));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      scanDir: fixturesDir,
    });

    expect(env.ok).toBe(true);
    // Only subchild is a root; ancestor is skipped.
    expect(env.data?.rootsRun).toBe(1);
    expect(env.data?.roots[0]!.path).toBe(subchild);
    expect(env.data?.ancestorSkipped).toContain(ancestor);
    // Warning message should mention the skipped ancestor.
    expect(env.warnings?.some((w) => w.includes(ancestor))).toBe(true);
  });

  it('applies ignorePatterns to skip matching directory names during scan', async () => {
    const generated = join(fixturesDir, 'api.generated');
    const normalRoot = join(fixturesDir, 'auth');

    setupReaddir({
      [fixturesDir]: [makeDirent('api.generated', 'dir'), makeDirent('auth', 'dir')],
      [generated]: [makeDirent('gen_test.rego', 'file')],
      [normalRoot]: [makeDirent('auth_test.rego', 'file')],
    });

    mockRun.mockResolvedValueOnce(spawnSuccess(testRecordsPass()));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      scanDir: fixturesDir,
      ignorePatterns: ['*.generated'],
    });

    expect(env.ok).toBe(true);
    // Only auth was discovered; api.generated was ignored.
    expect(env.data?.rootsRun).toBe(1);
    expect(env.data?.roots[0]!.path).toBe(normalRoot);
  });

  it('never descends into ALWAYS_IGNORE directories', async () => {
    const nodeModules = join(fixturesDir, 'node_modules');
    const realRoot = join(fixturesDir, 'src');

    setupReaddir({
      [fixturesDir]: [makeDirent('node_modules', 'dir'), makeDirent('src', 'dir')],
      [nodeModules]: [makeDirent('pkg_test.rego', 'file')],
      [realRoot]: [makeDirent('src_test.rego', 'file')],
    });

    mockRun.mockResolvedValueOnce(spawnSuccess(testRecordsPass()));

    const server = makeServer();
    registerRegoTestMultiroot(server, baseConfig);

    const env = await callTool<MultiRootTestOutput>(server, 'rego_test_multiroot', {
      scanDir: fixturesDir,
    });

    expect(env.ok).toBe(true);
    expect(env.data?.rootsRun).toBe(1);
    expect(env.data?.roots[0]!.path).toBe(realRoot);
    // node_modules should never have been read.
    const readdirPaths = mockReaddir.mock.calls.map((c) => c[0] as string);
    expect(readdirPaths).not.toContain(nodeModules);
  });
});
