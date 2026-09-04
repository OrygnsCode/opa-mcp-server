/**
 * Data-document tools: opa_get_data, opa_put_data, opa_patch_data.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaClient } from '../../lib/opa-client.js';
import { err, ok } from '../../lib/errors.js';
import { coerceJsonArg } from '../../lib/json-coerce.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { mapOpaClientError, OPA_DATA_ROOT, parseOpaDataPath } from './_shared.js';

export function registerDataTools(server: McpServer, config: Config): void {
  const opa = new OpaClient(config);

  server.registerTool(
    'opa_get_data',
    {
      title: 'Read data from OPA',
      description:
        "Read a path from OPA's data hierarchy. A `path` is read as dotted (`users.alice`) unless it contains a slash, in which case slash is the only separator (`users/alice`), so a key such as `example.com` is addressable as `hosts/example.com`. Pass `segments` instead when a key contains both.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe('Data path under `data.`, e.g. "users" or "users/alice".'),
        segments: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'Path as literal key segments, e.g. ["labels", "app.kubernetes.io/name"]. Use instead of `path` when a key contains a dot or a slash.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, segments }, { signal }) => {
      return withToolEnvelope<{ result: unknown }>(config, async () => {
        const target = segments ?? path;
        if (target === undefined) {
          return err('INVALID_INPUT', 'Supply either `path` or `segments`.');
        }
        if (path !== undefined && segments !== undefined) {
          return err('INVALID_INPUT', 'Supply `path` or `segments`, not both.');
        }
        const parsed = parseOpaDataPath(target);
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
      description:
        'Write or replace a value at the given data path. Body is sent as JSON. A `path` is read as dotted (`users.alice`) unless it contains a slash, in which case slash is the only separator (`users/alice`), so a key such as `example.com` is addressable as `hosts/example.com`. Pass `segments` instead when a key contains both.',
      inputSchema: {
        path: z.string().min(1).optional().describe('Data path to write to.'),
        segments: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'Path as literal key segments, e.g. ["labels", "app.kubernetes.io/name"]. Use instead of `path` when a key contains a dot or a slash.',
          ),
        value: z.unknown().describe('JSON value to store at this path.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, segments, value }, { signal }) => {
      return withToolEnvelope<{ path: string; segments: string[]; written: boolean }>(
        config,
        async () => {
          const target = segments ?? path;
          if (target === undefined) {
            return err('INVALID_INPUT', 'Supply either `path` or `segments`.');
          }
          if (path !== undefined && segments !== undefined) {
            return err('INVALID_INPUT', 'Supply `path` or `segments`, not both.');
          }
          const parsed = parseOpaDataPath(target);
          if (!parsed.ok) return parsed.error;
          try {
            await opa.request({
              method: 'PUT',
              path: parsed.apiPath,
              body: coerceJsonArg(value),
              signal,
            });
            return ok({
              path: path ?? parsed.segments.join('/'),
              segments: parsed.segments,
              written: true,
            });
          } catch (e) {
            return mapOpaClientError(e);
          }
        },
      );
    },
  );

  server.registerTool(
    'opa_patch_data',
    {
      title: 'Patch data on OPA',
      description:
        'Apply a JSON Patch (RFC 6902) to the data document. Each operation is `{ op, path, value? }`. Omit both `path` and `segments` to patch the root of the data hierarchy, which is how a whole new top-level document is added.',
      inputSchema: {
        path: z.string().min(1).optional().describe('Data path the patch is applied to.'),
        segments: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'Path as literal key segments, e.g. ["labels", "app.kubernetes.io/name"]. Use instead of `path` when a key contains a dot or a slash.',
          ),
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
    async ({ path, segments, operations }, { signal }) => {
      return withToolEnvelope<{ path: string; segments: string[]; patched: boolean }>(
        config,
        async () => {
          const target = segments ?? path;
          if (path !== undefined && segments !== undefined) {
            return err('INVALID_INPUT', 'Supply `path` or `segments`, not both.');
          }
          // Neither given addresses the root, which OPA accepts for PATCH alone.
          let apiPath = OPA_DATA_ROOT;
          let addressed: string[] = [];
          if (target !== undefined) {
            const parsed = parseOpaDataPath(target);
            if (!parsed.ok) return parsed.error;
            apiPath = parsed.apiPath;
            addressed = parsed.segments;
          }
          try {
            await opa.request({
              method: 'PATCH',
              path: apiPath,
              body: operations.map((op) =>
                op.value !== undefined ? { ...op, value: coerceJsonArg(op.value) } : op,
              ),
              headers: { 'Content-Type': 'application/json-patch+json' },
              signal,
            });
            return ok({ path: path ?? addressed.join('/'), segments: addressed, patched: true });
          } catch (e) {
            return mapOpaClientError(e, 'DATA_NOT_FOUND');
          }
        },
      );
    },
  );

  server.registerTool(
    'opa_delete_data',
    {
      title: 'Delete a data document from OPA',
      description:
        "Remove a document from OPA's data store at the given path. A `path` is read as dotted (`users.alice`) unless it contains a slash, in which case slash is the only separator (`users/alice`), so a key such as `example.com` is addressable as `hosts/example.com`. Pass `segments` instead when a key contains both. OPA responds with 204 No Content on success; if no document exists at the path, OPA returns 404 which is mapped to `DATA_NOT_FOUND`. Root-path deletion (`/v1/data/` itself) is intentionally excluded -- supply at least one path segment.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Data path to delete, e.g. "users.alice" or "users/alice". Must be at least one segment deep.',
          ),
        segments: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'Path as literal key segments, e.g. ["labels", "app.kubernetes.io/name"]. Use instead of `path` when a key contains a dot or a slash.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path, segments }, { signal }) => {
      return withToolEnvelope<{ path: string; segments: string[]; deleted: boolean }>(
        config,
        async () => {
          const target = segments ?? path;
          if (target === undefined) {
            return err('INVALID_INPUT', 'Supply either `path` or `segments`.');
          }
          if (path !== undefined && segments !== undefined) {
            return err('INVALID_INPUT', 'Supply `path` or `segments`, not both.');
          }
          const parsed = parseOpaDataPath(target);
          if (!parsed.ok) return parsed.error;
          try {
            await opa.request({
              method: 'DELETE',
              path: parsed.apiPath,
              signal,
            });
            return ok({
              path: path ?? parsed.segments.join('/'),
              segments: parsed.segments,
              deleted: true,
            });
          } catch (e) {
            return mapOpaClientError(e, 'DATA_NOT_FOUND');
          }
        },
      );
    },
  );
}
