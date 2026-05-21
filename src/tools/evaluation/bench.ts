/**
 * `rego_bench` -- benchmark a query via `opa bench`.
 *
 * Returns iteration count plus statistical timing data (ns/op,
 * allocations, etc.).
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

const RegoBenchInput = {
  query: z.string().min(1).describe('Rego query to benchmark.'),
  paths: z
    .array(z.string())
    .optional()
    .describe('Policy / data paths to load. Each must be in an allowed root.'),
  input: z.unknown().optional().describe('Inline input document.'),
  inputPath: z.string().optional().describe('Path to a JSON input file.'),
  count: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Number of benchmark iterations. Defaults to OPA's built-in default."),
};

export interface RegoBenchOutput {
  iterations?: number;
  metrics?: Record<string, unknown>;
  raw?: unknown;
}

export function registerRegoBench(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_bench',
    {
      title: 'Benchmark Rego query',
      description:
        'Benchmark a Rego query against a policy + input with `opa bench`. Returns statistical timing data: iterations, ns/op, and allocation counts. Use this to spot slow rules.',
      inputSchema: RegoBenchInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, paths, input, inputPath, count }, { signal }) => {
      return withToolEnvelope<RegoBenchOutput>(config, async () => {
        if (input !== undefined && inputPath) {
          return err(
            'INVALID_INPUT',
            'rego_bench accepts either `input` or `inputPath`, not both.',
          );
        }
        let resolvedPaths: string[] | undefined;
        if (paths?.length) {
          const validation = validatePaths(paths, config, { mustExist: true });
          if (!validation.ok) return validation.error;
          resolvedPaths = validation.resolved;
        }
        let resolvedInputPath: string | undefined;
        if (inputPath) {
          const validation = validatePaths([inputPath], config, { mustExist: true });
          if (!validation.ok) return validation.error;
          resolvedInputPath = validation.resolved[0];
        }

        const result = await opa.bench(
          {
            query,
            paths: resolvedPaths,
            input,
            inputPath: resolvedInputPath,
            count,
          },
          signal,
        );
        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err('EVAL_ERROR', 'opa bench exited with an error.', {
            details: { stderr: result.stderr.trim() },
          });
        }

        const parsed = tryParseJson<RegoBenchOutput>(result.stdout);
        if (parsed === undefined) {
          return err('UNKNOWN_ERROR', 'opa bench produced no parseable JSON output.', {
            details: { stdout: result.stdout.trim() },
          });
        }
        return ok<RegoBenchOutput>(parsed);
      });
    },
  );
}
