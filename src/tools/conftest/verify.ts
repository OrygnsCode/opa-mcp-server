/**
 * `conftest_verify` -- run the `_test.rego` unit tests that live inside
 * a conftest policy directory.
 *
 * Conftest verify is conftest's equivalent of `opa test`: it evaluates
 * rules whose names begin with `test_` inside `*_test.rego` files within
 * the policy directory. Use this to confirm that the policies themselves
 * are correct before deploying them.
 *
 * Exit code mapping (same as conftest_test):
 *   null  -- binary not found → CONFTEST_NOT_FOUND
 *   0     -- all tests pass
 *   1     -- one or more test failures
 *   2+    -- command error
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import {
  ConftestCli,
  parseConftestResults,
  type ConftestFileResult,
} from '../../lib/conftest-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const ConftestVerifyInput = {
  policy: z
    .string()
    .optional()
    .describe(
      'Path to the directory containing both the Rego policies and the `*_test.rego` test files. ' +
        'Must be inside an allowed root (OPA_MCP_ALLOWED_PATHS). ' +
        "Omit to use conftest's default `./policy` directory.",
    ),
  namespace: z
    .string()
    .optional()
    .describe('Namespace to verify. Defaults to `main`. Omit to verify all namespaces.'),
  data: z
    .array(z.string())
    .optional()
    .describe(
      'Paths to data directories. Each must be inside an allowed root (OPA_MCP_ALLOWED_PATHS).',
    ),
};

export interface ConftestVerifyOutput {
  /** `true` when every `test_*` rule passed. */
  passed: boolean;
  /**
   * One entry per test outcome as conftest reports them: a test file
   * produces one entry per passing rule (`successes: 1`) and one per
   * failing rule (`failures: [{msg}]`), with `namespace` empty.
   */
  results: ConftestFileResult[];
  summary: {
    /** Distinct test files with no failing rule. */
    passed: number;
    /** Distinct test files with at least one failing rule. */
    failed: number;
    /** Test rules that passed, across all files. */
    totalPassed: number;
    /** Test rules that failed, across all files. */
    totalFailed: number;
  };
}

export function registerConftestVerify(server: McpServer, config: Config): void {
  const conftest = new ConftestCli(config);

  server.registerTool(
    'conftest_verify',
    {
      title: 'Conftest verify',
      description:
        'Run the `test_*` rules inside `*_test.rego` files within a conftest policy directory, ' +
        'verifying that the policies themselves are correct. Equivalent to `opa test` but using ' +
        "conftest's policy-loading machinery. Returns per-file pass/fail results, and " +
        'NO_TESTS_FOUND when the directory holds no test rules. ' +
        'Requires `conftest` on PATH or `CONFTEST_BINARY` set; returns CONFTEST_NOT_FOUND otherwise.',
      inputSchema: ConftestVerifyInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, { signal }) => {
      return withToolEnvelope<ConftestVerifyOutput>(config, async () => {
        // ── Path validation ──────────────────────────────────────────────
        if (input.policy !== undefined) {
          const v = validatePaths([input.policy], config, { mustExist: true });
          if (!v.ok) return v.error;
          input = { ...input, policy: v.resolved[0] };
        }

        if (input.data?.length) {
          const v = validatePaths(input.data, config, { mustExist: true });
          if (!v.ok) return v.error;
          input = { ...input, data: v.resolved };
        }

        // ── Run conftest verify ──────────────────────────────────────────
        const result = await conftest.verify(
          {
            policy: input.policy,
            namespace: input.namespace,
            data: input.data,
          },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'conftest');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode === 0 || result.exitCode === 1) {
          const results = parseConftestResults(result.stdout);
          if (results === null) {
            return err('UNKNOWN_ERROR', 'conftest verify produced no parseable JSON output.', {
              details: { stderr: result.stderr.trim(), exitCode: result.exitCode },
            });
          }

          // conftest prints `null` and exits 0 when it finds no test rules.
          // A clean pass over nothing is not a pass.
          if (results.length === 0) {
            return err(
              'NO_TESTS_FOUND',
              'conftest verify found no test rules in the policy directory.',
              {
                hint: 'Tests live in *_test.rego files inside the policy directory, with rules named test_*.',
              },
            );
          }

          return ok<ConftestVerifyOutput>({
            passed: result.exitCode === 0,
            results,
            summary: buildVerifySummary(results),
          });
        }

        const detail = result.stderr.trim() || result.stdout.trim();
        return err(
          'UNKNOWN_ERROR',
          `conftest verify failed with exit code ${result.exitCode}: ${detail}`,
          { details: { exitCode: result.exitCode, stderr: result.stderr.trim() } },
        );
      });
    },
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildVerifySummary(results: ConftestFileResult[]): ConftestVerifyOutput['summary'] {
  // conftest verify reports one entry per test rule, all carrying the test
  // file's name, so a file with one pass and one failure arrives as two
  // entries. Files are counted by name, rules by entry.
  const allFiles = new Set<string>();
  const failedFiles = new Set<string>();
  let totalPassed = 0;
  let totalFailed = 0;

  for (const r of results) {
    allFiles.add(r.filename);
    if (r.failures.length > 0) failedFiles.add(r.filename);
    totalPassed += r.successes;
    totalFailed += r.failures.length;
  }

  return {
    passed: allFiles.size - failedFiles.size,
    failed: failedFiles.size,
    totalPassed,
    totalFailed,
  };
}
