/**
 * `rego_test` -- run Rego unit tests via `opa test`.
 *
 * Returns per-test pass/fail records. With `coverage: true` or `threshold`,
 * the suite also runs a second time for coverage: opa's coverage output is a
 * report with no test records in it, and it prints none at all for a run in
 * which a test fails. A threshold failure exits non-zero with a message on
 * stderr.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { parseJsonValues } from '../../lib/json-stream.js';
import type { SpawnResult } from '../../lib/subprocess.js';
import {
  mapSubprocessFailure,
  lastJsonObject,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';
import type { ToolEnvelope } from '../../types.js';
import { mentionsPreV1, PRE_V1_HINT, v0CompatibleField } from '../_rego-version.js';

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
      'Add per-line coverage (`coverage`, `coveragePct`) to the test results. The suite runs twice, once for the results and once for coverage. Coverage is left out, with a warning, when a test fails or errors: opa reports none for such a run.',
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
      'Minimum coverage percentage required (0–100). Returns COVERAGE_BELOW_THRESHOLD when the tests pass but coverage falls below this value. Implies `coverage`.',
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
  v0Compatible: v0CompatibleField,
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
  /**
   * Per-case outcomes for a parameterized test, keyed by case name. OPA reports
   * a `test_x[case]` rule as a single record and puts the cases here rather than
   * emitting one record per case.
   */
  sub_results?: Record<string, { name?: string; fail?: boolean; skip?: boolean }>;
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
   * Whether the suite passes: at least one test ran and none failed, errored
   * or was skipped (a `todo_test_`).
   */
  allPassed?: boolean;
  /** Number of passing tests. */
  passed: number;
  /** Number of failing tests. */
  failed: number;
  /** Number of skipped (todo_*) tests. */
  skipped: number;
  /**
   * Number of tests that could not be evaluated, each carrying `error` in its
   * record. A suite with even one of these has not been proven to pass.
   */
  errored: number;
  /** Total test records. */
  total: number;
  /**
   * How many repetitions of the suite actually ran, present only when more than
   * one did. OPA stops repeating at the first run with a failure, so this can be
   * lower than the requested `count`. Each test appears once in `results`,
   * carrying its worst outcome across the repetitions that ran, so a test that
   * fails intermittently is reported as failing.
   */
  repetitions?: number;
  /** Per-test records. */
  results: TestRecord[];
  /**
   * Per-file coverage report. Present when `coverage: true` or `threshold` is
   * set, no test failed or errored, and the threshold, if any, was met.
   */
  coverage?: CoverageReport;
  /** Overall coverage percentage (convenience alias for `coverage.coverage`). */
  coveragePct?: number;
  /** Present when `threshold` is set and the threshold was met. */
  thresholdMet?: boolean;
  /**
   * Case-level totals across every parameterized test, present only when the
   * run had one. The top-level counts follow OPA and treat a parameterized rule
   * as a single test however many cases it holds.
   */
  caseCounts?: { total: number; passed: number; failed: number; skipped: number };
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
        "Run Rego unit tests with `opa test`. Returns aggregate pass/fail/skip/error counts plus per-test records. `errored` counts tests OPA could not evaluate (a rule conflict, a raising built-in); such a test is neither a pass nor a failure, and a suite with any is not passing. Tests live in `*_test.rego` files; rule names beginning with `test_` are picked up automatically. Use `runPattern` to filter by name regex; when no tests match, the error hint includes the pattern you supplied. Use `threshold` to gate on minimum coverage (returns COVERAGE_BELOW_THRESHOLD on failure). Use `varValues: true` with `verbose: true` to include local variable bindings in the trace -- essential for debugging table-driven tests written with `every tc in cases { ... }` to identify which case caused a failure. When tests use the `test_x[case]` parameterized form, OPA reports the rule as a single test whatever the number of cases; `parameterizedGroups` maps the rule name to a record per case and `caseCounts` totals them, so a failing rule says which case failed. Use `ignorePatterns` to exclude generated or fixture files. Use `bundle: true` when testing bundle-structured policy directories. Use `timeout` to raise the per-test limit beyond OPA's default 5s. With `coverage` or `threshold` the suite runs a second time for the coverage report, which is added to the results; it is left out when a test fails or errors, since opa reports no coverage for such a run.",
      inputSchema: RegoTestInput,
      annotations: {
        readOnlyHint: false,
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
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
        v0Compatible,
      },
      { signal },
    ) => {
      return withToolEnvelope<RegoTestOutput>(config, async () => {
        if (v0Compatible && v1Compatible) {
          return err(
            'INVALID_INPUT',
            '`v0Compatible` and `v1Compatible` ask for opposite Rego versions; set one.',
          );
        }
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        if (count !== undefined && count < 1) {
          return err('INVALID_INPUT', '`count` must be at least 1.');
        }

        const selection = {
          paths: validation.resolved,
          runPattern,
          ignorePatterns,
          bundle,
          timeout,
          v1Compatible,
          v0Compatible,
        };

        const result = await opa.test({ ...selection, verbose, varValues, count, explain }, signal);

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        const tested = handleTestRecordsMode(
          result.stdout,
          result.stderr,
          result.exitCode,
          runPattern,
          v0Compatible,
        );

        // opa's coverage output is a report with no test records in it, so the
        // counts above come from a run of their own and coverage from a second
        // one. Reading counts from the coverage run reported every suite as
        // zero tests.
        if (coverage !== true && threshold === undefined) return tested;
        if (!tested.ok || tested.data === undefined) return tested;
        if (tested.data.failed > 0 || tested.data.errored > 0) {
          return ok(tested.data, [COVERAGE_SKIPPED]);
        }

        // One repetition is enough for coverage, and tracing does not apply to it.
        const coverageRun = await opa.test({ ...selection, coverage: true, threshold }, signal);
        const coverageFailure = mapSubprocessFailure(coverageRun, 'opa');
        if (coverageFailure) return coverageFailure;

        return withCoverage(tested.data, coverageRun, threshold);
      });
    },
  );
}

/** opa never reached the tests: the policies under the paths did not load or compile. */
function loadFailure(stderr: string, v0Compatible: boolean | undefined): ToolEnvelope<never> {
  return err('INVALID_REGO', 'opa test could not load the policies under the provided paths.', {
    hint:
      !v0Compatible && mentionsPreV1(stderr)
        ? PRE_V1_HINT
        : 'Fix the reported policy errors, then re-run the tests.',
    details: { stderr: stderr.trim() },
  });
}

const COVERAGE_SKIPPED =
  'Coverage was not measured: opa reports coverage only for a run in which no test fails or errors.';

/**
 * Add the report from `opa test --coverage` (and `--threshold`) to the results
 * of the run that came before it, in which every test passed or was skipped.
 *
 *   exit 0, report on stdout       -- coverage, threshold met if one was set
 *   exit 2, empty stderr, report   -- the same; a `todo_` test exits non-zero
 *   "got X instead of Y" on stderr -- threshold not met; stdout is empty
 *
 * Anything else means the coverage run failed where the results run passed,
 * which a test that does not pass every time can do. The results stand; the
 * coverage is reported missing rather than as a failure.
 */
function withCoverage(
  results: RegoTestOutput,
  run: SpawnResult,
  threshold: number | undefined,
): ToolEnvelope<RegoTestOutput> {
  const report = lastJsonObject<CoverageReport>(
    run.stdout,
    (v) => typeof (v as { coverage?: unknown }).coverage === 'number',
  );
  const stderr = run.stderr.trim();

  const below = /got\s+([\d.]+)\s+instead\s+of\s+([\d.]+)/i.exec(stderr);
  if (below) {
    const actualCoverage = parseFloat(below[1]!);
    const requiredThreshold = parseFloat(below[2]!);
    return err('COVERAGE_BELOW_THRESHOLD', stderr, {
      hint: `Increase test coverage to at least ${requiredThreshold}%. Currently at ${actualCoverage}%.`,
      details: { actualCoverage, requiredThreshold },
    });
  }

  if (report !== undefined && (run.exitCode === 0 || stderr.length === 0)) {
    return ok<RegoTestOutput>({
      ...results,
      coverage: report,
      coveragePct: report.coverage,
      ...(threshold !== undefined ? { thresholdMet: true } : {}),
    });
  }

  const reason = stderr.split(/\r?\n/)[0] || `exit code ${run.exitCode}`;
  return ok(results, [`Coverage was not measured: the coverage run did not complete (${reason}).`]);
}

/**
 * Bucket the cases of a parameterized test under the rule they belong to.
 *
 * OPA reports a `test_x[case]` rule as one record carrying a `sub_results`
 * object, not as one record per case. Looking for a bracketed name meant the
 * grouping never fired on any OPA 1.x run, and the per-case outcomes OPA had
 * already worked out were passed through untouched: a caller saw one failing
 * test and no indication which of its cases failed. The bracketed form is still
 * read, since that is what older versions emitted.
 */
function groupParameterized(records: TestRecord[]): {
  parameterizedGroups: Record<string, TestRecord[]>;
  caseCounts: { total: number; passed: number; failed: number; skipped: number };
} {
  const parameterizedGroups: Record<string, TestRecord[]> = {};
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };

  const add = (baseName: string, record: TestRecord): void => {
    (parameterizedGroups[baseName] ??= []).push(record);
    counts.total++;
    if (record.skip === true) counts.skipped++;
    else if (record.fail === true || isErrored(record)) counts.failed++;
    else counts.passed++;
  };

  for (const record of records) {
    if (record.name === undefined) continue;

    if (record.sub_results) {
      for (const [caseName, outcome] of Object.entries(record.sub_results)) {
        const caseRecord: TestRecord = {
          name: outcome.name ?? caseName,
          ...(record.package !== undefined ? { package: record.package } : {}),
          ...(record.location !== undefined ? { location: record.location } : {}),
          ...(outcome.fail === true ? { fail: true } : {}),
          ...(outcome.skip === true ? { skip: true } : {}),
        };
        add(record.name, caseRecord);
      }
      continue;
    }

    // Older OPA named each case in the record itself: `test_x[{"k":"v"}]`.
    const match = /^(test_[a-zA-Z0-9_]+)\[/.exec(record.name);
    if (match) add(match[1]!, record);
  }

  return { parameterizedGroups, caseCounts: counts };
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
  v0Compatible?: boolean,
): ToolEnvelope<RegoTestOutput> {
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
    if (exitCode !== 0) return loadFailure(stderr, v0Compatible);
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

  const { parameterizedGroups, caseCounts } = groupParameterized(records);
  const hasGroups = Object.keys(parameterizedGroups).length > 0;

  return ok<RegoTestOutput>({
    // A skipped (todo_test_) or errored test is not a pass; opa test exits
    // non-zero for both.
    allPassed: failed === 0 && errored === 0 && skipped === 0 && passed > 0,
    passed,
    failed,
    skipped,
    errored,
    total: records.length,
    results: records,
    ...(repetitions > 1 ? { repetitions } : {}),
    ...(hasGroups ? { caseCounts, parameterizedGroups } : {}),
  });
}
