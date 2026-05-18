/**
 * Policy-management tools that talk to a running OPA via REST:
 * opa_list_policies, opa_get_policy, opa_put_policy, opa_delete_policy.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaClient } from '../../lib/opa-client.js';
import { ok } from '../../lib/errors.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { mapOpaClientError } from './_shared.js';

interface OpaPolicyRecord {
  id: string;
  raw?: string;
  ast?: unknown;
}

export function registerPolicyTools(server: McpServer, config: Config): void {
  const opa = new OpaClient(config);

  server.registerTool(
    'opa_list_policies',
    {
      title: 'List OPA policies',
      description:
        'List policies registered on the running OPA server. Returns an array of `{ id, raw, ast }` records.',
      inputSchema: {},
    },
    async () => {
      return withToolEnvelope<{ policies: OpaPolicyRecord[] }>(config, async () => {
        try {
          const data = await opa.request<{ result: OpaPolicyRecord[] }>({
            method: 'GET',
            path: '/v1/policies',
          });
          return ok({ policies: data.result ?? [] });
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
      description: 'Fetch a single policy by ID from the running OPA server.',
      inputSchema: {
        id: z.string().min(1).describe('Policy ID, e.g. "rbac" or "policies/auth/main".'),
      },
    },
    async ({ id }) => {
      return withToolEnvelope<{ policy: OpaPolicyRecord }>(config, async () => {
        try {
          const data = await opa.request<{ result: OpaPolicyRecord }>({
            method: 'GET',
            path: `/v1/policies/${encodeURIComponent(id)}`,
          });
          return ok({ policy: data.result });
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
        'Upload a Rego policy under the given ID. Replaces any existing policy with that ID. The policy is uploaded as raw text/plain -- OPA parses it on the server side.',
      inputSchema: {
        id: z.string().min(1).describe('Policy ID to create or replace.'),
        source: z.string().min(1).describe('Rego source.'),
      },
    },
    async ({ id, source }) => {
      return withToolEnvelope<{ id: string; replaced: boolean }>(config, async () => {
        try {
          await opa.request({
            method: 'PUT',
            path: `/v1/policies/${encodeURIComponent(id)}`,
            rawBody: source,
            rawContentType: 'text/plain',
          });
          return ok({ id, replaced: true });
        } catch (e) {
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
    },
    async ({ id }) => {
      return withToolEnvelope<{ id: string; deleted: boolean }>(config, async () => {
        try {
          await opa.request({
            method: 'DELETE',
            path: `/v1/policies/${encodeURIComponent(id)}`,
          });
          return ok({ id, deleted: true });
        } catch (e) {
          return mapOpaClientError(e, 'POLICY_NOT_FOUND');
        }
      });
    },
  );
}
