/**
 * `rego_coverage_gaps` -- run opa test --coverage and surface the
 * uncovered line ranges per file as a structured gap report.
 *
 * OPA emits two JSON documents on stdout when --coverage is set: a
 * test-results array followed by a coverage report object. Both are
 * parsed here; files with uncovered ranges are returned sorted by
 * coverage ascending so the worst-covered files appear first.
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

const RegoCoverageGapsInput = {
  paths: z
    .array(z.string())
    .min(1)
    .describe(
      'Test directories or files. opa test looks for *_test.rego siblings of source files.',
    ),
  threshold: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Report only files below this coverage percentage (0-100). When omitted, all files with uncovered ranges are reported.',
    ),
  runPattern: z.string().optional().describe('Run only tests whose names match this regex.'),
};

interface CoverageRange {
  start: { row: number; col?: number };
  end: { row: number; col?: number };
}

interface OpaFileReport {
  covered?: CoverageRange[];
  not_covered?: CoverageRange[];
  coverage?: number;
}

interface OpaCoverageReport {
  files?: Record<string, OpaFileReport>;
  coverage?: number;
}

// OPA never emits `pass: true` on passing records -- they simply have no
// status field. Only failing and skipped records carry an explicit marker.
interface OpaTestRecord {
  fail?: boolean;
  skip?: boolean;
}

export interface FileCoverageGap {
  file: string;
  coveragePercent: number;
  uncoveredRanges: CoverageRange[];
  uncoveredLineCount: number;
}

export interface RegoCoverageGapsOutput {
  overallCoverage: number;
  totalFiles: number;
  filesWithGaps: FileCoverageGap[];
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
}

/**
 * Parse the combined stdout of `opa test --coverage --format=json`.
 *
 * OPA emits a JSON test-results array followed by a JSON coverage
 * report object. They may appear on separate lines or concatenated.
 * We scan lines and classify each by shape: arrays are test records,
 * objects with a `files` key are coverage reports.
 */
function parseTestAndCoverage(stdout: string): {
  testRecords: OpaTestRecord[];
  coverageReport: OpaCoverageReport | undefined;
} {
  const testRecords: OpaTestRecord[] = [];
  let coverageReport: OpaCoverageReport | undefined;

  // Fast path: entire stdout is already a coverage-only object.
  const full = tryParseJson<unknown>(stdout);
  if (full && typeof full === 'object' && !Array.isArray(full) && 'files' in full) {
    return { testRecords, coverageReport: full as OpaCoverageReport };
  }

  // Scan line-by-line for the two documents.
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = tryParseJson<unknown>(trimmed);
    if (!parsed) continue;
    if (Array.isArray(parsed)) {
      testRecords.push(...(parsed as OpaTestRecord[]));
    } else if (typeof parsed === 'object' && parsed !== null && 'files' in parsed) {
      coverageReport = parsed as OpaCoverageReport;
    }
  }
  return { testRecords, coverageReport };
}

function countUncoveredLines(ranges: CoverageRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.end.row - r.start.row + 1), 0);
}

export function registerRegoCoverageGaps(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_coverage_gaps',
    {
      title: 'Rego test coverage gaps',
      description:
        'Run opa test --coverage and return a per-file breakdown of uncovered line ranges. Identifies which rules or branches are not yet exercised by tests. Files are sorted by coverage ascending so the worst-covered files appear first. Use threshold to limit the report to files below a target coverage percentage.',
      inputSchema: RegoCoverageGapsInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ paths, threshold, runPattern }, { signal }) => {
      return withToolEnvelope<RegoCoverageGapsOutput>(config, async () => {
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        const result = await opa.test(
          {
            paths: validation.resolved,
            coverage: true,
            runPattern,
          },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        const { testRecords, coverageReport } = parseTestAndCoverage(result.stdout);

        if (!coverageReport) {
          if (result.exitCode !== 0) {
            return err(
              'EVAL_ERROR',
              'opa test reported failures or a compile error; coverage is only emitted when all tests pass. Fix the failing tests or policy errors first.',
              { details: { stderr: result.stderr.trim() } },
            );
          }
          return err(
            'NO_TESTS_FOUND',
            'opa test ran but produced no coverage report. Ensure the paths contain *_test.rego files with test_ rules.',
            {
              hint: 'Test rules must begin with test_ and live in *_test.rego files alongside the policy.',
            },
          );
        }

        const testsFailed = testRecords.filter((r) => r.fail).length;
        const testsSkipped = testRecords.filter((r) => r.skip).length;
        // Passed = total minus explicit failures and skips. OPA never marks
        // passing records with any status field, so filtering for pass: true
        // always produces zero. Subtraction is the correct approach.
        const testsPassed = testRecords.length - testsFailed - testsSkipped;
        const overallCoverage = coverageReport.coverage ?? 0;

        const filesWithGaps: FileCoverageGap[] = [];
        for (const [file, report] of Object.entries(coverageReport.files ?? {})) {
          const coveragePercent = report.coverage ?? 0;
          const notCovered = report.not_covered ?? [];

          // Apply threshold filter: skip files already above the target.
          if (threshold !== undefined && coveragePercent >= threshold) continue;
          // Skip files with no uncovered ranges at all.
          if (notCovered.length === 0) continue;

          filesWithGaps.push({
            file,
            coveragePercent,
            uncoveredRanges: notCovered,
            uncoveredLineCount: countUncoveredLines(notCovered),
          });
        }

        // Sort worst-covered first so the agent sees the biggest gaps immediately.
        filesWithGaps.sort((a, b) => a.coveragePercent - b.coveragePercent);

        return ok<RegoCoverageGapsOutput>({
          overallCoverage,
          totalFiles: Object.keys(coverageReport.files ?? {}).length,
          filesWithGaps,
          testsPassed,
          testsFailed,
          testsSkipped,
        });
      });
    },
  );
}
