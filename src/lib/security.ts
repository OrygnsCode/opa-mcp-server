/**
 * Path validation against the configured allow-list.
 *
 * Tools that accept filesystem paths must validate inputs through
 * `validatePath` to prevent reading or writing outside the
 * agreed-upon roots.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
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
      error: err(
        'PATH_NOT_ALLOWED',
        'File-based tools are disabled because OPA_MCP_ALLOWED_PATHS is empty.',
        {
          hint: 'Set OPA_MCP_ALLOWED_PATHS to a comma-separated list of directories the server may read or write.',
        },
      ),
    };
  }

  const resolved = isAbsolute(inputPath) ? resolve(inputPath) : resolve(process.cwd(), inputPath);

  // Helper: confirm p falls under at least one of the provided root strings.
  const isUnderRoots = (p: string, roots: string[]): boolean =>
    roots.some((root) => {
      const rootWithSep = root.endsWith(sep) ? root : root + sep;
      return p === root || p.startsWith(rootWithSep);
    });

  // Phase 1: syntactic traversal check. path.resolve() collapses `..`
  // segments without I/O, so this catches plain traversal attacks cheaply.
  const resolvedRoots = allowedRoots.map((r) => resolve(r));

  if (!isUnderRoots(resolved, resolvedRoots)) {
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

  // Phase 2: symlink resolution. path.resolve() is purely syntactic and
  // does not follow symlinks. A symlink inside an allowed root can point
  // arbitrarily outside. For any path that exists on disk, resolve the
  // real target and re-validate against the real allowed-root locations.
  //
  // We validate via realpath but return `resolved` (the syntactic path)
  // for backward compatibility across OSes where system directories are
  // themselves symlinks (e.g. macOS /var -> /private/var). Callers pass
  // the returned path to OPA/regal; the OS follows any remaining symlinks
  // at read time, which is safe because we have verified the real target.
  if (existsSync(resolved)) {
    let realPath: string;
    try {
      realPath = realpathSync(resolved);
    } catch {
      // Rare race: path removed between existsSync and realpathSync, or
      // insufficient permissions to read the symlink chain. Fail closed.
      return {
        ok: false,
        error: err('PATH_NOT_FOUND', `Path could not be fully resolved: ${inputPath}`, {
          details: { resolved },
        }),
      };
    }

    // Also realpath the roots themselves so that a root that is a symlink
    // compares correctly against the realpath of the input.
    const realRoots = resolvedRoots.map((r) => {
      try {
        return existsSync(r) ? realpathSync(r) : r;
      } catch {
        return r;
      }
    });

    if (!isUnderRoots(realPath, realRoots)) {
      return {
        ok: false,
        error: err(
          'PATH_NOT_ALLOWED',
          `Path resolves outside allowed roots via symlink: ${inputPath}`,
          {
            hint: 'Set OPA_MCP_ALLOWED_PATHS to a comma-separated list of directories, or use a path under the current allowed roots.',
            details: { resolved, realPath, allowedRoots },
          },
        ),
      };
    }
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
