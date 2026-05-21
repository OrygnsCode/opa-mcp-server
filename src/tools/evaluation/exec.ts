/**
 * `opa_exec` -- batch-evaluate a policy decision against multiple input
 * files using `opa exec`.
 *
 * Unlike `rego_eval` (single input document), `opa exec` evaluates the
 * same decision for every file in a directory or explicit list. This is
 * the standard CI pattern for teams that gate deployments by checking
 * each config file independently: pass the configs directory, get back
 * a per-file allow/deny without writing a shell loop.
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

const OpaExecInput = {
  inputPaths: z
    .array(z.string())
    .min(1)
    .describe(
      'One or more JSON/YAML input file paths, or a directory containing input files. OPA evaluates each file independently. Every path must be inside an allowed root.',
    ),
  decision: z
    .string()
    .min(1)
    .describe(
      'The policy entrypoint to evaluate for each input, e.g. `"data.authz.allow"` or `"data.policy.violations"`. Must be a fully-qualified Rego reference.',
    ),
  bundle: z
    .string()
    .optional()
    .describe(
      'Path to an OPA bundle directory or `.tar.gz` archive to load as the policy source. Mutually exclusive with `dataPaths`.',
    ),
  dataPaths: z
    .array(z.string())
    .optional()
    .describe(
      'Policy and/or data file or directory paths to load. Mutually exclusive with `bundle`.',
    ),
};

interface ExecResultEntry {
  path: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

interface OpaExecJsonOutput {
  result?: ExecResultEntry[];
}

export interface OpaExecOutput {
  /** Per-file evaluation results. */
  results: ExecResultEntry[];
  /** Total number of input files processed. */
  count: number;
  /** Number of files that produced a result without error. */
  successCount: number;
  /** Number of files that produced an evaluation error. */
  errorCount: number;
}

export function registerOpaExec(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'opa_exec',
    {
      title: 'Batch-evaluate OPA policy against input files',
      description:
        'Evaluate a policy decision against one or more input files using `opa exec --format=json`. Unlike `rego_eval` (single input), `opa exec` processes every file independently and returns a per-file result -- ideal for CI pipelines that check many config files against a policy in one call. Supply `bundle` for bundle-based policies or `dataPaths` for raw policy files; these are mutually exclusive. Each file that fails evaluation appears in `results` with an `error` field rather than a `result` field.',
      inputSchema: OpaExecInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ inputPaths, decision, bundle, dataPaths }) => {
      return withToolEnvelope<OpaExecOutput>(config, async () => {
        if (bundle && dataPaths?.length) {
          return err(
            'INVALID_INPUT',
            'opa_exec accepts either `bundle` or `dataPaths`, not both. Choose one policy source.',
          );
        }

        // Validate input file paths.
        const inputValidation = validatePaths(inputPaths, config, { mustExist: true });
        if (!inputValidation.ok) return inputValidation.error;

        // Validate bundle path.
        let resolvedBundle: string | undefined;
        if (bundle) {
          const v = validatePaths([bundle], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedBundle = v.resolved[0];
        }

        // Validate data paths.
        let resolvedDataPaths: string[] | undefined;
        if (dataPaths?.length) {
          const v = validatePaths(dataPaths, config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedDataPaths = v.resolved;
        }

        const result = await opa.exec({
          inputPaths: inputValidation.resolved,
          decision,
          bundle: resolvedBundle,
          dataPaths: resolvedDataPaths,
        });

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err('EVAL_ERROR', 'opa exec exited with a non-zero status.', {
            details: {
              stderr: result.stderr.trim(),
              stdout: result.stdout.trim(),
            },
          });
        }

        const parsed = tryParseJson<OpaExecJsonOutput>(result.stdout);
        if (!parsed) {
          return err('UNKNOWN_ERROR', 'opa exec produced no parseable JSON output.', {
            details: { stdout: result.stdout.trim() },
          });
        }

        const results: ExecResultEntry[] = parsed.result ?? [];
        const successCount = results.filter((r) => r.error === undefined).length;
        const errorCount = results.filter((r) => r.error !== undefined).length;

        return ok<OpaExecOutput>({
          results,
          count: results.length,
          successCount,
          errorCount,
        });
      });
    },
  );
}
