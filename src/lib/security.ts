/**
 * Path validation against the configured allow-list.
 *
 * Tools that accept filesystem paths must validate inputs through
 * `validatePath` to prevent reading or writing outside the
 * agreed-upon roots.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { err } from './errors.js';
import type { ToolEnvelope } from '../types.js';

export interface PathValidationResult {
  ok: boolean;
  resolved?: string;
  error?: ToolEnvelope<never>;
}

const WINDOWS = process.platform === 'win32';

/**
 * Canonical form of an existing path: every link resolved, and on Windows
 * 8.3 short names expanded and on-disk casing restored. The JavaScript
 * `realpathSync` resolves links but leaves short names and casing alone, so
 * two spellings of one directory could compare unequal.
 */
function canonical(p: string): string {
  return realpathSync.native(p);
}

/** Does `p` fall under at least one of `roots`? */
function isUnderRoots(p: string, roots: string[], caseInsensitive: boolean): boolean {
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const candidate = fold(p);
  return roots.some((root) => {
    const r = fold(root);
    const rootWithSep = r.endsWith(sep) ? r : r + sep;
    return candidate === r || candidate.startsWith(rootWithSep);
  });
}

type RealLocation =
  | { kind: 'real'; path: string; exists: boolean }
  | { kind: 'dangling'; link: string }
  | { kind: 'unresolvable'; reason: string };

/**
 * Where a path really leads, whether or not it exists yet.
 *
 * Walks up from `p` to the nearest entry that exists, resolves that entry's
 * real location, and re-attaches the segments below it. A write to `p` lands
 * under that real location, so that is what has to be checked against the
 * roots. Checking only paths that already exist left every not-yet-created
 * write target unchecked, and a junction or symlink inside a root could point
 * it anywhere.
 *
 * An entry that exists only as a link to something that does not exist (a
 * dangling link) is reported on its own: a write through it would create the
 * target wherever the link points.
 */
function realLocation(p: string): RealLocation {
  const below: string[] = [];
  let cur = p;
  for (;;) {
    let entry;
    try {
      entry = lstatSync(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        const parent = dirname(cur);
        if (parent === cur) return { kind: 'unresolvable', reason: 'no existing ancestor' };
        below.unshift(basename(cur));
        cur = parent;
        continue;
      }
      return { kind: 'unresolvable', reason: code ?? String(e) };
    }
    let real: string;
    try {
      real = canonical(cur);
    } catch (e) {
      if (entry.isSymbolicLink()) return { kind: 'dangling', link: cur };
      return { kind: 'unresolvable', reason: (e as NodeJS.ErrnoException).code ?? String(e) };
    }
    return {
      kind: 'real',
      path: below.length === 0 ? real : join(real, ...below),
      exists: below.length === 0,
    };
  }
}

/**
 * Resolve `inputPath` and confirm it is contained within at least one
 * `allowedRoots` entry. Returns the resolved absolute path on success.
 *
 * Two checks, both of which must pass. The first is syntactic: `..` segments
 * are collapsed without touching the disk and the result must sit under a
 * root as written. The second follows the filesystem: the path's real
 * location, including the part of it that does not exist yet, must sit under
 * a root's real location. A link is still followed at read or write time by
 * the tool that receives the path, so the check is against the layout at the
 * moment of validation.
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
  const resolvedRoots = allowedRoots.map((r) => resolve(r));
  const outsideHint =
    'Set OPA_MCP_ALLOWED_PATHS to a comma-separated list of directories, or use a path under the current allowed roots.';

  // Phase 1: syntactic containment, cheap and free of I/O. It is not the
  // decision on its own: a root spelled through a link (macOS /var, a Windows
  // short name, a junction) and a path spelled through the target land in the
  // same real place and must be accepted. It settles which message an
  // escaping path gets. Windows compares without regard to case.
  const syntacticallyInside = isUnderRoots(resolved, resolvedRoots, WINDOWS);
  const outsideRoots = () =>
    err('PATH_NOT_ALLOWED', `Path is outside allowed roots: ${inputPath}`, {
      hint: outsideHint,
      details: { resolved, allowedRoots },
    });

  // Phase 2: real location. This is the decision.
  const location = realLocation(resolved);
  if (location.kind === 'dangling') {
    return {
      ok: false,
      error: err(
        'PATH_NOT_ALLOWED',
        `Path goes through a link whose target does not exist: ${inputPath}`,
        {
          hint: 'A write through a dangling link would create its target wherever the link points. Remove the link or use a path that does not go through it.',
          details: { resolved, link: location.link },
        },
      ),
    };
  }
  if (location.kind === 'unresolvable') {
    if (!syntacticallyInside) return { ok: false, error: outsideRoots() };
    return {
      ok: false,
      error: err('PATH_NOT_FOUND', `Path could not be fully resolved: ${inputPath}`, {
        details: { resolved, reason: location.reason },
      }),
    };
  }
  if (options.mustExist && !location.exists) {
    if (!syntacticallyInside) return { ok: false, error: outsideRoots() };
    return {
      ok: false,
      error: err('PATH_NOT_FOUND', `Path does not exist: ${inputPath}`, {
        details: { resolved },
      }),
    };
  }

  // A root that is itself a link, or spelled with a short name, compares
  // correctly only in canonical form. A root that does not exist stays as
  // written; nothing under it can resolve to it anyway.
  const realRoots = resolvedRoots.map((r) => {
    try {
      return canonical(r);
    } catch {
      return r;
    }
  });

  if (!isUnderRoots(location.path, realRoots, false)) {
    if (!syntacticallyInside) return { ok: false, error: outsideRoots() };
    return {
      ok: false,
      error: err(
        'PATH_NOT_ALLOWED',
        `Path resolves outside allowed roots via a link: ${inputPath}`,
        {
          hint: outsideHint,
          details: { resolved, realPath: location.path, allowedRoots },
        },
      ),
    };
  }

  // The syntactic path is returned, not the canonical one: on macOS the
  // system temp directory is itself a link, and tools compare and report
  // paths as the caller spelled them.
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
