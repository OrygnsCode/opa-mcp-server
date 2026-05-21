/**
 * Shared helpers for the server-management tool category. Maps the
 * OpaClient's exception classes to the structured error codes the tool
 * envelope contract defines.
 */
import { err } from '../../lib/errors.js';
import { OpaAuthError, OpaHttpError, OpaUnreachableError } from '../../lib/opa-client.js';
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
  if (e instanceof OpaUnreachableError) {
    return err('OPA_UNREACHABLE', `OPA server unreachable at ${e.url}`, {
      hint: 'Confirm OPA_URL points at a running OPA server (e.g. `curl $OPA_URL/health`).',
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
  return err('UNKNOWN_ERROR', message, {
    details: e instanceof Error ? { stack: e.stack } : { value: e },
  });
}
