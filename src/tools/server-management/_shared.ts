/**
 * Shared helpers for the server-management tool category. Maps the
 * OpaClient's exception classes to the structured error codes the tool
 * envelope contract defines.
 */
import { err } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  OpaAuthError,
  OpaCancelledError,
  OpaHttpError,
  OpaUnreachableError,
} from '../../lib/opa-client.js';
import type { ToolEnvelope, ToolErrorCode } from '../../types.js';

/**
 * Convert a user-supplied OPA data path (dotted or slash form) to the
 * `/v1/data/...` REST API path. Rejects `..` segments so a crafted input
 * cannot traverse to unrelated OPA endpoints (e.g. `/v1/config`).
 */
export function parseOpaDataPath(
  path: string,
): { ok: true; apiPath: string } | { ok: false; error: ToolEnvelope<never> } {
  const stripped = path.replace(/^data\./, '').replace(/^\/+/, '');
  const apiPath = `/v1/data/${stripped.replace(/\./g, '/')}`;

  // Normalize through URL parsing to catch both literal `..` segments and
  // percent-encoded variants (%2e%2e). If the resolved pathname no longer
  // starts with /v1/data/, a traversal escaped the intended prefix.
  const normalized = new URL(`http://h${apiPath}`).pathname;
  if (!normalized.startsWith('/v1/data/')) {
    return {
      ok: false,
      error: err('INVALID_INPUT', `Path traversal not allowed: ${path}`),
    };
  }
  return { ok: true, apiPath };
}

/**
 * Translate an exception thrown by OpaClient into a structured error
 * envelope. `notFoundCode` lets a tool override the default 404
 * mapping (which is generic) with something specific like
 * `POLICY_NOT_FOUND`.
 */
export function mapOpaClientError(
  e: unknown,
  notFoundCode: ToolErrorCode = 'UNKNOWN_ERROR',
): ToolEnvelope<never> {
  if (e instanceof OpaCancelledError) {
    return err('CANCELLED', 'OPA request was cancelled by the client.');
  }
  if (e instanceof OpaUnreachableError) {
    return err('OPA_UNREACHABLE', `OPA server unreachable at ${e.url}`, {
      hint: 'No running OPA server was found at OPA_URL. To start one locally: `opa run --server`. For production, OPA is typically deployed as a sidecar or standalone service. Verify the address with `curl $OPA_URL/health`. Set OPA_URL to the correct base URL if needed.',
      details: { url: e.url },
    });
  }
  if (e instanceof OpaAuthError) {
    return err('OPA_AUTH_FAILED', 'OPA rejected the request with 401 Unauthorized.', {
      hint: 'Set OPA_TOKEN to a valid bearer token, or remove the auth requirement on the OPA server.',
    });
  }
  if (e instanceof OpaHttpError) {
    if (e.status === 404) {
      return err(notFoundCode, `OPA returned 404 Not Found.`, {
        details: { status: e.status, body: e.body },
      });
    }
    return err('UNKNOWN_ERROR', `OPA returned HTTP ${e.status}.`, {
      details: { status: e.status, body: e.body },
    });
  }
  const message = e instanceof Error ? e.message : 'Unknown error';
  if (e instanceof Error) {
    // Log the stack server-side; never return it to the client (path leak).
    logger.error('Unmapped OPA client error', { message, stack: e.stack });
    return err('UNKNOWN_ERROR', message);
  }
  return err('UNKNOWN_ERROR', message, { details: { value: e } });
}
