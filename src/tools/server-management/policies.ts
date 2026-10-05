/**
 * Policy-management tools that talk to a running OPA via REST:
 * opa_list_policies, opa_get_policy, opa_put_policy, opa_delete_policy.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaClient, OpaHttpError } from '../../lib/opa-client.js';
import { ok } from '../../lib/errors.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { compileFailure, mapOpaClientError } from './_shared.js';

interface OpaPolicyRecord {
  id: string;
  raw?: string;
  ast?: unknown;
}

/**
 * Drop the parts of a policy record the caller did not ask for.
 *
 * OPA answers the policy endpoints with the parsed AST alongside the source,
 * and the AST is far larger than the text it came from: a 477-byte policy comes
 * back as a 19 KB response once the envelope is indented. Returning it by
 * default pushed a list of any real size past the response cap, and the cap's
 * advice to narrow the scope was unfollowable because the list tool takes no
 * arguments.
 */
function trimPolicy(
  record: OpaPolicyRecord,
  opts: { source: boolean; ast: boolean },
): OpaPolicyRecord {
  const trimmed: OpaPolicyRecord = { id: record.id };
  if (opts.source && record.raw !== undefined) trimmed.raw = record.raw;
  if (opts.ast && record.ast !== undefined) trimmed.ast = record.ast;
  return trimmed;
}

export function registerPolicyTools(server: McpServer, config: Config): void {
  const opa = new OpaClient(config);

  server.registerTool(
    'opa_list_policies',
    {
      title: 'List OPA policies',
      description:
        'List policies registered on the running OPA server. Returns the policy IDs and a count. Set `includeSource` for the Rego text of every policy, or `includeAst` for the parsed AST of every policy; both are off by default because either one pushes a list of any real size past the response cap.',
      inputSchema: {
        includeSource: z
          .boolean()
          .optional()
          .describe(
            "Include each policy's Rego source. Off by default: fetch one policy with `opa_get_policy` rather than every policy at once.",
          ),
        includeAst: z
          .boolean()
          .optional()
          .describe(
            "Include each policy's parsed AST. Off by default; it is roughly forty times the size of the source and will exceed the response cap on all but the smallest servers.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ includeSource, includeAst }, { signal }) => {
      return withToolEnvelope<{ policies: OpaPolicyRecord[]; count: number }>(config, async () => {
        try {
          const data = await opa.request<{ result: OpaPolicyRecord[] }>({
            method: 'GET',
            path: '/v1/policies',
            signal,
          });
          const records = data.result ?? [];
          return ok({
            policies: records.map((r) =>
              trimPolicy(r, { source: includeSource === true, ast: includeAst === true }),
            ),
            count: records.length,
          });
        } catch (e) {
          return mapOpaClientError(e);
        }
      });
    },
  );

  server.registerTool(
    'opa_get_policy',
    {
      title: 'Get OPA policy by ID',
      description:
        "Fetch a single policy by ID from the running OPA server. Returns the Rego source; the parsed AST is omitted unless asked for, since it is roughly forty times the size of the source it came from. Use `rego_parse_ast` on the source when an AST is what's wanted.",
      inputSchema: {
        id: z.string().min(1).describe('Policy ID, e.g. "rbac" or "policies/auth/main".'),
        includeAst: z
          .boolean()
          .optional()
          .describe("Include OPA's parsed AST alongside the source. Off by default."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, includeAst }, { signal }) => {
      return withToolEnvelope<{ policy: OpaPolicyRecord }>(config, async () => {
        try {
          const data = await opa.request<{ result: OpaPolicyRecord }>({
            method: 'GET',
            path: `/v1/policies/${encodeURIComponent(id)}`,
            signal,
          });
          return ok({
            policy: trimPolicy(data.result, { source: true, ast: includeAst === true }),
          });
        } catch (e) {
          return mapOpaClientError(e, 'POLICY_NOT_FOUND');
        }
      });
    },
  );

  server.registerTool(
    'opa_put_policy',
    {
      title: 'Upload or replace OPA policy',
      description:
        "Upload a Rego policy under the given ID. Replaces any existing policy with that ID; `replaced` says whether one existed. The policy is uploaded as raw text/plain and OPA compiles it on the server, so a policy that does not compile comes back as INVALID_REGO with OPA's errors, and nothing is stored.",
      inputSchema: {
        id: z.string().min(1).describe('Policy ID to create or replace.'),
        source: z.string().min(1).describe('Rego source.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, source }, { signal }) => {
      return withToolEnvelope<{ id: string; replaced: boolean }>(config, async () => {
        const path = `/v1/policies/${encodeURIComponent(id)}`;
        // OPA answers a create and a replace alike, so look first; `replaced`
        // used to be true for every upload.
        let existed: boolean;
        try {
          await opa.request({ method: 'GET', path, signal });
          existed = true;
        } catch (e) {
          if (e instanceof OpaHttpError && e.status === 404) existed = false;
          else return mapOpaClientError(e);
        }
        try {
          await opa.request({
            method: 'PUT',
            path,
            rawBody: source,
            rawContentType: 'text/plain',
            signal,
          });
          return ok({ id, replaced: existed });
        } catch (e) {
          const compile = compileFailure(e);
          if (compile) return compile;
          return mapOpaClientError(e);
        }
      });
    },
  );

  server.registerTool(
    'opa_delete_policy',
    {
      title: 'Delete OPA policy',
      description: 'Delete a policy by ID from the running OPA server.',
      inputSchema: {
        id: z.string().min(1).describe('Policy ID to delete.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id }, { signal }) => {
      return withToolEnvelope<{ id: string; deleted: boolean }>(config, async () => {
        try {
          await opa.request({
            method: 'DELETE',
            path: `/v1/policies/${encodeURIComponent(id)}`,
            signal,
          });
          return ok({ id, deleted: true });
        } catch (e) {
          return mapOpaClientError(e, 'POLICY_NOT_FOUND');
        }
      });
    },
  );
}
