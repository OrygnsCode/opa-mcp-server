/**
 * Decision-query tools that talk to a running OPA over REST:
 * opa_query_decision, opa_compile_query.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaClient } from '../../lib/opa-client.js';
import { ok } from '../../lib/errors.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { mapOpaClientError } from './_shared.js';

function dataPath(path: string): string {
  const stripped = path.replace(/^data\./, '').replace(/^\/+/, '');
  return `/v1/data/${stripped.replace(/\./g, '/')}`;
}

export function registerDecisionTools(server: McpServer, config: Config): void {
  const opa = new OpaClient(config);

  server.registerTool(
    'opa_query_decision',
    {
      title: 'Query OPA decision',
      description:
        'Evaluate a decision against the running OPA server. POSTs to the data path with `{input}` and returns whatever the rule produces. Use this to ask the server "given this input, what does data.X.allow say?"',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('Decision path under `data.`, e.g. "rbac/allow" or "rbac.allow".'),
        input: z.unknown().optional().describe('Input document to evaluate against.'),
        explain: z
          .enum(['notes', 'fails', 'full', 'debug'])
          .optional()
          .describe('Include a trace at the requested level.'),
        metrics: z.boolean().optional().describe('Include metrics in the response.'),
      },
    },
    async ({ path, input, explain, metrics }) => {
      return withToolEnvelope<{ result?: unknown; explanation?: unknown; metrics?: unknown }>(
        config,
        async () => {
          try {
            const query: Record<string, string | boolean> = {};
            if (explain) query['explain'] = explain;
            if (metrics) query['metrics'] = true;
            const data = await opa.request<{
              result?: unknown;
              explanation?: unknown;
              metrics?: unknown;
            }>({
              method: 'POST',
              path: dataPath(path),
              body: input !== undefined ? { input } : {},
              query,
            });
            return ok({
              result: data.result,
              explanation: data.explanation,
              metrics: data.metrics,
            });
          } catch (e) {
            return mapOpaClientError(e);
          }
        },
      );
    },
  );

  server.registerTool(
    'opa_compile_query',
    {
      title: 'Compile (partially evaluate) a query on OPA',
      description:
        "Send a query to the OPA server's `/v1/compile` endpoint for partial evaluation. Returns the residual query — what remains after substituting in everything that's known.",
      inputSchema: {
        query: z.string().min(1).describe('Rego query to compile, e.g. "data.rbac.allow == true".'),
        input: z.unknown().optional().describe('Optional partial input document.'),
        unknowns: z
          .array(z.string())
          .optional()
          .describe('Refs to treat as unknown (default: ["input"]).'),
      },
    },
    async ({ query, input, unknowns }) => {
      return withToolEnvelope<{ result: unknown }>(config, async () => {
        try {
          const body: Record<string, unknown> = { query };
          if (input !== undefined) body['input'] = input;
          body['unknowns'] = unknowns?.length ? unknowns : ['input'];
          const data = await opa.request<{ result: unknown }>({
            method: 'POST',
            path: '/v1/compile',
            body,
          });
          return ok({ result: data.result });
        } catch (e) {
          return mapOpaClientError(e);
        }
      });
    },
  );
}
