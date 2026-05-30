/**
 * `rego_test` -- run Rego unit tests via `opa test`.
 *
 * Returns per-test pass/fail records. With `coverage: true` or `threshold`,
 * OPA switches to coverage-report output mode: stdout becomes a coverage
 * JSON object (no test-record array), and a threshold failure causes OPA to
 * exit non-zero with a human-readable message on stderr.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import {
  mapSubprocessFailure,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';

const RegoTestInput = {
  paths: z
    .array(z.string())
    .min(1)
    .describe(
      'Test directories or files. `opa test` looks for `*_test.rego` siblings of source files.',
    ),
  verbose: z.boolean().optional().describe('Emit per-test pass/fail details.'),
  coverage: z
    .boolean()
    .optional()
    .describe(
      'Include per-line coverage data. Switches output to coverage-report mode: test record counts are not available, but `coverage` and `coveragePct` fields are populated.',
    ),
  runPattern: z
    .string()
    .optional()
    .describe('Run only tests whose names match this regular expression (passed as `--run`).'),
  threshold: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Minimum coverage percentage required (0–100). Returns COVERAGE_BELOW_THRESHOLD when actual coverage falls below this value. Implicitly enables coverage-report output mode.',
    ),
  varValues: z
    .boolean()
    .optional()
    .describe(
      'Include local variable bindings in trace output (`--var-values`). When a table-driven test using `every tc in cases { ... }` fails, the trace shows which `tc` triggered the failure. Has no effect unless `verbose: true` is also set (OPA only emits trace entries in verbose mode).',
    ),
  ignorePatterns: z
    .array(z.string())
    .optional()
    .describe(
      'Glob patterns for files to exclude from the test run (`--ignore <pattern>`). Pass one pattern per array element. Useful for excluding generated or fixture files that contain no tests (e.g. `["*_generated.rego", "fixtures/**"]`).',
    ),
  bundle: z
    .boolean()
    .optional()
    .describe(
      'Load paths as OPA bundle roots (`--bundle`). Required when testing policies structured as bundles with a `manifest.json` at the root. Not needed for plain policy directories.',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Number of times to repeat each test (`--count N`). Default is 1. Useful for measuring repeatability or catching flaky tests under load.',
    ),
  timeout: z
    .string()
    .optional()
    .describe(
      'Per-test timeout as a Go duration string, e.g. `"30s"` or `"2m"` (`--timeout`). OPA\'s default is 5s. Increase for tests that load large policy sets or call slow built-ins.',
    ),
};

export interface TestRecord {
  location?: { file?: string; row?: number; col?: number };
  package?: string;
  name?: string;
  pass?: boolean;
  fail?: boolean;
  skip?: boolean;
  duration?: number;
  trace?: unknown;
  output?: string;
}

interface CoverageRange {
  start: { row: number };
  end: { row: number };
}

interface CoverageFileSummary {
  covered?: CoverageRange[];
  not_covered?: CoverageRange[];
  covered_lines?: number;
  not_covered_lines?: number;
  coverage?: number;
}

export interface CoverageReport {
  files?: Record<string, CoverageFileSummary>;
  covered_lines?: number;
  not_covered_lines?: number;
  /** Overall coverage percentage (0–100). */
  coverage?: number;
}

export interface RegoTestOutput {
  /**
   * Number of passing tests. Always 0 in coverage mode (OPA does not emit
   * test records when coverage output is active).
   */
  passed: number;
  /** Number of failing tests. Always 0 in coverage mode (failures are returned as errors). */
  failed: number;
  /** Number of skipped (todo_*) tests. Always 0 in coverage mode. */
  skipped: number;
  /** Total test records. Always 0 in coverage mode. */
  total: number;
  /** Per-test records. Empty in coverage mode. */
  results: TestRecord[];
  /** Per-file coverage report. Present when `coverage: true` or `threshold` is set and threshold is met. */
  coverage?: CoverageReport;
  /** Overall coverage percentage (convenience alias for `coverage.coverage`). */
  coveragePct?: number;
  /** Present when `threshold` is set and the threshold was met. */
  thresholdMet?: boolean;
  /**
   * Groups of parameterized test cases. When OPA runs `test_X[case]`-style
   * parametrized rules, each case appears as a separate record like
   * `test_X[{"role":"admin"}]`. This field maps the base test name (e.g.
   * `test_X`) to all of its case records, making it easy to see which specific
   * inputs triggered a failure. Only present when at least one parametrized
   * group is detected.
   */
  parameterizedGroups?: Record<string, TestRecord[]>;
}

export function registerRegoTest(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_test',
    {
      title: 'Run Rego tests',
      description:
        "Run Rego unit tests with `opa test`. Returns aggregate pass/fail counts plus per-test records. Tests live in `*_test.rego` files; rule names beginning with `test_` are picked up automatically. Use `runPattern` to filter by name regex; when no tests match, the error hint includes the pattern you supplied. Use `threshold` to gate on minimum coverage (returns COVERAGE_BELOW_THRESHOLD on failure). Use `varValues: true` with `verbose: true` to include local variable bindings in the trace -- essential for debugging table-driven tests written with `every tc in cases { ... }` to identify which case caused a failure. When tests use the `test_X[case]` parametrized form, the output includes `parameterizedGroups` mapping each base test name to its case records. Use `ignorePatterns` to exclude generated or fixture files. Use `bundle: true` when testing bundle-structured policy directories. Use `timeout` to raise the per-test limit beyond OPA's default 5s. Note: enabling `coverage` or `threshold` switches OPA to coverage-report output mode -- per-test counts are unavailable but `coverage` and `coveragePct` fields are populated.",
      inputSchema: RegoTestInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (
      {
        paths,
        verbose,
        coverage,
        runPattern,
        threshold,
        varValues,
        ignorePatterns,
        bundle,
        count,
        timeout,
      },
      { signal },
    ) => {
      return withToolEnvelope<RegoTestOutput>(config, async () => {
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        if (count !== undefined && count < 1) {
          return err('INVALID_INPUT', '`count` must be at least 1.');
        }

        // When coverage or threshold is set, OPA changes its output format:
        // stdout becomes a coverage JSON object instead of a test-record array.
        const coverageMode = coverage === true || threshold !== undefined;

        const result = await opa.test(
          {
            paths: validation.resolved,
            verbose,
            coverage: coverageMode,
            runPattern,
            varValues,
            threshold,
            ignorePatterns,
            bundle,
            count,
            timeout,
          },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (coverageMode) {
          return handleCoverageMode(result.stdout, result.stderr, result.exitCode, threshold);
        }

        return handleTestRecordsMode(result.stdout, result.exitCode, runPattern);
      });
    },
  );
}

/**
 * Handle output from `opa test --coverage` or `opa test --threshold`.
 *
 * OPA emits a coverage JSON object on stdout when all tests pass and the
 * threshold (if set) is met. On any failure, stdout is empty and stderr
 * carries a human-readable message.
 *
 * Exit codes in coverage mode:
 *   0  -- all tests pass, threshold met (coverage JSON on stdout)
 *   1  -- one or more tests failed (threshold was set; stderr has FAIL lines)
 *   2  -- threshold not met with all tests passing (stderr has threshold message)
 *        OR one or more tests failed without threshold (stderr has FAIL lines)
 */
function handleCoverageMode(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  threshold: number | undefined,
): ReturnType<typeof ok<RegoTestOutput>> | ReturnType<typeof err> {
  if (exitCode === 0) {
    const coverageData = tryParseJson<CoverageReport>(stdout);
    return ok<RegoTestOutput>({
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      results: [],
      coverage: coverageData,
      coveragePct: coverageData?.coverage,
      thresholdMet: threshold !== undefined ? true : undefined,
    });
  }

  // Non-zero exit: distinguish threshold failure from test failures by stderr content.
  // Threshold not met: "Code coverage threshold not met: got X instead of Y"
  const stderrTrimmed = stderr.trim();
  const thresholdMatch = /got\s+([\d.]+)\s+instead\s+of\s+([\d.]+)/i.exec(stderrTrimmed);
  if (thresholdMatch) {
    const actualCoverage = parseFloat(thresholdMatch[1]!);
    const requiredThreshold = parseFloat(thresholdMatch[2]!);
    return err('COVERAGE_BELOW_THRESHOLD', stderrTrimmed, {
      hint: `Increase test coverage to at least ${requiredThreshold}%. Currently at ${actualCoverage}%.`,
      details: { actualCoverage, requiredThreshold },
    });
  }

  // Test failures in coverage mode (stderr has "package.test_name: FAIL" lines).
  return err('EVAL_ERROR', stderrTrimmed || 'One or more tests failed.', {
    hint: 'Fix the failing tests then re-run. Use verbose: true for trace output.',
    details: { exitCode },
  });
}

/**
 * Handle output from `opa test` without coverage or threshold.
 *
 * OPA emits a JSON array of test records. Passing tests have no `pass` field;
 * only failing tests carry `fail: true` and skipped tests carry `skip: true`.
 * `passed` is derived as `total - failed - skipped`.
 *
 * Exit codes in normal mode:
 *   0 -- all tests pass
 *   2 -- one or more tests failed (failed records still appear in the JSON array)
 */
function handleTestRecordsMode(
  stdout: string,
  exitCode: number | null,
  runPattern?: string,
): ReturnType<typeof ok<RegoTestOutput>> | ReturnType<typeof err> {
  let records: TestRecord[] = [];

  // OPA emits a JSON array. Older versions may emit NDJSON (one object per line).
  const arrayParsed = tryParseJson<TestRecord[]>(stdout);
  if (Array.isArray(arrayParsed)) {
    records = arrayParsed;
  } else {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = tryParseJson<TestRecord>(trimmed);
      if (parsed) records.push(parsed);
    }
  }

  if (records.length === 0 && exitCode === 0) {
    const hint = runPattern
      ? `No tests matched the pattern "${runPattern}". Verify the regex against your test rule names. Tests live in *_test.rego files with rules named test_*.`
      : 'Tests live in *_test.rego files with rules named test_*.';
    return err(
      'NO_TESTS_FOUND',
      'opa test did not discover any test rules in the provided paths.',
      {
        hint,
      },
    );
  }

  // OPA does NOT emit `pass: true` for passing tests; only `fail: true` for
  // failures and `skip: true` for todo_* tests. Derive passed count from total.
  const failed = records.filter((r) => r.fail).length;
  const skipped = records.filter((r) => r.skip).length;
  const passed = records.length - failed - skipped;

  // Group parametrized test cases. OPA names them like `test_X[{"key":"val"}]`;
  // extract the base name and bucket records for at-a-glance failure analysis.
  const parameterizedGroups: Record<string, TestRecord[]> = {};
  for (const record of records) {
    if (record.name) {
      const match = /^(test_[a-zA-Z0-9_]+)\[/.exec(record.name);
      if (match) {
        const baseName = match[1]!;
        (parameterizedGroups[baseName] ??= []).push(record);
      }
    }
  }
  const hasGroups = Object.keys(parameterizedGroups).length > 0;

  return ok<RegoTestOutput>({
    passed,
    failed,
    skipped,
    total: records.length,
    results: records,
    ...(hasGroups ? { parameterizedGroups } : {}),
  });
}
