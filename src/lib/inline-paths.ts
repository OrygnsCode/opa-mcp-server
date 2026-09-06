/**
 * Strip this server's own temp-file paths out of anything a tool returns.
 *
 * Inline source is written to a private temp directory for the binaries to
 * read, and their diagnostics, traces and coverage name that file. Nothing
 * here imports another module, so errors.ts can sanitise every envelope
 * without an import cycle.
 */

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
  /orygn-(?:opa-mcp|regal-mcp|schema)[^\\/\r\n]*[\\/]+(?:input\.rego|schema\.json|verified\.tar\.gz)/gi;

const SEGMENT_CHAR = /[^\\/:*?"<>|\r\n]/;
const isSeparator = (c: string): boolean => c === '/' || c === '\\';

/**
 * Where the path that ends at `markerStart` begins: walk back over
 * `<separators><segment>` pairs (a segment may hold a space, since a Windows
 * temp directory sits under the user's profile), then over a drive letter.
 * Nothing before `floor` is examined, so a scan over a whole string is linear.
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
      i = k;
      continue;
    }
    if (k === j && j >= floor + 1 && text[j] === ':' && /[A-Za-z]/.test(text[j - 1]!)) {
      start = j - 1;
    }
    break;
  }
  return start;
}

/** Replace every temp-file path wherever it sits inside `text`. */
export function sanitizeInlineText(text: string): string {
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
