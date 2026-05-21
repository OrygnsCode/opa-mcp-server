/**
 * `rego_test` -- run Rego unit tests via `opa test`.
 *
 * Returns per-test pass/fail records. With `coverage: true`, returns
 * per-line coverage data alongside the test results.
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
  coverage: z.boolean().optional().describe('Include per-line coverage data in the output.'),
  runPattern: z.string().optional().describe('Run only tests whose names match this regex.'),
};

interface TestRecord {
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

export interface RegoTestOutput {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  results: TestRecord[];
  coverage?: unknown;
}

export function registerRegoTest(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_test',
    {
      title: 'Run Rego tests',
      description:
        'Run Rego unit tests with `opa test`. Returns aggregate pass/fail counts plus per-test records. Tests live in `*_test.rego` files; rule names beginning with `test_` are picked up.',
      inputSchema: RegoTestInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ paths, verbose, coverage, runPattern }, { signal }) => {
      return withToolEnvelope<RegoTestOutput>(config, async () => {
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        const result = await opa.test(
          {
            paths: validation.resolved,
            verbose,
            coverage,
            runPattern,
          },
          signal,
        );
        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        // `opa test --format=json` emits a JSON array (or sometimes
        // newline-delimited objects depending on OPA version). Try the
        // array form first; fall back to NDJSON.
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

        if (records.length === 0 && result.exitCode === 0) {
          return err(
            'NO_TESTS_FOUND',
            'opa test did not discover any test rules in the provided paths.',
            { hint: 'Tests live in *_test.rego files with rules named test_*.' },
          );
        }

        const passed = records.filter((r) => r.pass).length;
        const failed = records.filter((r) => r.fail).length;
        const skipped = records.filter((r) => r.skip).length;

        return ok<RegoTestOutput>({
          passed,
          failed,
          skipped,
          total: records.length,
          results: records,
        });
      });
    },
  );
}
