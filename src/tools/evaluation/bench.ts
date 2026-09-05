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
import { parseJsonValues } from '../../lib/json-stream.js';
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
    .describe(
      "Number of times to repeat the benchmark (`--count N`). Defaults to OPA's built-in default of one. Every repetition is returned in `runs`; the top-level figures come from the fastest of them.",
    ),
};

export interface RegoBenchOutput {
  iterations?: number;
  metrics?: Record<string, unknown>;
  raw?: unknown;
  /**
   * Every repetition, in the order OPA ran them, present only when `count` was
   * above 1. The fields above come from the fastest of them by nanoseconds per
   * iteration, which is the run least disturbed by whatever else the machine
   * was doing.
   */
  runs?: BenchRun[];
  /** How many repetitions ran, present only when more than one did. */
  repetitions?: number;
}

/** One repetition as OPA reports it: N iterations in T nanoseconds. */
interface BenchRun {
  N?: number;
  T?: number;
  [key: string]: unknown;
}

/** Nanoseconds per iteration, or Infinity when the run says nothing useful. */
function nsPerOp(run: BenchRun): number {
  const n = typeof run.N === 'number' ? run.N : 0;
  const t = typeof run.T === 'number' ? run.T : 0;
  return n > 0 ? t / n : Number.POSITIVE_INFINITY;
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
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
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
          // `opa bench --format=json` writes its diagnostics to stdout as an
          // `errors` array and leaves stderr empty, so reporting stderr alone
          // handed back an error with nothing in it.
          const diagnostics = tryParseJson<{ errors?: unknown }>(result.stdout);
          return err('EVAL_ERROR', 'opa bench exited with an error.', {
            details: {
              ...(diagnostics?.errors !== undefined
                ? { errors: diagnostics.errors }
                : { stdout: result.stdout.trim() }),
              stderr: result.stderr.trim(),
            },
          });
        }

        // With `--count N` OPA prints one JSON document per repetition, back to
        // back, which `JSON.parse` rejects outright.
        const runs = parseJsonValues<BenchRun>(result.stdout).filter(
          (v): v is BenchRun => typeof v === 'object' && v !== null && !Array.isArray(v),
        );
        if (runs.length === 0) {
          return err('UNKNOWN_ERROR', 'opa bench produced no parseable JSON output.', {
            details: { stdout: result.stdout.trim() },
          });
        }

        if (runs.length === 1) return ok<RegoBenchOutput>(runs[0]! as RegoBenchOutput);

        const fastest = runs.reduce((best, run) => (nsPerOp(run) < nsPerOp(best) ? run : best));
        return ok<RegoBenchOutput>({
          ...(fastest as RegoBenchOutput),
          runs,
          repetitions: runs.length,
        });
      });
    },
  );
}
