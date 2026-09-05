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
      'The policy entrypoint to evaluate for each input, e.g. `"authz/allow"`. `opa exec` names a decision by slash-separated path with no `data.` prefix; the Rego reference forms (`data.authz.allow`, `authz.allow`) are accepted here and converted, because passing one straight through leaves every file undefined.',
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
      'Policy and/or data file or directory paths, each loaded as an OPA bundle root (opa exec loads policy only via bundles). Mutually exclusive with `bundle`.',
    ),
  fail: z
    .boolean()
    .optional()
    .describe(
      'CI gate: report `failed: true` when any decision is undefined or errors. Mutually exclusive with `failDefined` and `failNonEmpty`.',
    ),
  failDefined: z
    .boolean()
    .optional()
    .describe(
      'CI gate: report `failed: true` when any decision is defined or errors. Use when a defined result means a violation. Mutually exclusive with `fail` and `failNonEmpty`.',
    ),
  failNonEmpty: z
    .boolean()
    .optional()
    .describe(
      'CI gate: report `failed: true` when any decision result is non-empty or errors. Mutually exclusive with `fail` and `failDefined`.',
    ),
  timeout: z
    .string()
    .optional()
    .describe(
      'Per-exec evaluation timeout as a Go duration, e.g. `"30s"` or `"5m"`. Still bounded by the server subprocess timeout (OPA_MCP_TIMEOUT_MS).',
    ),
  v1Compatible: z
    .boolean()
    .optional()
    .describe('Opt in to OPA v1.0-compatible behaviors (`--v1-compatible`).'),
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
  /**
   * True when a `--fail*` gate fired (opa exec exited non-zero). Always
   * false when no gate flag is set.
   */
  failed: boolean;
  /**
   * Present only when every input left the decision undefined. That happens
   * both when no rule matched and when the decision names nothing at all, and
   * the two are indistinguishable in the per-file results.
   */
  hint?: string;
}

/**
 * Convert a decision reference to the path `opa exec --decision` expects.
 *
 * `opa exec` names a decision by slash-separated path with no `data.` prefix.
 * Every other spelling, including the `data.authz.allow` this tool used to
 * document, is accepted by the flag and then resolves to nothing, so each input
 * file comes back with `opa_undefined_error` and the call looks like a policy
 * result rather than a mistake. Returns undefined when nothing is left to name.
 */
export function toDecisionPath(decision: string): string | undefined {
  const trimmed = decision.trim().replace(/^[/]+/, '').replace(/[/]+$/, '');
  // Drop a leading `data.` or `data/` root, but not a package named `database`.
  const withoutRoot = trimmed.replace(/^data(?=$|[./])[./]?/, '');
  if (withoutRoot.length === 0) return undefined;
  const segments = withoutRoot.includes('/') ? withoutRoot.split('/') : withoutRoot.split('.');
  if (segments.some((seg) => seg.length === 0)) return undefined;
  return segments.join('/');
}

export function registerOpaExec(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'opa_exec',
    {
      title: 'Batch-evaluate OPA policy against input files',
      description:
        'Evaluate a policy decision against one or more input files using `opa exec --format=json`. Unlike `rego_eval` (single input), `opa exec` processes every file independently and returns a per-file result -- ideal for CI pipelines that check many config files against a policy in one call. Supply `bundle` for bundle-based policies or `dataPaths` for raw policy files; these are mutually exclusive. Each file that fails evaluation appears in `results` with an `error` field rather than a `result` field. Set one of `fail`/`failDefined`/`failNonEmpty` to turn the call into a CI gate: the result then reports `failed: true` (instead of erroring) when the gate condition is met.',
      inputSchema: OpaExecInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
      },
    },
    async (
      {
        inputPaths,
        decision,
        bundle,
        dataPaths,
        fail,
        failDefined,
        failNonEmpty,
        timeout,
        v1Compatible,
      },
      { signal },
    ) => {
      return withToolEnvelope<OpaExecOutput>(config, async () => {
        if (bundle && dataPaths?.length) {
          return err(
            'INVALID_INPUT',
            'opa_exec accepts either `bundle` or `dataPaths`, not both. Choose one policy source.',
          );
        }

        if ([fail, failDefined, failNonEmpty].filter(Boolean).length > 1) {
          return err(
            'INVALID_INPUT',
            'opa_exec accepts at most one of `fail`, `failDefined`, or `failNonEmpty`.',
          );
        }

        const decisionPath = toDecisionPath(decision);
        if (decisionPath === undefined) {
          return err(
            'INVALID_INPUT',
            '`decision` must name a rule, for example "authz/allow" or "data.authz.allow".',
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

        const result = await opa.exec(
          {
            inputPaths: inputValidation.resolved,
            decision: decisionPath,
            bundle: resolvedBundle,
            dataPaths: resolvedDataPaths,
            fail,
            failDefined,
            failNonEmpty,
            timeout,
            v1Compatible,
          },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        const gateFlagSet = fail === true || failDefined === true || failNonEmpty === true;

        // Without a gate flag, opa exec exits non-zero only on an operational
        // failure (unloadable bundle, unreadable input). With a gate flag set,
        // a non-zero exit is the gate firing on purpose: opa still prints the
        // per-file JSON to stdout, so parse it and report `failed: true`.
        if (result.exitCode !== 0 && !gateFlagSet) {
          return err('EVAL_ERROR', 'opa exec exited with a non-zero status.', {
            details: {
              stderr: result.stderr.trim(),
              stdout: result.stdout.trim(),
            },
          });
        }

        const parsed = tryParseJson<OpaExecJsonOutput>(result.stdout);
        if (!parsed) {
          // A gate flag that exits non-zero with no JSON is a real failure
          // (e.g. the policy did not compile), not a decision outcome.
          if (result.exitCode !== 0) {
            return err('EVAL_ERROR', 'opa exec exited with a non-zero status.', {
              details: {
                stderr: result.stderr.trim(),
                stdout: result.stdout.trim(),
              },
            });
          }
          return err('UNKNOWN_ERROR', 'opa exec produced no parseable JSON output.', {
            details: { stdout: result.stdout.trim() },
          });
        }

        const results: ExecResultEntry[] = parsed.result ?? [];
        const successCount = results.filter((r) => r.error === undefined).length;
        const errorCount = results.filter((r) => r.error !== undefined).length;

        // A decision naming nothing is reported per file as an undefined
        // decision, indistinguishable from every input legitimately matching no
        // rule. Both read as a pass under a `deny`-style policy, so say so.
        const allUndefined =
          results.length > 0 && results.every((r) => r.error?.code === 'opa_undefined_error');

        return ok<OpaExecOutput>({
          results,
          count: results.length,
          successCount,
          errorCount,
          failed: result.exitCode !== 0,
          ...(allUndefined
            ? {
                hint: `Every input left \`${decisionPath}\` undefined. That is the expected outcome when no rule matched any of them, and it is also what a decision naming nothing in the loaded policy looks like. Confirm the rule exists at that path before reading this as a pass.`,
              }
            : {}),
        });
      });
    },
  );
}
