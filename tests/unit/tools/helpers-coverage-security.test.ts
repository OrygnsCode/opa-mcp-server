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
} from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

import { registerRegoCoverageGaps } from '../../../src/tools/helpers/coverage-gaps.js';
import { registerRegoSecurityAudit } from '../../../src/tools/helpers/security-audit.js';
import type {
  FileCoverageGap,
  RegoCoverageGapsOutput,
} from '../../../src/tools/helpers/coverage-gaps.js';
import type { RegoSecurityAuditOutput } from '../../../src/tools/helpers/security-audit.js';

const mockRun = vi.mocked(runBinary);

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build the two-document stdout that opa test --coverage emits. */
function coverageStdout(
  testRecords: unknown[],
  coverage: {
    files: Record<
      string,
      {
        covered?: Array<{ start: { row: number }; end: { row: number } }>;
        not_covered?: Array<{ start: { row: number }; end: { row: number } }>;
        coverage: number;
      }
    >;
    coverage: number;
  },
): string {
  return JSON.stringify(testRecords) + '\n' + JSON.stringify(coverage);
}

const passingTestRecord = { pass: true, package: 'data.rbac_test', name: 'test_allow' };
const failingTestRecord = { fail: true, package: 'data.rbac_test', name: 'test_deny' };

const singleFileCoverage = (coveragePercent: number, hasGap = true) => ({
  files: {
    'policy.rego': {
      covered: [{ start: { row: 1 }, end: { row: 5 } }],
      not_covered: hasGap ? [{ start: { row: 10 }, end: { row: 12 } }] : [],
      coverage: coveragePercent,
    },
  },
  coverage: coveragePercent,
});

// ─── rego_coverage_gaps ────────────────────────────────────────────────────

describe('rego_coverage_gaps', () => {
  it('returns coverage gaps for files with uncovered ranges', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(coverageStdout([passingTestRecord], singleFileCoverage(62.5))),
    );
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool<RegoCoverageGapsOutput>(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.overallCoverage).toBe(62.5);
    expect(env.data?.totalFiles).toBe(1);
    expect(env.data?.filesWithGaps).toHaveLength(1);
    expect(env.data?.filesWithGaps[0]?.file).toBe('policy.rego');
    expect(env.data?.filesWithGaps[0]?.coveragePercent).toBe(62.5);
    expect(env.data?.filesWithGaps[0]?.uncoveredRanges).toHaveLength(1);
    expect(env.data?.filesWithGaps[0]?.uncoveredLineCount).toBe(3); // rows 10-12 inclusive
    expect(env.data?.testsPassed).toBe(1);
    expect(env.data?.testsFailed).toBe(0);
    expect(env.data?.testsSkipped).toBe(0);
  });

  it('returns empty filesWithGaps when all files are fully covered', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(coverageStdout([passingTestRecord], singleFileCoverage(100, false))),
    );
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool<RegoCoverageGapsOutput>(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.filesWithGaps).toHaveLength(0);
    expect(env.data?.totalFiles).toBe(1);
  });

  it('filters out files at or above the threshold', async () => {
    const coverage = {
      files: {
        'low.rego': {
          covered: [],
          not_covered: [{ start: { row: 1 }, end: { row: 10 } }],
          coverage: 40,
        },
        'high.rego': {
          covered: [{ start: { row: 1 }, end: { row: 10 } }],
          not_covered: [{ start: { row: 11 }, end: { row: 12 } }],
          coverage: 85,
        },
      },
      coverage: 62.5,
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(coverageStdout([passingTestRecord], coverage)));
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool<RegoCoverageGapsOutput>(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
      threshold: 80,
    });

    expect(env.ok).toBe(true);
    // high.rego (85%) is at or above threshold 80 -- filtered out.
    // low.rego (40%) is below threshold -- included.
    expect(env.data?.filesWithGaps).toHaveLength(1);
    expect(env.data?.filesWithGaps[0]?.file).toBe('low.rego');
  });

  it('sorts filesWithGaps by coverage ascending (worst first)', async () => {
    const coverage = {
      files: {
        'medium.rego': {
          covered: [],
          not_covered: [{ start: { row: 1 }, end: { row: 5 } }],
          coverage: 60,
        },
        'worst.rego': {
          covered: [],
          not_covered: [{ start: { row: 1 }, end: { row: 10 } }],
          coverage: 10,
        },
        'better.rego': {
          covered: [],
          not_covered: [{ start: { row: 1 }, end: { row: 2 } }],
          coverage: 80,
        },
      },
      coverage: 50,
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(coverageStdout([passingTestRecord], coverage)));
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool<RegoCoverageGapsOutput>(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.ok).toBe(true);
    const files = env.data?.filesWithGaps.map((f: FileCoverageGap) => f.file);
    expect(files).toEqual(['worst.rego', 'medium.rego', 'better.rego']);
  });

  it('counts failed and skipped tests correctly', async () => {
    const skippedRecord = { skip: true, package: 'data.x_test', name: 'test_skipped' };
    mockRun.mockResolvedValueOnce(
      spawnSuccess(
        coverageStdout(
          [passingTestRecord, failingTestRecord, skippedRecord],
          singleFileCoverage(50),
        ),
      ),
    );
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool<RegoCoverageGapsOutput>(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.testsPassed).toBe(1);
    expect(env.data?.testsFailed).toBe(1);
    expect(env.data?.testsSkipped).toBe(1);
  });

  it('returns NO_TESTS_FOUND when stdout has no coverage report and exit is 0', async () => {
    // Simulate opa test returning test records but no coverage object
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify([passingTestRecord])));
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.error?.code).toBe('NO_TESTS_FOUND');
  });

  it('returns EVAL_ERROR when opa exits non-zero and no coverage report', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'compile error'));
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.error?.code).toBe('EVAL_ERROR');
  });

  it('returns OPA_BINARY_NOT_FOUND when opa is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });

  it('returns TIMEOUT when opa test times out', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.error?.code).toBe('TIMEOUT');
  });

  it('handles coverage report as the only JSON document in stdout', async () => {
    // Some OPA versions may emit just the coverage object (no test records).
    const coverageOnly = {
      files: {
        'policy.rego': { not_covered: [{ start: { row: 5 }, end: { row: 8 } }], coverage: 50 },
      },
      coverage: 50,
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(JSON.stringify(coverageOnly)));
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool<RegoCoverageGapsOutput>(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.filesWithGaps).toHaveLength(1);
    expect(env.data?.testsPassed).toBe(0);
  });

  it('passes --coverage flag to opa test', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(coverageStdout([passingTestRecord], singleFileCoverage(100, false))),
    );
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    await callTool(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--coverage');
  });

  it('passes runPattern to opa test when provided', async () => {
    mockRun.mockResolvedValueOnce(
      spawnSuccess(coverageStdout([passingTestRecord], singleFileCoverage(100, false))),
    );
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    await callTool(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
      runPattern: 'test_allow_.*',
    });

    const args = mockRun.mock.calls[0]![1].args;
    const runIdx = args.indexOf('--run');
    expect(runIdx).toBeGreaterThan(-1);
    expect(args[runIdx + 1]).toBe('test_allow_.*');
  });

  it('returns PATH_NOT_ALLOWED for paths outside allowed roots', async () => {
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool(server, 'rego_coverage_gaps', {
      paths: ['/not/allowed/path'],
    });

    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('correctly counts uncovered lines across multiple ranges', async () => {
    const coverage = {
      files: {
        'policy.rego': {
          covered: [],
          not_covered: [
            { start: { row: 1 }, end: { row: 3 } }, // 3 lines
            { start: { row: 10 }, end: { row: 10 } }, // 1 line
            { start: { row: 20 }, end: { row: 24 } }, // 5 lines
          ],
          coverage: 0,
        },
      },
      coverage: 0,
    };
    mockRun.mockResolvedValueOnce(spawnSuccess(coverageStdout([], coverage)));
    const server = makeServer();
    registerRegoCoverageGaps(server, baseConfig);
    const env = await callTool<RegoCoverageGapsOutput>(server, 'rego_coverage_gaps', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.filesWithGaps[0]?.uncoveredLineCount).toBe(9); // 3 + 1 + 5
  });
});

// ─── rego_security_audit ──────────────────────────────────────────────────

describe('rego_security_audit', () => {
  const mockLintResult = (violations: unknown[]) =>
    JSON.stringify({
      violations,
      notices: [],
      summary: { files_scanned: 3, rules_skipped: 0, num_violations: violations.length },
    });

  const highViolation = {
    title: 'http-send-using-http',
    description: 'http.send called with http:// URL',
    category: 'security',
    level: 'error',
    location: { file: 'policy.rego', row: 12, col: 5 },
    related_resources: [],
  };

  const mediumViolation = {
    title: 'incomplete-model',
    description: 'Partial rule has no default',
    category: 'bugs',
    level: 'warning',
    location: { file: 'other.rego', row: 3, col: 1 },
    related_resources: [],
  };

  it('returns findings with correct severity levels', async () => {
    // exit code 3 = regal found violations; still produces JSON
    mockRun.mockResolvedValueOnce(
      spawnFailure(3, '', mockLintResult([highViolation, mediumViolation])),
    );
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool<RegoSecurityAuditOutput>(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.totalFindings).toBe(2);
    expect(env.data?.highSeverity).toBe(1);
    expect(env.data?.mediumSeverity).toBe(1);
    expect(env.data?.filesScanned).toBe(3);
  });

  it('returns empty findings when no violations found', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(mockLintResult([])));
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool<RegoSecurityAuditOutput>(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.ok).toBe(true);
    expect(env.data?.totalFindings).toBe(0);
    expect(env.data?.findings).toHaveLength(0);
  });

  it('attaches a specific remediation hint for known rule titles', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(3, '', mockLintResult([highViolation])));
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool<RegoSecurityAuditOutput>(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    const finding = env.data?.findings[0];
    expect(finding?.title).toBe('http-send-using-http');
    expect(finding?.remediation).toMatch(/https/);
    expect(finding?.severity).toBe('high');
  });

  it('attaches specific hints for real regal bugs-category rule names', async () => {
    const cases: Array<{ title: string; match: RegExp }> = [
      { title: 'duplicate-rule', match: /duplicate/ },
      { title: 'rule-shadows-builtin', match: /shadow/i },
      { title: 'sprintf-arguments-mismatch', match: /sprintf/i },
    ];
    for (const { title, match } of cases) {
      const violation = {
        title,
        description: 'test',
        category: 'bugs',
        level: 'error',
        location: { file: 'p.rego', row: 1, col: 1 },
      };
      mockRun.mockResolvedValueOnce(spawnFailure(3, '', mockLintResult([violation])));
      const server = makeServer();
      registerRegoSecurityAudit(server, baseConfig);
      const env = await callTool<RegoSecurityAuditOutput>(server, 'rego_security_audit', {
        paths: [fixturePath('policies', 'valid')],
      });
      expect(env.data?.findings[0]?.remediation).toMatch(match);
    }
  });

  it('attaches the default remediation hint for unknown rule titles', async () => {
    const unknownViolation = {
      title: 'some-brand-new-rule',
      description: 'something unfamiliar',
      category: 'security',
      level: 'error',
      location: { file: 'policy.rego', row: 1, col: 1 },
    };
    mockRun.mockResolvedValueOnce(spawnFailure(3, '', mockLintResult([unknownViolation])));
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool<RegoSecurityAuditOutput>(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.data?.findings[0]?.remediation).toMatch(/Regal documentation/);
  });

  it('sorts high severity findings before medium', async () => {
    mockRun.mockResolvedValueOnce(
      spawnFailure(3, '', mockLintResult([mediumViolation, highViolation])),
    );
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool<RegoSecurityAuditOutput>(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.data?.findings[0]?.severity).toBe('high');
    expect(env.data?.findings[1]?.severity).toBe('medium');
  });

  it('returns REGAL_NOT_FOUND when regal binary is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.error?.code).toBe('REGAL_NOT_FOUND');
  });

  it('returns TIMEOUT when regal times out', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.error?.code).toBe('TIMEOUT');
  });

  it('returns UNKNOWN_ERROR when regal produces no JSON', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'config error', 'not json'));
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('returns PATH_NOT_ALLOWED for paths outside allowed roots', async () => {
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool(server, 'rego_security_audit', {
      paths: ['/outside/allowed'],
    });

    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('passes --disable-all and --enable-category security/bugs to regal', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(mockLintResult([])));
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    await callTool(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--disable-all');
    expect(args).toContain('--enable-category');
    const catArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--enable-category' && args[i + 1]) {
        catArgs.push(args[i + 1] as string);
      }
    }
    expect(catArgs).toContain('security');
    expect(catArgs).toContain('bugs');
  });

  it('includes file, row, and col in each finding', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(3, '', mockLintResult([highViolation])));
    const server = makeServer();
    registerRegoSecurityAudit(server, baseConfig);
    const env = await callTool<RegoSecurityAuditOutput>(server, 'rego_security_audit', {
      paths: [fixturePath('policies', 'valid')],
    });

    const finding = env.data?.findings[0];
    expect(finding?.file).toBe('policy.rego');
    expect(finding?.row).toBe(12);
    expect(finding?.col).toBe(5);
  });
});
