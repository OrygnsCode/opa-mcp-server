/**
 * Server-status tools: opa_health, opa_status, opa_config.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaClient, OpaHttpError } from '../../lib/opa-client.js';
import { ok } from '../../lib/errors.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { mapOpaClientError } from './_shared.js';

/** Stands in for a header value so the header is still visible as configured. */
const REDACTED = '<redacted by opa-mcp>';

/** OPA answers an unhealthy check with `{"error": "..."}`; surface that text. */
function healthReason(e: OpaHttpError): string | undefined {
  const body = e.body;
  if (typeof body === 'string' && body.trim().length > 0) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === 'string') return parsed.error;
    } catch {
      return body.trim();
    }
    return body.trim();
  }
  if (typeof body === 'object' && body !== null) {
    const parsed = body as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  }
  return undefined;
}

/**
 * Redact the values of `services.*.headers` in an OPA configuration document.
 *
 * OPA drops the `credentials` block from `GET /v1/config` but returns `headers`
 * verbatim, and a header is the ordinary way to put an API key or a bearer token
 * in an OPA config. Handing those to an agent, which is what these two tools do
 * with the document, puts a live credential into a transcript. The header names
 * survive, so the document still answers what the server is configured to send.
 */
function redactServiceHeaders(document: unknown): unknown {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return document;
  }
  const doc = document as Record<string, unknown>;
  const services = doc['services'];
  if (typeof services !== 'object' || services === null || Array.isArray(services)) {
    return document;
  }

  let touched = false;
  const redactedServices: Record<string, unknown> = {};

  for (const [name, service] of Object.entries(services as Record<string, unknown>)) {
    if (typeof service !== 'object' || service === null || Array.isArray(service)) {
      redactedServices[name] = service;
      continue;
    }
    const entry = service as Record<string, unknown>;
    const headers = entry['headers'];
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      redactedServices[name] = service;
      continue;
    }
    touched = true;
    redactedServices[name] = {
      ...entry,
      headers: Object.fromEntries(Object.keys(headers).map((k) => [k, REDACTED])),
    };
  }

  return touched ? { ...doc, services: redactedServices } : document;
}

export function registerStatusTools(server: McpServer, config: Config): void {
  const opa = new OpaClient(config);

  server.registerTool(
    'opa_health',
    {
      title: 'OPA health check',
      description:
        "Hit the OPA `/health` endpoint. A server that answers reports `{ healthy: true }` on 200 and `{ healthy: false }` with OPA's own reason otherwise, so an unactivated bundle is a health result rather than a tool error. `OPA_UNREACHABLE` means the server could not be reached at all. Supports `bundles` and `plugins` query flags to require those subsystems to also be healthy.",
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
      return withToolEnvelope<{ healthy: boolean; reason?: string }>(config, async () => {
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
          // A server that answered is reachable. Reporting an unactivated
          // bundle as OPA_UNREACHABLE told the caller to go start a server that
          // was already running, and buried OPA's own reason in a stringified
          // error. Authentication is its own failure, not a health result, and
          // so is a server that could not be reached or a cancelled request.
          if (e instanceof OpaHttpError && e.status !== 401) {
            const reason = healthReason(e);
            return ok({ healthy: false, ...(reason !== undefined ? { reason } : {}) });
          }
          return mapOpaClientError(e);
        }
      });
    },
  );

  server.registerTool(
    'opa_status',
    {
      title: 'OPA status',
      description:
        'Return the running OPA server configuration via `GET /v1/config`. ' +
        'Returns the same underlying document as `opa_config` but presented under a `status` ' +
        'key as a convenience for agents that want to check "what is running" rather than ' +
        '"what was the server configured with". The response includes bundle settings, ' +
        'decision-log settings, and plugin configuration as OPA reported them at startup. ' +
        'Service header values are redacted, since OPA returns them verbatim and a header is ' +
        'the ordinary place to put an API key.',
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
          const data = await opa.request<{ result?: unknown }>({
            method: 'GET',
            path: '/v1/config',
            signal,
          });
          return ok({ status: redactServiceHeaders(data.result ?? data) });
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
        'Return the running OPA server configuration from `GET /v1/config`. OPA drops the `credentials` block but returns `services.*.headers` verbatim, which is the ordinary place to put an API key or a bearer token, so those values are redacted here and the header names kept.',
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
          return ok({ config: redactServiceHeaders(data.result ?? data) });
        } catch (e) {
          return mapOpaClientError(e);
        }
      });
    },
  );
}
