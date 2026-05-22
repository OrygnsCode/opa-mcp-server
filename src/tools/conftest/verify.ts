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
import { ConftestCli, type ConftestFileResult } from '../../lib/conftest-cli.js';
import { err, ok } from '../../lib/errors.js';
import {
  mapSubprocessFailure,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';

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
  /** `true` when all `test_*` rules in all test files pass. */
  passed: boolean;
  /** Per-test-file results. */
  results: ConftestFileResult[];
  summary: {
    /** Number of test files with zero failures. */
    passed: number;
    /** Number of test files with at least one failure. */
    failed: number;
    /** Total test cases that passed (sum of `successes` across all files). */
    totalPassed: number;
    /** Total test cases that failed (sum of `failures` across all files). */
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
        "conftest's policy-loading machinery. Returns per-file pass/fail results. " +
        'Requires `conftest` on PATH or `CONFTEST_BINARY` set; returns CONFTEST_NOT_FOUND otherwise.',
      inputSchema: ConftestVerifyInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
          const parsed = tryParseJson<ConftestFileResult[]>(result.stdout);
          if (!parsed || !Array.isArray(parsed)) {
            return err('UNKNOWN_ERROR', 'conftest verify produced no parseable JSON output.', {
              details: { stderr: result.stderr.trim(), exitCode: result.exitCode },
            });
          }

          const summary = buildVerifySummary(parsed);
          return ok<ConftestVerifyOutput>({
            passed: result.exitCode === 0,
            results: parsed,
            summary,
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
  let passed = 0;
  let failed = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  for (const r of results) {
    if (r.failures.length > 0) {
      failed++;
    } else {
      passed++;
    }
    totalPassed += r.successes;
    totalFailed += r.failures.length;
  }

  return { passed, failed, totalPassed, totalFailed };
}
