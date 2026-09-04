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
import { parseJsonValues } from '../../lib/json-stream.js';
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
      'Number of times to repeat the suite (`--count N`). Default is 1. Useful for catching flaky tests. OPA stops at the first repetition that fails, so `repetitions` in the output reports how many actually ran, and each test is listed once carrying its worst outcome across them.',
    ),
  timeout: z
    .string()
    .optional()
    .describe(
      'Per-test timeout as a Go duration string, e.g. `"30s"` or `"2m"` (`--timeout`). OPA\'s default is 5s. Increase for tests that load large policy sets or call slow built-ins.',
    ),
  explain: z
    .enum(['fails', 'full', 'notes', 'debug'])
    .optional()
    .describe(
      "Add a query-explanation trace to test records (`--explain`). `fails` traces only failing tests, `full` traces everything, `notes` surfaces `trace()` notes, `debug` is most verbose. Populates each record's `trace` field; pair with `verbose: true` for the human-readable trace output too.",
    ),
  v1Compatible: z
    .boolean()
    .optional()
    .describe('Opt in to OPA v1.0-compatible behaviors (`--v1-compatible`).'),
};

export interface TestRecord {
  location?: { file?: string; row?: number; col?: number };
  package?: string;
  name?: string;
  pass?: boolean;
  fail?: boolean;
  skip?: boolean;
  /**
   * Present when the test could not be evaluated: a conflicting rule, a
   * built-in raising with strict errors, and so on. OPA sets this INSTEAD of
   * `fail`, so a record carrying it is neither passed nor failed. Counting
   * `total - failed - skipped` reported such a test as passing.
   */
  error?: { code?: string; message?: string; location?: unknown };
  duration?: number;
  trace?: unknown;
  output?: string;
}

/** A test that could not run is neither a pass nor a failure. */
function isErrored(r: TestRecord): boolean {
  return r.error !== undefined && r.error !== null;
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
  /**
   * Number of tests that could not be evaluated, each carrying `error` in its
   * record. A suite with even one of these has not been proven to pass.
   */
  errored: number;
  /** Total test records. Always 0 in coverage mode. */
  total: number;
  /**
   * How many repetitions of the suite actually ran, present only when more than
   * one did. OPA stops repeating at the first run with a failure, so this can be
   * lower than the requested `count`. Each test appears once in `results`,
   * carrying its worst outcome across the repetitions that ran, so a test that
   * fails intermittently is reported as failing.
   */
  repetitions?: number;
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
        "Run Rego unit tests with `opa test`. Returns aggregate pass/fail/skip/error counts plus per-test records. `errored` counts tests OPA could not evaluate (a rule conflict, a raising built-in); such a test is neither a pass nor a failure, and a suite with any is not passing. Tests live in `*_test.rego` files; rule names beginning with `test_` are picked up automatically. Use `runPattern` to filter by name regex; when no tests match, the error hint includes the pattern you supplied. Use `threshold` to gate on minimum coverage (returns COVERAGE_BELOW_THRESHOLD on failure). Use `varValues: true` with `verbose: true` to include local variable bindings in the trace -- essential for debugging table-driven tests written with `every tc in cases { ... }` to identify which case caused a failure. When tests use the `test_X[case]` parametrized form, the output includes `parameterizedGroups` mapping each base test name to its case records. Use `ignorePatterns` to exclude generated or fixture files. Use `bundle: true` when testing bundle-structured policy directories. Use `timeout` to raise the per-test limit beyond OPA's default 5s. Note: enabling `coverage` or `threshold` switches OPA to coverage-report output mode -- per-test counts are unavailable but `coverage` and `coveragePct` fields are populated.",
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
        explain,
        v1Compatible,
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
            explain,
            v1Compatible,
          },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (coverageMode) {
          return handleCoverageMode(result.stdout, result.stderr, result.exitCode, threshold);
        }

        return handleTestRecordsMode(result.stdout, result.stderr, result.exitCode, runPattern);
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
  const coverageData = tryParseJson<CoverageReport>(stdout);

  if (exitCode === 0) {
    return ok<RegoTestOutput>({
      passed: 0,
      failed: 0,
      skipped: 0,
      errored: 0,
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

  // A suite holding a `todo_` test exits non-zero in coverage mode with an
  // empty stderr, and the coverage report is on stdout as asked for. Reporting
  // that as "one or more tests failed" was wrong twice: nothing failed, and the
  // report the caller wanted was thrown away.
  if (coverageData !== undefined && stderrTrimmed.length === 0) {
    return ok<RegoTestOutput>({
      passed: 0,
      failed: 0,
      skipped: 0,
      errored: 0,
      total: 0,
      results: [],
      coverage: coverageData,
      coveragePct: coverageData.coverage,
      thresholdMet: threshold !== undefined ? true : undefined,
    });
  }

  // Test failures in coverage mode (stderr has "package.test_name: FAIL" lines).
  return err('EVAL_ERROR', stderrTrimmed || 'One or more tests failed.', {
    hint: 'Fix the failing tests then re-run. Use verbose: true for trace output.',
    details: {
      exitCode,
      // Keep the report when OPA produced one; it is what was asked for.
      ...(coverageData !== undefined ? { coveragePct: coverageData.coverage } : {}),
    },
  });
}

/**
 * Collapse the repetitions of `opa test --count N` into one record per test.
 *
 * The flag exists to surface tests that do not behave the same way every time,
 * so a test keeps its worst outcome across the runs: an error beats a failure,
 * a failure beats a pass, and a test skipped in every run stays skipped. The
 * longest duration is kept, since that is the one a timeout would hit.
 *
 * OPA stops repeating once a run fails, so `runs` can be shorter than the
 * requested count; the caller reports the length rather than the request.
 */
function mergeRepetitions(runs: TestRecord[][]): TestRecord[] {
  const worst = new Map<string, TestRecord>();
  const order: string[] = [];

  for (const run of runs) {
    for (const record of run) {
      const key = `${record.package ?? ''}.${record.name ?? ''}`;
      const seen = worst.get(key);
      if (seen === undefined) {
        worst.set(key, { ...record });
        order.push(key);
        continue;
      }
      const merged: TestRecord = { ...seen };
      if (record.error !== undefined) merged.error = record.error;
      if (record.fail === true) merged.fail = true;
      // A test skipped in one run but executed in another is not skipped.
      if (record.skip !== true) delete merged.skip;
      if ((record.duration ?? 0) > (merged.duration ?? 0)) merged.duration = record.duration;
      // An errored record is neither passed nor failed, so drop the weaker mark.
      if (merged.error !== undefined) delete merged.fail;
      worst.set(key, merged);
    }
  }

  return order.map((key) => worst.get(key)!);
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
  stderr: string,
  exitCode: number | null,
  runPattern?: string,
): ReturnType<typeof ok<RegoTestOutput>> | ReturnType<typeof err> {
  let records: TestRecord[] = [];
  let repetitions = 1;

  // OPA emits a JSON array. With `--count N` it emits one such array per
  // repetition, back to back, which is neither a single JSON value nor NDJSON;
  // reading only the first form reported a repeated run as no tests at all.
  // Older versions may emit NDJSON (one object per line).
  const arrayParsed = tryParseJson<TestRecord[]>(stdout);
  if (Array.isArray(arrayParsed)) {
    records = arrayParsed;
  } else {
    const runs = parseJsonValues<TestRecord[] | TestRecord>(stdout).filter((v): v is TestRecord[] =>
      Array.isArray(v),
    );
    if (runs.length > 0) {
      repetitions = runs.length;
      records = mergeRepetitions(runs);
    } else {
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const parsed = tryParseJson<TestRecord>(trimmed);
        if (parsed) records.push(parsed);
      }
    }
  }

  if (records.length === 0) {
    // A non-zero exit with no test records means opa never got as far as
    // running tests -- typically the policies failed to load or compile.
    // Reporting that as a successful run of zero tests would tell the caller
    // everything is fine while their policies are broken.
    if (exitCode !== 0) {
      return err('INVALID_REGO', 'opa test could not load the policies under the provided paths.', {
        hint: 'Fix the reported policy errors, then re-run the tests.',
        details: { stderr: stderr.trim() },
      });
    }
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
  // failures, `skip: true` for todo_* tests, and `error` for a test that could
  // not be evaluated. Passing is what is left after all three: subtracting only
  // failures and skips counted an errored test as a pass.
  const failed = records.filter((r) => r.fail).length;
  const skipped = records.filter((r) => r.skip).length;
  const errored = records.filter(isErrored).length;
  const passed = records.length - failed - skipped - errored;

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
    errored,
    total: records.length,
    results: records,
    ...(repetitions > 1 ? { repetitions } : {}),
    ...(hasGroups ? { parameterizedGroups } : {}),
  });
}
