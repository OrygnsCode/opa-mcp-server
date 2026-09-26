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
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import {
  MAX_BATCH_INPUTS,
  runEval,
  runEvalBatch,
  SharedEvalInput,
  type RegoEvalBatchOutput,
  type RegoEvalOutput,
} from './_shared.js';

const RegoEvalInput = {
  ...SharedEvalInput,
  inputs: z
    .array(z.unknown())
    .min(1)
    .max(MAX_BATCH_INPUTS)
    .optional()
    .describe(
      `Several input documents to evaluate the same query against, up to ${MAX_BATCH_INPUTS}, in place of \`input\`/\`inputPath\`. The result is \`batch\`: one entry per input, in order, each holding that input's \`result\` (empty when the query was undefined for it) or an \`error\`. One failing input does not stop the others.`,
    ),
};

export function registerRegoEval(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_eval',
    {
      title: 'Evaluate Rego query',
      description:
        'Evaluate a Rego query against a policy and an input document using `opa eval`. Returns the standard `{result: [...]}` shape. The bread-and-butter authoring tool. The policy is optional, so a query alone tries out a built-in or an expression. Pass `inputs` to evaluate one query against many input documents in one call, and `v0Compatible` for a policy still written in pre-1.0 Rego.',
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
        "Evaluate with `--explain=full` and return a structured trace alongside the result. Use this when an agent needs to see why a rule fired (or didn't) -- the trace is the basis for `rego_explain_decision`.",
      inputSchema: SharedEvalInput,
      annotations: {
        readOnlyHint: false,
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
      },
    },
    async (args, { signal }) => {
      return withToolEnvelope<RegoEvalOutput>(config, () =>
        runEval(opa, config, args, { explain: 'full' }, signal),
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
