/**
 * Making load paths safe to hand to the `opa` binary.
 *
 * OPA's loader reads every load path as an optional `prefix:path` pair and
 * splits on the FIRST colon, mounting the document under `data.<prefix>`.
 * Every absolute Windows path begins with one:
 *
 *     opa eval -d "C:\policies\data.json" data
 *       -> {"C": {...}}      the document is at data.C, not where it belongs
 *
 * Forward slashes do not help, since `C:/policies` still has the colon, and
 * there is no escape syntax; the `\\?\` prefix is rejected outright. The only
 * spelling OPA reads correctly is a relative one, so load paths are rewritten
 * relative to a directory the child is then started in.
 *
 * Two things narrow this. Only paths OPA MOUNTS are affected: a `--input`,
 * `--signing-key` or `--capabilities` file is opened directly and works fine
 * absolute, so callers pass only their genuine load paths. And a `.rego`
 * module mounts at its own `package` whatever path it arrived by, so only data
 * documents and the directories holding them are respelled. That is why this
 * stayed invisible: policies loaded correctly and their data silently did not.
 *
 * A module is still opened by the remainder after the colon, which is a
 * root-relative path OPA resolves against the drive the child is running on.
 * That works only when the working directory is on the module's drive, which
 * on a developer machine it usually is and on a CI runner that keeps its
 * workspace and its temp directory on different drives it is not. So every
 * load path, module or not, takes part in choosing the working directory;
 * only the non-module ones are respelled.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, parse, relative, sep } from 'node:path';

/** A path OPA would split: a drive letter followed by a separator. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Would loading this path by an absolute spelling put its contents in the
 * wrong place?
 *
 * A `.rego` module mounts at its own `package` whatever path it arrived by,
 * verified against OPA 1.19: an absolute `p.rego` lands at `data.p` while an
 * absolute `d.json` lands at `data.C`. Modules are therefore not respelled,
 * which also keeps the rewrite away from the temp file this server writes for
 * inline source, whose absolute path is matched afterwards to redact it from
 * output. They still count toward the working directory: see `rewriteLoadPaths`.
 */
function needsRewrite(path: string): boolean {
  return extname(path).toLowerCase() !== '.rego';
}

export interface RewrittenArgs {
  args: string[];
  /** Working directory the child must run in, when any path was rewritten. */
  cwd?: string;
  /**
   * Set when the load paths span more than one drive, so no single working
   * directory can serve them. The caller reports this rather than loading
   * documents into the wrong place.
   */
  conflict?: { drives: string[] };
}

/** Longest directory containing every one of `paths`. */
function commonAncestor(paths: string[]): string | undefined {
  const split = paths.map((p) => p.split(/[\\/]+/));
  const first = split[0];
  if (!first) return undefined;
  const shared: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const segment = first[i]!;
    // Windows compares path segments without regard to case.
    if (!split.every((parts) => parts[i]?.toLowerCase() === segment.toLowerCase())) break;
    shared.push(segment);
  }
  if (shared.length === 0) return undefined;
  const joined = shared.join(sep);
  // A drive root keeps its separator: "C:" alone is drive-relative, not root.
  return shared.length === 1 ? joined + sep : joined;
}

/**
 * Rewrite the given load paths, wherever they appear in `args`, into paths
 * relative to a common working directory.
 *
 * `loadPaths` are the arguments OPA will mount as documents. Anything else in
 * `args` is left exactly as it was, so a query, a rule name, or a file OPA
 * merely opens cannot be touched. On a platform whose absolute paths carry no
 * drive letter nothing matches and the arguments come back unchanged.
 */
export function rewriteLoadPaths(args: string[], loadPaths: readonly string[]): RewrittenArgs {
  // Every drive-letter load path anchors the working directory, modules
  // included, since a module is opened relative to the child's drive even
  // though it mounts by package. Only the non-module ones are respelled.
  const anchors = [...new Set(loadPaths.filter((p) => DRIVE_PATH.test(p) && existsSync(p)))];
  if (anchors.length === 0) return { args };

  const drives = [...new Set(anchors.map((p) => parse(p).root.toLowerCase()))];
  if (drives.length > 1) return { args, conflict: { drives } };

  // The ancestor is taken over the containing directories, never the paths
  // themselves: the ancestor of a single file would be that file, and a file
  // cannot be a working directory.
  const cwd = commonAncestor(anchors.map(dirname));
  if (cwd === undefined || !existsSync(cwd)) return { args };

  const targets = anchors.filter(needsRewrite);

  const rewritten = args.map((a) => {
    if (!targets.includes(a)) return a;
    const rel = relative(cwd, a);
    // A load path that IS the working directory.
    if (rel === '') return '.';
    // Defensive: a result that is still absolute, or climbs out of the
    // working directory, would not help, so the original is kept.
    return isAbsolute(rel) || rel.startsWith('..') ? a : rel;
  });

  return { args: rewritten, cwd };
}
