/**
 * Unit tests for the four conftest_* tool handlers.
 *
 * runBinary is mocked so no real conftest binary is required. Tests verify:
 *   - happy-path argv construction and output parsing
 *   - exit-code mapping (0 = pass, 1 = fail, 2+ = command error)
 *   - summary field arithmetic across multi-file results
 *   - all INVALID_INPUT mutual-exclusion guards
 *   - path validation (PATH_NOT_ALLOWED, PATH_NOT_FOUND)
 *   - subprocess failure mapping (CONFTEST_NOT_FOUND, TIMEOUT, CANCELLED)
 *   - inline config and inline policy flows
 *   - conftest_pull does NOT require policy dir to exist
 *   - conftest_push DOES require policy dir to exist
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  baseConfig,
  callTool,
  fixturePath,
  makeServer,
  spawnFailure,
  spawnSuccess,
  spawnTimedOut,
  spawnUnreachable,
  okSpawn,
} from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

import { registerConftestTools } from '../../../src/tools/conftest/index.js';
import type { ConftestTestOutput } from '../../../src/tools/conftest/test.js';
import type { ConftestVerifyOutput } from '../../../src/tools/conftest/verify.js';
import type { ConftestPullOutput } from '../../../src/tools/conftest/pull.js';
import type { ConftestPushOutput } from '../../../src/tools/conftest/push.js';
import type { ConftestFileResult } from '../../../src/lib/conftest-cli.js';

const mockRun = vi.mocked(runBinary);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const policyDir = fixturePath('conftest', 'policy');
const passingConfig = fixturePath('conftest', 'configs', 'passing.yaml');
const failingConfig = fixturePath('conftest', 'configs', 'failing.yaml');

function makeFileResult(overrides: Partial<ConftestFileResult> = {}): ConftestFileResult {
  return {
    filename: '/config.yaml',
    namespace: 'main',
    successes: 1,
    failures: [],
    warnings: [],
    skipped: [],
    exceptions: [],
    ...overrides,
  };
}

const spawnAborted = () => ({
  ...okSpawn,
  exitCode: null,
  aborted: true,
  stderr: '',
});

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── conftest_test ────────────────────────────────────────────────────────────

describe('conftest_test', () => {
  // ── Happy paths ─────────────────────────────────────────────────────────────

  it('returns ok=true, passed=true on exit 0 with all-pass results', async () => {
    const results: ConftestFileResult[] = [
      makeFileResult({ filename: passingConfig, successes: 3 }),
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(results)));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestTestOutput>(server, 'conftest_test', {
      files: [passingConfig],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.passed).toBe(true);
    expect(env.data?.results).toHaveLength(1);
    expect(env.data?.summary.passed).toBe(1);
    expect(env.data?.summary.failed).toBe(0);
  });

  it('forwards parser to conftest as --parser', async () => {
    const results: ConftestFileResult[] = [makeFileResult({ filename: passingConfig })];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(results)));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestTestOutput>(server, 'conftest_test', {
      files: [passingConfig],
      parser: 'json',
    });

    expect(env.ok).toBe(true);
    const { args } = mockRun.mock.calls[0]![1];
    expect(args).toContain('--parser');
    expect(args[args.indexOf('--parser') + 1]).toBe('json');
  });

  it('returns ok=true, passed=false on exit 1 (policy failures)', async () => {
    const results: ConftestFileResult[] = [
      makeFileResult({
        filename: failingConfig,
        failures: [{ msg: 'Container must not run as root' }],
      }),
    ];
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      exitCode: 1,
      stdout: JSON.stringify(results),
    });

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestTestOutput>(server, 'conftest_test', {
      files: [failingConfig],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.passed).toBe(false);
    expect(env.data?.results[0]?.failures).toHaveLength(1);
    expect(env.data?.summary.failed).toBe(1);
    expect(env.data?.summary.passed).toBe(0);
  });

  it('counts warnings correctly in summary', async () => {
    const results: ConftestFileResult[] = [
      makeFileResult({
        warnings: [{ msg: 'No resource limits set' }, { msg: 'Image tag is latest' }],
      }),
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(results)));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestTestOutput>(server, 'conftest_test', {
      files: [passingConfig],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.summary.warnings).toBe(2);
  });

  it('computes correct summary for mixed multi-file results', async () => {
    // File 1: 2 failures, 1 warning, 1 skipped
    // File 2: 0 failures, 0 warnings
    // File 3: 1 failure
    // Expected: passed=1, failed=2, warnings=1, skipped=1
    const results: ConftestFileResult[] = [
      makeFileResult({
        filename: failingConfig,
        failures: [{ msg: 'fail1' }, { msg: 'fail2' }],
        warnings: [{ msg: 'warn1' }],
        skipped: [{ msg: 'skip1' }],
      }),
      makeFileResult({ filename: passingConfig, successes: 5 }),
      makeFileResult({
        filename: fixturePath('conftest', 'configs', 'other.yaml'),
        failures: [{ msg: 'fail3' }],
      }),
    ];
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      exitCode: 1,
      stdout: JSON.stringify(results),
    });

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestTestOutput>(server, 'conftest_test', {
      files: [passingConfig],
    });

    expect(env.data?.summary.passed).toBe(1);
    expect(env.data?.summary.failed).toBe(2);
    expect(env.data?.summary.warnings).toBe(1);
    expect(env.data?.summary.skipped).toBe(1);
  });

  it('accepts inlineConfig and returns ok=true', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([makeFileResult()])));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestTestOutput>(server, 'conftest_test', {
      inlineConfig: 'apiVersion: v1\nkind: Pod',
    });

    expect(env.ok).toBe(true);
    expect(env.data?.passed).toBe(true);
  });

  it('accepts inlineConfig with inlinePolicy and returns ok=true', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([makeFileResult()])));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestTestOutput>(server, 'conftest_test', {
      inlineConfig: 'foo: bar',
      inlinePolicy: 'package main\ndeny[msg] { false; msg := "no" }',
    });

    expect(env.ok).toBe(true);
  });

  it('passes --policy and files correctly for disk-based inputs', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([])));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    await callTool(server, 'conftest_test', {
      files: [passingConfig],
      policy: policyDir,
    });

    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('test');
    expect(args).toContain('--output=json');
    expect(args).toContain('--no-color');
    expect(args).toContain('--policy');
    expect(args).toContain(policyDir);
    expect(args).toContain(passingConfig);
  });

  it('uses config.conftestBinary as the binary name', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([])));

    const cfg = { ...baseConfig, conftestBinary: '/usr/local/bin/conftest' };
    const server = makeServer();
    registerConftestTools(server, cfg);
    await callTool(server, 'conftest_test', { files: [passingConfig] });

    expect(mockRun).toHaveBeenCalledWith('/usr/local/bin/conftest', expect.any(Object));
  });

  it('returns empty summary when results array is empty', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([])));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestTestOutput>(server, 'conftest_test', {
      files: [passingConfig],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.summary).toEqual({ passed: 0, failed: 0, warnings: 0, skipped: 0 });
  });

  // ── Mutual exclusion guards ─────────────────────────────────────────────────

  it('rejects calls with neither files nor inlineConfig', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', {});
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.message).toMatch(/inlineConfig/);
  });

  it('rejects calls with both files and inlineConfig', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', {
      files: [passingConfig],
      inlineConfig: 'foo: bar',
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.message).toMatch(/mutually exclusive/);
  });

  it('rejects calls with both policy and inlinePolicy', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', {
      files: [passingConfig],
      policy: policyDir,
      inlinePolicy: 'package main',
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.message).toMatch(/mutually exclusive/);
  });

  // ── Path validation ─────────────────────────────────────────────────────────

  it('rejects files outside allowed roots', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', { files: ['/etc/config.yaml'] });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects files that do not exist inside allowed root', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', {
      files: [fixturePath('conftest', 'configs', 'does-not-exist.yaml')],
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
  });

  it('rejects policy path outside allowed roots', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', {
      files: [passingConfig],
      policy: '/etc/opa/policy',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects policy path that does not exist inside allowed root', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', {
      files: [passingConfig],
      policy: fixturePath('conftest', 'nonexistent-policy'),
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
  });

  it('rejects data paths outside allowed roots', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', {
      files: [passingConfig],
      data: ['/etc/data'],
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('accepts fixture files inside allowed root', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([makeFileResult()])));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestTestOutput>(server, 'conftest_test', {
      files: [passingConfig],
      policy: policyDir,
    });

    expect(env.ok).toBe(true);
  });

  // ── Subprocess failure mapping ──────────────────────────────────────────────

  it('maps missing conftest binary to CONFTEST_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', { files: [passingConfig] });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('CONFTEST_NOT_FOUND');
    expect(env.error?.hint).toMatch(/CONFTEST_BINARY/i);
  });

  it('maps timeout to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', { files: [passingConfig] });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('TIMEOUT');
  });

  it('maps aborted signal to CANCELLED', async () => {
    mockRun.mockResolvedValueOnce(spawnAborted());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', { files: [passingConfig] });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('CANCELLED');
  });

  it('maps exit code 2 to UNKNOWN_ERROR', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(2, 'policy directory not found'));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', { files: [passingConfig] });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toMatch(/exit code 2/);
  });

  it('maps unparseable JSON stdout to UNKNOWN_ERROR', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('not json at all'));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', { files: [passingConfig] });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('maps stdout that is valid JSON but not an array to UNKNOWN_ERROR', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('{"unexpectedObject": true}'));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_test', { files: [passingConfig] });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });
});

// ─── conftest_verify ──────────────────────────────────────────────────────────

describe('conftest_verify', () => {
  // ── Happy paths ─────────────────────────────────────────────────────────────

  it('returns ok=true, passed=true on exit 0 with all-passing tests', async () => {
    const results: ConftestFileResult[] = [
      makeFileResult({ filename: 'main_test.rego', successes: 5 }),
    ];
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(results)));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestVerifyOutput>(server, 'conftest_verify', {
      policy: policyDir,
    });

    expect(env.ok).toBe(true);
    expect(env.data?.passed).toBe(true);
    expect(env.data?.summary.passed).toBe(1);
    expect(env.data?.summary.failed).toBe(0);
    expect(env.data?.summary.totalPassed).toBe(5);
    expect(env.data?.summary.totalFailed).toBe(0);
  });

  it('returns ok=true, passed=false on exit 1 (test failures)', async () => {
    const results: ConftestFileResult[] = [
      makeFileResult({
        filename: 'main_test.rego',
        successes: 3,
        failures: [{ msg: 'test_deny_root_user failed' }, { msg: 'test_deny_latest_tag failed' }],
      }),
    ];
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      exitCode: 1,
      stdout: JSON.stringify(results),
    });

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestVerifyOutput>(server, 'conftest_verify', {
      policy: policyDir,
    });

    expect(env.ok).toBe(true);
    expect(env.data?.passed).toBe(false);
    expect(env.data?.summary.totalPassed).toBe(3);
    expect(env.data?.summary.totalFailed).toBe(2);
  });

  it('sums totalPassed/totalFailed correctly across multiple test files', async () => {
    // Two test files: first passes 4, second passes 2 with 1 failure
    const results: ConftestFileResult[] = [
      makeFileResult({ filename: 'a_test.rego', successes: 4, failures: [] }),
      makeFileResult({
        filename: 'b_test.rego',
        successes: 2,
        failures: [{ msg: 'test_something failed' }],
      }),
    ];
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      exitCode: 1,
      stdout: JSON.stringify(results),
    });

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestVerifyOutput>(server, 'conftest_verify', {
      policy: policyDir,
    });

    expect(env.data?.summary.passed).toBe(1);
    expect(env.data?.summary.failed).toBe(1);
    expect(env.data?.summary.totalPassed).toBe(6);
    expect(env.data?.summary.totalFailed).toBe(1);
  });

  it('builds correct argv with policy, namespace, and data', async () => {
    const dataDir = fixturePath('conftest', 'policy');
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([])));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    await callTool(server, 'conftest_verify', {
      policy: policyDir,
      namespace: 'kubernetes',
      data: [dataDir],
    });

    const args = mockRun.mock.calls[0]![1].args;
    expect(args[0]).toBe('verify');
    expect(args).toContain('--output=json');
    expect(args).toContain('--no-color');
    expect(args).toContain('--policy');
    expect(args).toContain(policyDir);
    expect(args).toContain('--namespace');
    expect(args).toContain('kubernetes');
    expect(args).toContain('--data');
    expect(args).toContain(dataDir);
  });

  // ── Path validation ─────────────────────────────────────────────────────────

  it('rejects policy path outside allowed roots', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_verify', { policy: '/etc/policies' });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects policy path that does not exist inside allowed root', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_verify', {
      policy: fixturePath('conftest', 'nonexistent'),
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
  });

  it('rejects data paths outside allowed roots', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_verify', {
      policy: policyDir,
      data: ['/outside/data'],
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  // ── Subprocess failure mapping ──────────────────────────────────────────────

  it('maps missing binary to CONFTEST_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_verify', { policy: policyDir });

    expect(env.error?.code).toBe('CONFTEST_NOT_FOUND');
    expect(env.error?.hint).toMatch(/conftest/i);
  });

  it('maps timeout to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_verify', { policy: policyDir });

    expect(env.error?.code).toBe('TIMEOUT');
  });

  it('maps aborted signal to CANCELLED', async () => {
    mockRun.mockResolvedValueOnce(spawnAborted());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_verify', { policy: policyDir });

    expect(env.error?.code).toBe('CANCELLED');
  });

  it('maps exit code 2 to UNKNOWN_ERROR', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(2, 'no test files found'));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_verify', { policy: policyDir });

    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toMatch(/exit code 2/);
  });

  it('maps unparseable stdout to UNKNOWN_ERROR', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('not json'));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_verify', { policy: policyDir });

    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('succeeds without any arguments (uses conftest default policy dir)', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([])));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestVerifyOutput>(server, 'conftest_verify', {});

    expect(env.ok).toBe(true);
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).not.toContain('--policy');
  });
});

// ─── conftest_pull ────────────────────────────────────────────────────────────

describe('conftest_pull', () => {
  const testUrl = 'oci://ghcr.io/org/policies:latest';

  // ── Happy paths ─────────────────────────────────────────────────────────────

  it('returns ok=true with url and default policyDir on success', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestPullOutput>(server, 'conftest_pull', { url: testUrl });

    expect(env.ok).toBe(true);
    expect(env.data?.url).toBe(testUrl);
    expect(env.data?.policyDir).toBe('policy');
  });

  it('returns the provided policy directory in output', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestPullOutput>(server, 'conftest_pull', {
      url: testUrl,
      policy: policyDir,
    });

    expect(env.ok).toBe(true);
    expect(env.data?.policyDir).toBe(policyDir);
  });

  it('builds correct argv with url and optional policy dir', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    await callTool(server, 'conftest_pull', {
      url: testUrl,
      policy: policyDir,
    });

    const args = mockRun.mock.calls[0]![1].args;
    expect(args[0]).toBe('pull');
    expect(args).toContain(testUrl);
    expect(args).toContain('--policy');
    expect(args).toContain(policyDir);
  });

  it('omits --policy arg when policy is not provided', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    await callTool(server, 'conftest_pull', { url: testUrl });

    const args = mockRun.mock.calls[0]![1].args;
    expect(args).not.toContain('--policy');
  });

  it('allows policy dir that does not yet exist (conftest creates it)', async () => {
    // pull intentionally does NOT require mustExist -- conftest creates the dir.
    mockRun.mockResolvedValueOnce(spawnSuccess(''));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestPullOutput>(server, 'conftest_pull', {
      url: testUrl,
      policy: fixturePath('conftest', 'new-policy-dir-does-not-exist'),
    });

    // Path is inside allowed root so it passes validation even without existing.
    expect(env.ok).toBe(true);
  });

  // ── Path validation ─────────────────────────────────────────────────────────

  it('rejects policy path outside allowed roots', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_pull', {
      url: testUrl,
      policy: '/etc/policies',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  // ── Subprocess failure mapping ──────────────────────────────────────────────

  it('maps missing binary to CONFTEST_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_pull', { url: testUrl });

    expect(env.error?.code).toBe('CONFTEST_NOT_FOUND');
  });

  it('maps non-zero exit to UNKNOWN_ERROR (network or auth error)', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'unauthorized: authentication required'));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_pull', { url: testUrl });

    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toMatch(/exit code 1/);
  });

  it('maps timeout to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_pull', { url: testUrl });

    expect(env.error?.code).toBe('TIMEOUT');
  });

  it('maps aborted signal to CANCELLED', async () => {
    mockRun.mockResolvedValueOnce(spawnAborted());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_pull', { url: testUrl });

    expect(env.error?.code).toBe('CANCELLED');
  });
});

// ─── conftest_push ────────────────────────────────────────────────────────────

describe('conftest_push', () => {
  const repository = 'ghcr.io/my-org/policies:latest';

  // ── Happy paths ─────────────────────────────────────────────────────────────

  it('returns ok=true with repository and default policyDir on success', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestPushOutput>(server, 'conftest_push', { repository });

    expect(env.ok).toBe(true);
    expect(env.data?.repository).toBe(repository);
    expect(env.data?.policyDir).toBe('policy');
  });

  it('returns the provided policyDir in output', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool<ConftestPushOutput>(server, 'conftest_push', {
      repository,
      policy: policyDir,
    });

    expect(env.ok).toBe(true);
    expect(env.data?.policyDir).toBe(policyDir);
  });

  it('builds correct argv with repository and policy dir', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    await callTool(server, 'conftest_push', {
      repository,
      policy: policyDir,
    });

    const args = mockRun.mock.calls[0]![1].args;
    expect(args[0]).toBe('push');
    expect(args).toContain(repository);
    expect(args).toContain('--policy');
    expect(args).toContain(policyDir);
  });

  it('omits --policy arg when policy is not provided', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    await callTool(server, 'conftest_push', { repository });

    const args = mockRun.mock.calls[0]![1].args;
    expect(args).not.toContain('--policy');
  });

  // ── Path validation ─────────────────────────────────────────────────────────

  it('rejects policy path outside allowed roots', async () => {
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_push', {
      repository,
      policy: '/etc/policies',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects policy path that does not exist inside allowed root', async () => {
    // push requires mustExist (unlike pull)
    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_push', {
      repository,
      policy: fixturePath('conftest', 'nonexistent-policy-for-push'),
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
  });

  // ── Subprocess failure mapping ──────────────────────────────────────────────

  it('maps missing binary to CONFTEST_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_push', { repository });

    expect(env.error?.code).toBe('CONFTEST_NOT_FOUND');
  });

  it('maps non-zero exit to UNKNOWN_ERROR', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'denied: push access denied'));

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_push', { repository });

    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toMatch(/exit code 1/);
  });

  it('maps timeout to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_push', { repository });

    expect(env.error?.code).toBe('TIMEOUT');
  });

  it('maps aborted signal to CANCELLED', async () => {
    mockRun.mockResolvedValueOnce(spawnAborted());

    const server = makeServer();
    registerConftestTools(server, baseConfig);
    const env = await callTool(server, 'conftest_push', { repository });

    expect(env.error?.code).toBe('CANCELLED');
  });
});
