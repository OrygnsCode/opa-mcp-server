/**
 * Path validation against the configured allow-list.
 *
 * Tools that accept filesystem paths must validate inputs through
 * `validatePath` to prevent reading or writing outside the
 * agreed-upon roots.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import { err } from './errors.js';
import type { ToolEnvelope } from '../types.js';

export interface PathValidationResult {
  ok: boolean;
  resolved?: string;
  error?: ToolEnvelope<never>;
}

/**
 * Resolve `inputPath` and confirm it is contained within at least one
 * `allowedRoots` entry. Returns the resolved absolute path on success.
 */
export function validatePath(
  inputPath: string,
  allowedRoots: string[],
  options: { mustExist?: boolean } = {},
): PathValidationResult {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return {
      ok: false,
      error: err('INVALID_INPUT', 'Path must be a non-empty string'),
    };
  }

  if (allowedRoots.length === 0) {
    return {
      ok: false,
      error: err('PATH_NOT_ALLOWED', 'File-based tools are disabled because OPA_MCP_ALLOWED_PATHS is empty.', {
        hint: 'Set OPA_MCP_ALLOWED_PATHS to a comma-separated list of directories the server may read or write.',
      }),
    };
  }

  const resolved = isAbsolute(inputPath) ? resolve(inputPath) : resolve(process.cwd(), inputPath);

  const isInsideRoot = allowedRoots.some((root) => {
    const resolvedRoot = resolve(root);
    const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    return resolved === resolvedRoot || resolved.startsWith(rootWithSep);
  });

  if (!isInsideRoot) {
    return {
      ok: false,
      error: err('PATH_NOT_ALLOWED', `Path is outside allowed roots: ${inputPath}`, {
        hint: 'Set OPA_MCP_ALLOWED_PATHS to a comma-separated list of directories, or use a path under the current allowed roots.',
        details: { resolved, allowedRoots },
      }),
    };
  }

  if (options.mustExist && !existsSync(resolved)) {
    return {
      ok: false,
      error: err('PATH_NOT_FOUND', `Path does not exist: ${inputPath}`, {
        details: { resolved },
      }),
    };
  }

  return { ok: true, resolved };
}

/** Convenience: returns true if the path is a directory (after validation). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
