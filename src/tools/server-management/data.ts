/**
 * Data-document tools: opa_get_data, opa_put_data, opa_patch_data.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaClient } from '../../lib/opa-client.js';
import { ok } from '../../lib/errors.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { mapOpaClientError } from './_shared.js';

function dataPath(path: string): string {
  // Strip leading "data." or "/" — server always prepends /v1/data/.
  const stripped = path.replace(/^data\./, '').replace(/^\/+/, '');
  // Convert dotted form to slash form: "users.alice" -> "users/alice".
  return `/v1/data/${stripped.replace(/\./g, '/')}`;
}

export function registerDataTools(server: McpServer, config: Config): void {
  const opa = new OpaClient(config);

  server.registerTool(
    'opa_get_data',
    {
      title: 'Read data from OPA',
      description:
        'Read a path from OPA\'s data hierarchy. The `path` argument may be in dotted form (`users.alice`) or slash form (`users/alice`).',
      inputSchema: {
        path: z.string().min(1).describe('Data path under `data.`, e.g. "users" or "users/alice".'),
      },
    },
    async ({ path }) => {
      return withToolEnvelope<{ result: unknown }>(config, async () => {
        try {
          const data = await opa.request<{ result: unknown }>({
            method: 'GET',
            path: dataPath(path),
          });
          return ok({ result: data.result });
        } catch (e) {
          return mapOpaClientError(e);
        }
      });
    },
  );

  server.registerTool(
    'opa_put_data',
    {
      title: 'Write data to OPA',
      description: 'Write or replace a value at the given data path. Body is sent as JSON.',
      inputSchema: {
        path: z.string().min(1).describe('Data path to write to.'),
        value: z.unknown().describe('JSON value to store at this path.'),
      },
    },
    async ({ path, value }) => {
      return withToolEnvelope<{ path: string; written: boolean }>(config, async () => {
        try {
          await opa.request({
            method: 'PUT',
            path: dataPath(path),
            body: value,
          });
          return ok({ path, written: true });
        } catch (e) {
          return mapOpaClientError(e);
        }
      });
    },
  );

  server.registerTool(
    'opa_patch_data',
    {
      title: 'Patch data on OPA',
      description:
        'Apply a JSON Patch (RFC 6902) to the data document. Each operation is `{ op, path, value? }`.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('Data path the patch is applied to. Use "" for the root.'),
        operations: z
          .array(
            z.object({
              op: z.enum(['add', 'remove', 'replace']),
              path: z.string(),
              value: z.unknown().optional(),
            }),
          )
          .min(1)
          .describe('Array of JSON Patch operations.'),
      },
    },
    async ({ path, operations }) => {
      return withToolEnvelope<{ path: string; patched: boolean }>(config, async () => {
        try {
          await opa.request({
            method: 'PATCH',
            path: dataPath(path),
            body: operations,
            headers: { 'Content-Type': 'application/json-patch+json' },
          });
          return ok({ path, patched: true });
        } catch (e) {
          return mapOpaClientError(e);
        }
      });
    },
  );
}
