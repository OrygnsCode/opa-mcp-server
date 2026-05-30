/**
 * `rego_test_multiroot` -- run Rego tests across multiple independent package roots.
 *
 * OPA auto-recurses into subdirectories when given a directory path, which
 * causes package-conflict errors in repos with multiple independent module
 * namespaces (OPA issue #4724). This tool runs `opa test` once per root and
 * aggregates the results, solving the problem at the MCP layer.
 *
 * Two modes:
 *   explicit -- caller supplies the root list; each root can carry per-root
 *               `include` paths (e.g., shared libraries) and an optional name.
 *   scan     -- auto-discovers leaf test roots using the leaf rule: a directory
 *               is a root only if it directly contains `*_test.rego` files AND
 *               none of its eligible subdirectories do. Prevents OPA's automatic
 *               recursion from double-running descendant roots.
 */
import * as fs from 'node:fs/promises';
import { join, sep } from 'node:path';

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { tryParseJson, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';
import type { SpawnResult } from '../../lib/subprocess.js';
import type { ToolErrorCode } from '../../types.js';
import type { CoverageReport, TestRecord } from './test.js';

// ─── Constants ───────────────────────────────────────────────────────────────

// Minimal interface for the directory entries we care about.
// Using a local interface avoids the Dirent<string> vs Dirent<Buffer> overload
// complexity introduced in newer versions of @types/node.
interface DirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const ALWAYS_IGNORE = new Set([
  '.git',
  'node_modules',
  'vendor',
  '.next',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.tox',
  'coverage',
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RootTestResult {
  path: string;
  name?: string;
  include?: string[];
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  results: TestRecord[];
  coverage?: CoverageReport;
  coveragePct?: number;
  thresholdMet?: boolean;
  error?: { code: ToolErrorCode; message: string; hint?: string };
}

export interface MultiRootTestOutput {
  mode: 'explicit' | 'scan';
  roots: RootTestResult[];
  totalPassed: number;
  totalFailed: number;
  totalSkipped: number;
  totalTests: number;
  rootsRun: number;
  rootsWithErrors: number;
  rootsWithFailures: number;
  overallCoveragePct?: number;
  ancestorSkipped?: string[];
}

interface ResolvedRoot {
  path: string;
  name?: string;
  include: string[];
}

interface RootOutcome {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  results: TestRecord[];
  coverage?: CoverageReport;
  coveragePct?: number;
  thresholdMet?: boolean;
  error?: { code: ToolErrorCode; message: string; hint?: string };
}

interface WalkState {
  roots: string[];
  ancestorSkipped: string[];
  tooMany: boolean;
}

interface WalkOpts {
  maxDepth: number;
  maxRoots: number;
  ignorePatterns: string[];
  sharedPathsResolved: string[];
  scanDirReal: string;
}

// ─── Input schema ────────────────────────────────────────────────────────────

const RootEntrySchema = z.object({
  path: z.string().describe('Absolute or allowed-relative path to the test root directory.'),
  include: z
    .array(z.string())
    .optional()
    .describe(
      "Extra paths to add to this root's `opa test` invocation (e.g., shared library directories). These paths are passed after the root path so OPA can resolve imports.",
    ),
  name: z.string().optional().describe('Human-readable label for this root (appears in output).'),
});

const RegoTestMultirootInput = {
  roots: z
    .array(RootEntrySchema)
    .min(1)
    .optional()
    .describe(
      'Explicit list of test root directories. Use when roots are known upfront or when scan mode cannot determine the correct roots. Mutually exclusive with `scanDir`.',
    ),
  scanDir: z
    .string()
    .optional()
    .describe(
      'Top-level directory to scan for test roots. Uses the leaf rule: a directory is a root only if it directly contains `*_test.rego` files and none of its eligible subdirectories do. Mutually exclusive with `roots`.',
    ),
  sharedPaths: z
    .array(z.string())
    .optional()
    .describe(
      "Paths added to every root's `opa test` invocation and excluded from auto-discovery. Use for shared library directories that all roots import from.",
    ),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Maximum directory depth to scan. Default: 10. Only used with `scanDir`.'),
  maxRoots: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Maximum number of test roots allowed. Returns INVALID_INPUT if scan finds more. Default: 50. Only used with `scanDir`.',
    ),
  ignorePatterns: z
    .array(z.string())
    .optional()
    .describe(
      'Additional directory name patterns to skip during scan (e.g., ["vendor", "*.generated"]). Supports `*` wildcards. Only used with `scanDir`.',
    ),
  verbose: z.boolean().optional().describe('Emit per-test pass/fail details for each root.'),
  coverage: z
    .boolean()
    .optional()
    .describe(
      'Include per-line coverage data per root. Switches output to coverage-report mode: test record counts are not available, but `coverage`, `coveragePct`, and `overallCoveragePct` fields are populated.',
    ),
  runPattern: z
    .string()
    .optional()
    .describe(
      'Run only tests whose names match this regular expression (passed as `--run` to each root).',
    ),
  threshold: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Minimum coverage percentage required per root (0-100). Roots below threshold have `thresholdMet: false` in their result. Implicitly enables coverage-report output mode.',
    ),
  varValues: z
    .boolean()
    .optional()
    .describe(
      'Include local variable bindings in trace output (`--var-values`). Only useful with `verbose: true`.',
    ),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function matchesIgnorePattern(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === name) return true;
    if (p.includes('*')) {
      const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*');
      return new RegExp(`^${escaped}$`).test(name);
    }
    return false;
  });
}

async function walk(
  dir: string,
  depth: number,
  opts: WalkOpts,
  state: WalkState,
): Promise<boolean> {
  if (state.tooMany) return false;

  // Symlink escape guard: realpath the dir and confirm it stays under scanDirReal.
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    return false;
  }
  if (realDir !== opts.scanDirReal && !realDir.startsWith(opts.scanDirReal + sep)) {
    return false;
  }

  // Skip if this directory is or lives under a sharedPath (handled separately).
  for (const sp of opts.sharedPathsResolved) {
    if (dir === sp || dir.startsWith(sp + sep)) {
      return false;
    }
  }

  let entries: DirEntry[];
  try {
    // Cast: readdir with withFileTypes always returns name-addressable Dirent objects;
    // the as-unknown-as-DirEntry[] cast avoids the Dirent<Buffer> vs Dirent<string>
    // overload ambiguity present in newer @types/node versions.
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  const hasDirectTestFiles = entries.some((e) => e.isFile() && e.name.endsWith('_test.rego'));

  const subdirs = entries.filter((e) => {
    if (!e.isDirectory()) return false;
    if (e.name.startsWith('.')) return false;
    if (ALWAYS_IGNORE.has(e.name)) return false;
    if (matchesIgnorePattern(e.name, opts.ignorePatterns)) return false;
    return true;
  });

  let descendantsHaveTestFiles = false;

  if (depth < opts.maxDepth) {
    for (const subdir of subdirs) {
      if (state.tooMany) break;
      const subdirPath = join(dir, subdir.name);
      const subHas = await walk(subdirPath, depth + 1, opts, state);
      if (subHas) descendantsHaveTestFiles = true;
    }
  }

  if (hasDirectTestFiles) {
    if (!descendantsHaveTestFiles) {
      // Leaf rule: has test files directly; no eligible descendant has test files.
      if (state.roots.length >= opts.maxRoots) {
        state.tooMany = true;
        return true;
      }
      state.roots.push(dir);
    } else {
      // Ancestor: has test files alongside descendant test dirs. Running `opa test`
      // from here would double-execute descendant tests -- record as skipped.
      state.ancestorSkipped.push(dir);
    }
  }

  return hasDirectTestFiles || descendantsHaveTestFiles;
}

async function discoverLeafTestRoots(
  scanDir: string,
  opts: {
    maxDepth: number;
    maxRoots: number;
    ignorePatterns: string[];
    sharedPathsResolved: string[];
  },
): Promise<{ roots: string[]; tooMany: boolean; ancestorSkipped: string[] }> {
  let scanDirReal: string;
  try {
    scanDirReal = await fs.realpath(scanDir);
  } catch {
    scanDirReal = scanDir;
  }

  const state: WalkState = { roots: [], ancestorSkipped: [], tooMany: false };
  await walk(scanDir, 0, { ...opts, scanDirReal }, state);
  return { roots: state.roots, tooMany: state.tooMany, ancestorSkipped: state.ancestorSkipped };
}

function processRootOutput(
  result: SpawnResult,
  coverageMode: boolean,
  threshold: number | undefined,
): RootOutcome {
  if (coverageMode) {
    if (result.exitCode === 0) {
      const coverageData = tryParseJson<CoverageReport>(result.stdout);
      return {
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        results: [],
        coverage: coverageData,
        coveragePct: coverageData?.coverage,
        thresholdMet: threshold !== undefined ? true : undefined,
      };
    }

    const stderrTrimmed = result.stderr.trim();
    const thresholdMatch = /got\s+([\d.]+)\s+instead\s+of\s+([\d.]+)/i.exec(stderrTrimmed);
    if (thresholdMatch) {
      const actualCoverage = parseFloat(thresholdMatch[1]!);
      const requiredThreshold = parseFloat(thresholdMatch[2]!);
      return {
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        results: [],
        coveragePct: actualCoverage,
        thresholdMet: false,
        error: {
          code: 'COVERAGE_BELOW_THRESHOLD',
          message: stderrTrimmed,
          hint: `Increase test coverage to at least ${requiredThreshold}%. Currently at ${actualCoverage}%.`,
        },
      };
    }

    return {
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      results: [],
      error: {
        code: 'EVAL_ERROR',
        message: stderrTrimmed || 'One or more tests failed.',
        hint: 'Fix failing tests then re-run. Use verbose: true for trace output.',
      },
    };
  }

  // Normal mode -- parse test record array from stdout.
  let records: TestRecord[] = [];
  const arrayParsed = tryParseJson<TestRecord[]>(result.stdout);
  if (Array.isArray(arrayParsed)) {
    records = arrayParsed;
  } else {
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = tryParseJson<TestRecord>(trimmed);
      if (parsed) records.push(parsed);
    }
  }

  if (records.length === 0) {
    if (result.exitCode === 0) {
      return {
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        results: [],
        error: {
          code: 'NO_TESTS_FOUND',
          message: 'opa test did not discover any test rules in the provided paths.',
          hint: 'Tests live in *_test.rego files with rules named test_*.',
        },
      };
    }
    // Non-zero exit with no records: package conflict, import error, parse error, etc.
    return {
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      results: [],
      error: {
        code: 'EVAL_ERROR',
        message: result.stderr.trim() || `opa test exited with code ${result.exitCode}.`,
        hint: 'Check for package conflicts, import errors, or syntax errors in this root.',
      },
    };
  }

  const failed = records.filter((r) => r.fail).length;
  const skipped = records.filter((r) => r.skip).length;
  const passed = records.length - failed - skipped;
  return { passed, failed, skipped, total: records.length, results: records };
}

function computeOverallCoveragePct(roots: RootTestResult[]): number | undefined {
  const values = roots.filter((r) => r.coveragePct !== undefined).map((r) => r.coveragePct!);
  if (values.length === 0) return undefined;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.round(mean * 100) / 100;
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerRegoTestMultiroot(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_test_multiroot',
    {
      title: 'Run Rego tests across multiple roots',
      description:
        "Run `opa test` once per root and aggregate results. Solves the package-conflict problem that occurs when `opa test .` is run on a repo with multiple independent package namespaces (OPA issue #4724). Two modes: `explicit` (supply root list with optional per-root `include` paths for shared libraries) and `scan` (auto-discover leaf test roots using the leaf rule -- a directory is a root only if it directly contains `*_test.rego` files and none of its eligible subdirectories do, preventing OPA's automatic recursion from double-running tests). Use `sharedPaths` in scan mode to add shared library directories to every root's invocation without including them in discovery. Coverage and threshold work per-root; `overallCoveragePct` is the mean across roots that have coverage data.",
      inputSchema: RegoTestMultirootInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (
      {
        roots,
        scanDir,
        sharedPaths,
        maxDepth,
        maxRoots,
        ignorePatterns,
        verbose,
        coverage,
        runPattern,
        threshold,
        varValues,
      },
      { signal },
    ) => {
      return withToolEnvelope<MultiRootTestOutput>(config, async () => {
        // Exactly one of roots or scanDir is required.
        const hasRoots = roots !== undefined && roots.length > 0;
        const hasScanDir = scanDir !== undefined && scanDir.length > 0;

        if (!hasRoots && !hasScanDir) {
          return err('INVALID_INPUT', 'rego_test_multiroot requires either `roots` or `scanDir`.', {
            hint: 'Provide an explicit root list via `roots` or a top-level scan directory via `scanDir`.',
          });
        }
        if (hasRoots && hasScanDir) {
          return err(
            'INVALID_INPUT',
            'rego_test_multiroot accepts either `roots` or `scanDir`, not both.',
          );
        }

        const coverageMode = coverage === true || threshold !== undefined;
        const warnings: string[] = [];
        let resolvedRoots: ResolvedRoot[];
        let mode: 'explicit' | 'scan';
        let ancestorSkippedPaths: string[] | undefined;

        if (hasRoots) {
          // Explicit mode: validate each root path and its include paths.
          mode = 'explicit';
          resolvedRoots = [];
          for (const root of roots) {
            const pathValidation = validatePaths([root.path], config, { mustExist: true });
            if (!pathValidation.ok) return pathValidation.error;
            const resolvedPath = pathValidation.resolved[0]!;

            const resolvedIncludes: string[] = [];
            if (root.include?.length) {
              const includeValidation = validatePaths(root.include, config, { mustExist: true });
              if (!includeValidation.ok) return includeValidation.error;
              resolvedIncludes.push(...includeValidation.resolved);
            }

            resolvedRoots.push({ path: resolvedPath, name: root.name, include: resolvedIncludes });
          }
        } else {
          // Scan mode: validate scanDir and sharedPaths, then discover leaf roots.
          mode = 'scan';

          const scanDirValidation = validatePaths([scanDir!], config, { mustExist: true });
          if (!scanDirValidation.ok) return scanDirValidation.error;
          const resolvedScanDir = scanDirValidation.resolved[0]!;

          const resolvedSharedPaths: string[] = [];
          if (sharedPaths?.length) {
            const spValidation = validatePaths(sharedPaths, config, { mustExist: true });
            if (!spValidation.ok) return spValidation.error;
            resolvedSharedPaths.push(...spValidation.resolved);
          }

          const effectiveMaxRoots = maxRoots ?? 50;
          const discovery = await discoverLeafTestRoots(resolvedScanDir, {
            maxDepth: maxDepth ?? 10,
            maxRoots: effectiveMaxRoots,
            ignorePatterns: ignorePatterns ?? [],
            sharedPathsResolved: resolvedSharedPaths,
          });

          if (discovery.tooMany) {
            return err(
              'INVALID_INPUT',
              `Scan found more than ${effectiveMaxRoots} test roots in ${scanDir}. Narrow the scan with a more specific scanDir, sharedPaths, or ignorePatterns, or raise maxRoots.`,
              { hint: 'Use explicit roots mode to enumerate roots manually.' },
            );
          }

          if (discovery.roots.length === 0) {
            return err(
              'NO_TESTS_FOUND',
              `No test roots found under ${scanDir}. Ensure *_test.rego files exist.`,
              {
                hint: 'Tests live in *_test.rego files with rules named test_*. If shared libraries hold tests, list them explicitly with `roots`.',
              },
            );
          }

          if (discovery.ancestorSkipped.length > 0) {
            const count = discovery.ancestorSkipped.length;
            warnings.push(
              `${count} director${count === 1 ? 'y has' : 'ies have'} test files alongside subdirectories that also have test files and were skipped to avoid double-running: ${discovery.ancestorSkipped.join(', ')}. Use explicit roots mode with per-root include paths to run these.`,
            );
            ancestorSkippedPaths = discovery.ancestorSkipped;
          }

          resolvedRoots = discovery.roots.map((r) => ({
            path: r,
            include: resolvedSharedPaths,
          }));
        }

        // Sequential per-root execution.
        const rootResults: RootTestResult[] = [];
        let abortedAt: number | undefined;

        for (let i = 0; i < resolvedRoots.length; i++) {
          if (signal?.aborted) {
            abortedAt = i;
            break;
          }

          const root = resolvedRoots[i]!;
          const paths = [root.path, ...root.include];

          const result = await opa.test(
            { paths, verbose, coverage: coverageMode, runPattern, varValues, threshold },
            signal,
          );

          // Client cancellation: break loop and return partial results with a warning.
          if (result.aborted) {
            abortedAt = i;
            break;
          }
          // Systemic failures (binary missing, timeout) abort the entire run.
          if (result.exitCode === null) {
            return err(
              'OPA_BINARY_NOT_FOUND',
              `opa binary unreachable: ${result.stderr || 'spawn failed'}`,
              {
                hint: 'Install OPA (https://www.openpolicyagent.org/docs/latest/) or set OPA_BINARY to the absolute path of the binary.',
              },
            );
          }
          if (result.timedOut) {
            return err(
              'TIMEOUT',
              'opa subprocess exceeded the configured timeout (OPA_MCP_TIMEOUT_MS).',
              { details: { durationMs: result.durationMs } },
            );
          }

          const outcome = processRootOutput(result, coverageMode, threshold);
          const rootResult: RootTestResult = {
            path: root.path,
            ...outcome,
          };
          if (root.name !== undefined) rootResult.name = root.name;
          if (root.include.length > 0) rootResult.include = root.include;
          rootResults.push(rootResult);
        }

        if (abortedAt !== undefined) {
          warnings.push(
            `Run was cancelled after ${rootResults.length} of ${resolvedRoots.length} root${resolvedRoots.length === 1 ? '' : 's'}.`,
          );
        }

        // Aggregate totals across all roots.
        const totalPassed = rootResults.reduce((s, r) => s + (r.error ? 0 : r.passed), 0);
        const totalFailed = rootResults.reduce((s, r) => s + (r.error ? 0 : r.failed), 0);
        const totalSkipped = rootResults.reduce((s, r) => s + (r.error ? 0 : r.skipped), 0);
        const totalTests = rootResults.reduce((s, r) => s + (r.error ? 0 : r.total), 0);
        const rootsWithErrors = rootResults.filter((r) => r.error !== undefined).length;
        const rootsWithFailures = rootResults.filter(
          (r) => r.error === undefined && r.failed > 0,
        ).length;

        const output: MultiRootTestOutput = {
          mode,
          roots: rootResults,
          totalPassed,
          totalFailed,
          totalSkipped,
          totalTests,
          rootsRun: rootResults.length,
          rootsWithErrors,
          rootsWithFailures,
        };

        if (coverageMode) {
          const overallCoveragePct = computeOverallCoveragePct(rootResults);
          if (overallCoveragePct !== undefined) {
            output.overallCoveragePct = overallCoveragePct;
          }
        }

        if (ancestorSkippedPaths !== undefined && ancestorSkippedPaths.length > 0) {
          output.ancestorSkipped = ancestorSkippedPaths;
        }

        return ok<MultiRootTestOutput>(output, warnings.length > 0 ? warnings : undefined);
      });
    },
  );
}
