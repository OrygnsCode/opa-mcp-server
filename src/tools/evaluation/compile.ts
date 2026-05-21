/**
 * `rego_compile_query` -- partially evaluate a query.
 *
 * Wraps `opa eval --partial` with a defaulted `unknowns` set. The
 * result is a residual query -- what remains after substituting in
 * everything that's known. Useful for offline policy slicing.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { runEval, SharedEvalInput, type RegoEvalOutput } from './_shared.js';

const RegoCompileQueryInput = SharedEvalInput;

export function registerRegoCompileQuery(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_compile_query',
    {
      title: 'Partially evaluate a Rego query',
      description:
        'Run partial evaluation on a query -- substitute known values and return the residual policy. Defaults `unknowns` to `["input"]` (treat input as unknown), so the residual encodes "given input X, this is what would have to be true." Use this for offline policy slicing or pre-computing decision sets.',
      inputSchema: RegoCompileQueryInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      return withToolEnvelope<RegoEvalOutput>(config, () =>
        runEval(
          opa,
          config,
          {
            ...args,
            partial: true,
            unknowns: args.unknowns?.length ? args.unknowns : ['input'],
          },
          {},
        ),
      );
    },
  );
}
