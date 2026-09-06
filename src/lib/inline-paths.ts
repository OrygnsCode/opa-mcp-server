/**
 * Strip this server's own temp-file paths out of anything a tool returns.
 *
 * Inline source is written to a private temp directory for the binaries to
 * read, and their diagnostics, traces and coverage name that file. Nothing
 * here imports another module of this server, so errors.ts can sanitise
 * every envelope without an import cycle.
 */

import { tmpdir } from 'node:os';

/**
 * Matches the temp-file paths written by OpaCli.withTempSource and
 * RegalCli.withTempSource when handling inline source. Both now use
 * mkdtemp which produces a private directory; the file inside is always
 * named input.rego. Matches both Unix (/) and Windows (\) separators.
 */
export const INLINE_TEMP_PATH_PATTERN = /orygn-(?:opa|regal)-mcp-[^/\\]+[/\\]input\.rego$/i;

/**
 * Replace a file path that refers to one of our temp files with the
 * sentinel string `<inline>`. Returns the original string unchanged when
 * it does not match the pattern, so callers can unconditionally apply it
 * to all location.file values regardless of whether inline source was used.
 */
export function sanitizeInlinePath(file: string): string {
  return INLINE_TEMP_PATH_PATTERN.test(file) ? '<inline>' : file;
}

/**
 * The files this server writes under the OS temp directory and hands to a
 * binary: inline source for opa and regal, an inline schema for check-schema,
 * and the archive bundle-verify extracts. A diagnostic names one of them by
 * its full path, and a JSON-encoded diagnostic doubles the backslashes, so a
 * separator is any run of them.
 */
const TEMP_FILE_MARKER =
  /orygn-(?:opa-mcp|regal-mcp|schema)[^\\/\r\n]{0,255}[\\/]+(?:input\.rego|schema\.json|verified\.tar\.gz)/gi;

const SEGMENT_CHAR = /[^\\/:*?"<>|\r\n]/;
const isSeparator = (c: string): boolean => c === '/' || c === '\\';

const isBlank = (c: string): boolean => c === ' ' || c === '\t';

/**
 * Where the path that ends at `markerStart` begins: walk back over
 * `<separators><segment>` pairs, then over a drive letter. Nothing before
 * `floor` is examined, so a scan over a whole string is linear. A segment may
 * hold whitespace, since a Windows temp directory sits under the user's
 * profile and a macOS one can sit under the home directory; but a directory
 * name does not start or end with whitespace, and text that does is prose
 * around the path, where the walk stops. That is a heuristic, and it trades
 * two ways: a word abutting a separator reads as a segment and is taken
 * along with the path (prose lost, nothing leaked), and a temp directory
 * under a component that itself starts or ends with whitespace keeps the
 * components before it (the random temp name is still replaced).
 */
function pathStart(text: string, markerStart: number, floor: number): number {
  let start = markerStart;
  let i = markerStart - 1;
  while (i >= floor && isSeparator(text[i]!)) {
    let j = i;
    while (j >= floor && isSeparator(text[j]!)) j--;
    // Rooted at this separator run unless a segment precedes it.
    start = j + 1;
    let k = j;
    while (k >= floor && SEGMENT_CHAR.test(text[k]!)) k--;
    if (k < j && k >= floor && isSeparator(text[k]!)) {
      if (isBlank(text[j]!) || isBlank(text[k + 1]!)) break;
      i = k;
      continue;
    }
    if (
      k === j &&
      j >= floor + 1 &&
      text[j] === ':' &&
      /[A-Za-z]/.test(text[j - 1]!) &&
      (j - 2 < floor || !/[A-Za-z0-9]/.test(text[j - 2]!))
    ) {
      start = j - 1;
    }
    break;
  }
  return start;
}

/**
 * The spellings a binary may use for a path under `root`: as written, with
 * every separator run as either kind, JSON-encoded (backslashes doubled), and
 * on Windows with the drive dropped, which OPA's loader does. Longest first,
 * so a prefix never wins over the full form.
 */
function rootSpellings(root: string): string[] {
  const slashes = root.replace(/\\/g, '/');
  const backslashes = root.replace(/\//g, '\\');
  const bases = [root, slashes, backslashes];
  for (const base of [...bases]) bases.push(base.replace(/^[A-Za-z]:/, ''));
  const all = bases.flatMap((b) => [b, JSON.stringify(b).slice(1, -1)]);
  return [...new Set(all)].filter((b) => b.length > 1).sort((a, b) => b.length - a.length);
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');

/**
 * Exact matchers for this process's own temp files: the temp root the server
 * writes under, a separator run, the directory prefix mkdtemp extends, its
 * random suffix, and the file name. No guessing is involved, so a component
 * of the root that starts or ends with whitespace, which the walk below has
 * to treat as prose, is handled here.
 */
function exactMatchers(root: string): RegExp[] {
  const sep = String.raw`(?:\\\\|\\|/)+`;
  const tail =
    String.raw`orygn-(?:opa-mcp|regal-mcp|schema)[^\\/\r\n]{0,255}` +
    sep +
    String.raw`(?:input\.rego|schema\.json|verified\.tar\.gz)`;
  return rootSpellings(root).map((r) => new RegExp(escapeRegExp(r) + sep + tail, 'gi'));
}

let ownMatchers: RegExp[] | undefined;
/** Built on first use, from the temp root the server runs with. */
function ownTempMatchers(): RegExp[] {
  ownMatchers ??= exactMatchers(tmpdir());
  return ownMatchers;
}

/**
 * Replace every temp-file path wherever it sits inside `text`: first this
 * process's own files by their exact spelling, then anything shaped like one
 * of them by the walk below.
 */
export function sanitizeInlineText(text: string, roots?: readonly string[]): string {
  if (!text.toLowerCase().includes('orygn-')) return text;
  const matchers = roots === undefined ? ownTempMatchers() : roots.flatMap(exactMatchers);
  for (const matcher of matchers) text = text.replace(matcher, '<inline>');
  if (!text.toLowerCase().includes('orygn-')) return text;
  let out = '';
  let last = 0;
  for (const match of text.matchAll(TEMP_FILE_MARKER)) {
    const start = pathStart(text, match.index, last);
    out += text.slice(last, start) + '<inline>';
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

/**
 * Recursively rewrite every temp-file path, in string values and object
 * keys, to the `<inline>` sentinel. OPA writes inline source to a temp file,
 * so trace, coverage and profile output and every diagnostic reference that
 * path; this normalizes the whole structure so callers never see an absolute
 * temp path. Only a path shaped like this server's own temp files matches.
 */
export function sanitizeInlinePathsDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeInlineText(value);
  if (Array.isArray(value)) return value.map(sanitizeInlinePathsDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[sanitizeInlineText(key)] = sanitizeInlinePathsDeep(val);
    }
    return out;
  }
  return value;
}
