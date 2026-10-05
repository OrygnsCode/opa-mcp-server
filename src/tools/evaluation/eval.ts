/**
 * `rego_eval` and the three flag-extended variants.
 *
 * Each variant is a thin adapter -- same input shape, different OPA
 * flags -- built on the shared `runEval` helper.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { fitPrefix } from '../../lib/output.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import {
  MAX_BATCH_INPUTS,
  runEval,
  runEvalBatch,
  SharedEvalInput,
  type RegoEvalBatchOutput,
  type RegoEvalOutput,
} from './_shared.js';

interface ExplanationCut {
  shown: number;
  total: number;
  /** Whether the events' `Locals` and `LocalMetadata` were removed. */
  localsDropped: boolean;
}

type ExplainOutput = RegoEvalOutput & { explanationTruncated?: ExplanationCut };

/**
 * Fit an oversized raw trace under the response cap while keeping the result:
 * drop the bound-variable payloads every event repeats, then trailing events.
 */
function shrinkExplanation(
  data: ExplainOutput,
  fits: (candidate: ExplainOutput) => boolean,
): ExplainOutput | undefined {
  const events = (data.explanation ?? []) as Array<Record<string, unknown>>;
  const lean = events.map(({ Locals: _l, LocalMetadata: _m, ...rest }) => rest);
  return fitPrefix(
    lean,
    (kept) => ({
      ...data,
      explanation: kept,
      explanationTruncated: { shown: kept.length, total: events.length, localsDropped: true },
    }),
    fits,
  );
}

const RegoEvalInput = {
  ...SharedEvalInput,
  inputs: z
    .array(z.unknown())
    .min(1)
    .max(MAX_BATCH_INPUTS)
    .optional()
    .describe(
      `Several input documents to evaluate the same query against, up to ${MAX_BATCH_INPUTS}, in place of \`input\`/\`inputPath\`. The result is \`batch\`: one entry per input, in order, each holding that input's \`result\` (empty when the query was undefined for it) or an \`error\`. An input that fails at runtime does not stop the others. A policy that does not compile fails the call, and after an input times out the inputs not yet started come back as \`NOT_EVALUATED\`.`,
    ),
};

export function registerRegoEval(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_eval',
    {
      title: 'Evaluate Rego query',
      description:
        'Evaluate a Rego query against a policy and an input document using `opa eval`. Returns the standard `{result: [...]}` shape plus `defined`, which is false when the query produced no value (undefined is not `false`), and `printed`, the lines the policy wrote with `print()`. The bread-and-butter authoring tool. The policy is optional, so a query alone tries out a built-in or an expression. Pass `inputs` to evaluate one query against many input documents in one call, and `v0Compatible` for a policy still written in pre-1.0 Rego.',
      inputSchema: RegoEvalInput,
      annotations: {
        readOnlyHint: false,
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
      },
    },
    async ({ inputs, ...args }, { signal }) => {
      if (inputs !== undefined) {
        return withToolEnvelope<RegoEvalBatchOutput>(config, () =>
          runEvalBatch(opa, config, args, inputs, signal),
        );
      }
      return withToolEnvelope<RegoEvalOutput>(config, () => runEval(opa, config, args, {}, signal));
    },
  );

  server.registerTool(
    'rego_eval_with_explain',
    {
      title: 'Evaluate Rego with execution trace',
      description:
        "Evaluate with `--explain=full` and return OPA's raw trace events (with their AST nodes) alongside the result. For a readable trace use `rego_explain_decision`, which renders the same events as lines. Raw events are large: over the response cap the bound-variable values are dropped first, then trailing events (`explanationTruncated`), and the result is kept.",
      inputSchema: SharedEvalInput,
      annotations: {
        readOnlyHint: false,
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
      },
    },
    async (args, { signal }) => {
      return withToolEnvelope<ExplainOutput>(
        config,
        () => runEval(opa, config, args, { explain: 'full' }, signal),
        { shrink: shrinkExplanation },
      );
    },
  );

  server.registerTool(
    'rego_eval_with_profile',
    {
      title: 'Evaluate Rego with profiling',
      description:
        'Evaluate with `--profile` and return per-rule timing and evaluation counts. Use this to find hot rules in slow policies.',
      inputSchema: SharedEvalInput,
      annotations: {
        readOnlyHint: false,
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
      },
    },
    async (args, { signal }) => {
      return withToolEnvelope<RegoEvalOutput>(config, () =>
        runEval(opa, config, args, { profile: true, metrics: true }, signal),
      );
    },
  );

  server.registerTool(
    'rego_eval_with_coverage',
    {
      title: 'Evaluate Rego with coverage',
      description:
        "Evaluate with `--coverage` and return per-line coverage data. Useful for verifying that tests actually exercise the rules they're meant to.",
      inputSchema: SharedEvalInput,
      annotations: {
        readOnlyHint: false,
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
      },
    },
    async (args, { signal }) => {
      return withToolEnvelope<RegoEvalOutput>(config, () =>
        runEval(opa, config, args, { coverage: true }, signal),
      );
    },
  );
}
