/**
 * `rego_eval` and the three flag-extended variants.
 *
 * Each variant is a thin adapter -- same input shape, different OPA
 * flags -- built on the shared `runEval` helper.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { runEval, SharedEvalInput, type RegoEvalOutput } from './_shared.js';

export function registerRegoEval(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_eval',
    {
      title: 'Evaluate Rego query',
      description:
        'Evaluate a Rego query against a policy and an input document using `opa eval`. Returns the standard `{result: [...]}` shape. The bread-and-butter authoring tool.',
      inputSchema: SharedEvalInput,
    },
    async (args) => {
      return withToolEnvelope<RegoEvalOutput>(config, () => runEval(opa, config, args, {}));
    },
  );

  server.registerTool(
    'rego_eval_with_explain',
    {
      title: 'Evaluate Rego with execution trace',
      description:
        "Evaluate with `--explain=full` and return a structured trace alongside the result. Use this when an agent needs to see why a rule fired (or didn't) -- the trace is the basis for `rego_explain_decision`.",
      inputSchema: SharedEvalInput,
    },
    async (args) => {
      return withToolEnvelope<RegoEvalOutput>(config, () =>
        runEval(opa, config, args, { explain: 'full' }),
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
    },
    async (args) => {
      return withToolEnvelope<RegoEvalOutput>(config, () =>
        runEval(opa, config, args, { profile: true, metrics: true }),
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
    },
    async (args) => {
      return withToolEnvelope<RegoEvalOutput>(config, () =>
        runEval(opa, config, args, { coverage: true }),
      );
    },
  );
}
