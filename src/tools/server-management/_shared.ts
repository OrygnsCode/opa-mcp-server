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
  OpaTimeoutError,
  OpaUnreachableError,
  OpaUrlCredentialsError,
} from '../../lib/opa-client.js';
import type { ToolEnvelope, ToolErrorCode } from '../../types.js';

/**
 * Split a user-supplied OPA data path into its key segments.
 *
 * A path arrives either dotted (`users.alice`, the Rego spelling) or slashed
 * (`users/alice`, the REST spelling). Data keys are free to contain the other
 * separator: hostnames, image references and semver strings carry dots, so
 * treating both characters as separators addressed a document that was not the
 * one asked for. A slash anywhere therefore makes the slash the only separator,
 * and a path with no slash is read as dotted.
 *
 * A key holding both characters, such as a Kubernetes label key, cannot be
 * written either way. Callers pass an array of literal segments for that.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A stray `%` is a literal character in a key, not an escape.
    return segment;
  }
}

function splitDataPath(path: string): string[] {
  const trimmed = path.trim().replace(/^[/]+/, '').replace(/[/]+$/, '');
  // Drop a leading `data.` or `data/` root, but not a key named `database`.
  const withoutRoot = trimmed.replace(/^data(?=$|[./])[./]?/, '');
  if (withoutRoot.length === 0) return [];
  return withoutRoot.includes('/') ? withoutRoot.split('/') : withoutRoot.split('.');
}

/**
 * The data root. OPA answers `PATCH /v1/data` but redirects `/v1/data/`, so the
 * root has no trailing slash while every deeper path is built by joining onto
 * `${OPA_DATA_ROOT}/`.
 */
export const OPA_DATA_ROOT = '/v1/data';

/**
 * Convert a user-supplied OPA data path to the `/v1/data/...` REST API path.
 *
 * Accepts the dotted or slash string form, or an array whose elements are
 * literal keys. Every segment is percent-encoded, which OPA decodes, so a key
 * may hold a dot, a slash, a question mark or any non-ASCII character. Rejects
 * `.` and `..` segments so a crafted input cannot traverse to unrelated OPA
 * endpoints such as `/v1/config`.
 */
export function parseOpaDataPath(
  path: string | readonly string[],
): { ok: true; apiPath: string; segments: string[] } | { ok: false; error: ToolEnvelope<never> } {
  const segments = typeof path === 'string' ? splitDataPath(path) : [...path];
  const shown = typeof path === 'string' ? path : JSON.stringify(path);

  if (segments.length === 0) {
    return {
      ok: false,
      error: err('INVALID_INPUT', `Data path must name at least one segment: ${shown}`, {
        hint: 'The root of the data hierarchy is not addressable here. Supply a path such as "users" or "users/alice".',
      }),
    };
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      return {
        ok: false,
        error: err('INVALID_INPUT', `Data path has an empty segment: ${shown}`, {
          hint: 'Remove the repeated separator, or pass `segments` if a key is genuinely empty.',
        }),
      };
    }
    // Encoding below already stops `%2e%2e` reaching the wire as a traversal,
    // but a caller writing one means to traverse, so say no rather than look up
    // a key of that literal name.
    const decoded = decodeSegment(segment);
    if (decoded === '.' || decoded === '..') {
      return { ok: false, error: err('INVALID_INPUT', `Path traversal not allowed: ${shown}`) };
    }
  }

  const apiPath = `${OPA_DATA_ROOT}/${segments.map(encodeURIComponent).join('/')}`;

  // Backstop. Encoding already neutralises `%2e%2e` and friends, but a resolved
  // path outside the data prefix must never reach the server.
  if (!new URL(`http://h${apiPath}`).pathname.startsWith(`${OPA_DATA_ROOT}/`)) {
    return { ok: false, error: err('INVALID_INPUT', `Path traversal not allowed: ${shown}`) };
  }
  return { ok: true, apiPath, segments };
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
  if (e instanceof OpaUrlCredentialsError) {
    return err('OPA_URL_INVALID', e.message + '.', {
      hint: 'Remove the username and password from OPA_URL and pass the bearer token through OPA_TOKEN instead.',
      details: { url: e.url },
    });
  }
  if (e instanceof OpaTimeoutError) {
    return err('TIMEOUT', `OPA at ${e.url} did not answer within ${e.timeoutMs} ms.`, {
      hint: 'Either OPA is up but slow, or nothing is answering at OPA_URL and the connection attempt is being dropped rather than refused, which looks the same from here. Check OPA_URL and the server load, or raise OPA_MCP_HTTP_TIMEOUT_MS.',
      details: { url: e.url, timeoutMs: e.timeoutMs },
    });
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
