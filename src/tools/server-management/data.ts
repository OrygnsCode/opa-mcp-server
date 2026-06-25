/**
 * Data-document tools: opa_get_data, opa_put_data, opa_patch_data.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaClient } from '../../lib/opa-client.js';
import { ok } from '../../lib/errors.js';
import { coerceJsonArg } from '../../lib/json-coerce.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { mapOpaClientError, parseOpaDataPath } from './_shared.js';

export function registerDataTools(server: McpServer, config: Config): void {
  const opa = new OpaClient(config);

  server.registerTool(
    'opa_get_data',
    {
      title: 'Read data from OPA',
      description:
        "Read a path from OPA's data hierarchy. The `path` argument may be in dotted form (`users.alice`) or slash form (`users/alice`).",
      inputSchema: {
        path: z.string().min(1).describe('Data path under `data.`, e.g. "users" or "users/alice".'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path }, { signal }) => {
      return withToolEnvelope<{ result: unknown }>(config, async () => {
        const parsed = parseOpaDataPath(path);
        if (!parsed.ok) return parsed.error;
        try {
          const data = await opa.request<{ result: unknown }>({
            method: 'GET',
            path: parsed.apiPath,
            signal,
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, value }, { signal }) => {
      return withToolEnvelope<{ path: string; written: boolean }>(config, async () => {
        const parsed = parseOpaDataPath(path);
        if (!parsed.ok) return parsed.error;
        try {
          await opa.request({
            method: 'PUT',
            path: parsed.apiPath,
            body: coerceJsonArg(value),
            signal,
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
        path: z.string().min(1).describe('Data path the patch is applied to. Use "" for the root.'),
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path, operations }, { signal }) => {
      return withToolEnvelope<{ path: string; patched: boolean }>(config, async () => {
        const parsed = parseOpaDataPath(path);
        if (!parsed.ok) return parsed.error;
        try {
          await opa.request({
            method: 'PATCH',
            path: parsed.apiPath,
            body: operations.map((op) =>
              op.value !== undefined ? { ...op, value: coerceJsonArg(op.value) } : op,
            ),
            headers: { 'Content-Type': 'application/json-patch+json' },
            signal,
          });
          return ok({ path, patched: true });
        } catch (e) {
          return mapOpaClientError(e);
        }
      });
    },
  );

  server.registerTool(
    'opa_delete_data',
    {
      title: 'Delete a data document from OPA',
      description:
        "Remove a document from OPA's data store at the given path. The path may be in dotted form (`users.alice`) or slash form (`users/alice`). OPA responds with 204 No Content on success; if no document exists at the path, OPA returns 404 which is mapped to `DATA_NOT_FOUND`. Root-path deletion (`/v1/data/` itself) is intentionally excluded -- supply at least one path segment.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Data path to delete, e.g. "users.alice" or "users/alice". Must be at least one segment deep.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path }, { signal }) => {
      return withToolEnvelope<{ path: string; deleted: boolean }>(config, async () => {
        const parsed = parseOpaDataPath(path);
        if (!parsed.ok) return parsed.error;
        try {
          await opa.request({
            method: 'DELETE',
            path: parsed.apiPath,
            signal,
          });
          return ok({ path, deleted: true });
        } catch (e) {
          return mapOpaClientError(e, 'DATA_NOT_FOUND');
        }
      });
    },
  );
}
