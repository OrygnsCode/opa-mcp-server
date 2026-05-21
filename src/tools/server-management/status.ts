/**
 * Server-status tools: opa_health, opa_status, opa_config.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaClient, OpaUnreachableError } from '../../lib/opa-client.js';
import { err, ok } from '../../lib/errors.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { mapOpaClientError } from './_shared.js';

export function registerStatusTools(server: McpServer, config: Config): void {
  const opa = new OpaClient(config);

  server.registerTool(
    'opa_health',
    {
      title: 'OPA health check',
      description:
        'Hit the OPA `/health` endpoint. Returns `{ healthy: true }` on 200. Supports `bundles` and `plugins` query flags to require those subsystems to also be healthy.',
      inputSchema: {
        bundles: z.boolean().optional().describe('Require bundle plugin to be healthy as well.'),
        plugins: z.boolean().optional().describe('Require all plugins to be healthy.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ bundles, plugins }, { signal }) => {
      return withToolEnvelope<{ healthy: boolean }>(config, async () => {
        try {
          const query: Record<string, boolean> = {};
          if (bundles) query['bundles'] = true;
          if (plugins) query['plugins'] = true;
          await opa.request({
            method: 'GET',
            path: '/health',
            query,
            signal,
          });
          return ok({ healthy: true });
        } catch (e) {
          if (e instanceof OpaUnreachableError) {
            return mapOpaClientError(e);
          }
          // Any non-2xx counts as unhealthy without raising.
          return err('OPA_UNREACHABLE', 'OPA reported unhealthy.', {
            details: { error: e instanceof Error ? e.message : String(e) },
          });
        }
      });
    },
  );

  server.registerTool(
    'opa_status',
    {
      title: 'OPA status',
      description:
        'Return OPA bundle and decision-log status from the running server. Combines `/v1/config` and the operational status the server exposes through it.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (_input, { signal }) => {
      return withToolEnvelope<{ status: unknown }>(config, async () => {
        try {
          // OPA's status comes back through /v1/config -- the same call as
          // opa_config, but presented with a simpler envelope here so an
          // agent can ask "what's running" without needing to know the
          // underlying shape of the response.
          const status = await opa.request({ method: 'GET', path: '/v1/config', signal });
          return ok({ status });
        } catch (e) {
          return mapOpaClientError(e);
        }
      });
    },
  );

  server.registerTool(
    'opa_config',
    {
      title: 'OPA configuration',
      description:
        'Return the running OPA server configuration (sanitized -- secrets are not included).',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (_input, { signal }) => {
      return withToolEnvelope<{ config: unknown }>(config, async () => {
        try {
          const data = await opa.request<{ result: unknown }>({
            method: 'GET',
            path: '/v1/config',
            signal,
          });
          return ok({ config: data.result ?? data });
        } catch (e) {
          return mapOpaClientError(e);
        }
      });
    },
  );
}
