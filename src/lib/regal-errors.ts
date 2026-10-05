/**
 * Reading Regal's report of a module it could not parse.
 *
 * `regal lint` prints no results when a module does not parse; it writes a
 * JSON error to stderr naming the first failure:
 *
 *   {"errors": ["... failed to parse 2 module(s) — first error: 1 error
 *     occurred: C:\\p\\broken.rego:4: rego_parse_error: unexpected eof token ..."]}
 *
 * Reporting that as "regal produced no parseable JSON" (UNKNOWN_ERROR) hid a
 * plain syntax error behind what read as a broken tool.
 */
import { err } from './errors.js';
import { sanitizeInlinePath } from './tool-helpers.js';
import type { ToolEnvelope } from '../types.js';

export interface RegalParseFailure {
  /** The module that failed, as Regal named it. */
  file: string;
  row: number;
  /** OPA's error code, such as `rego_parse_error`. */
  code: string;
  message: string;
  /** How many modules failed; Regal names only the first. */
  modules: number;
}

// A drive letter counts only when a separator follows it, so the `d:` that
// ends "occurred:" is not read as the drive of the next word.
const FAILURE =
  /((?:\b[A-Za-z]:[\\/])?[^\s:"][^:\n"]*?\.rego|<inline>):(\d+): (rego_[a-z_]+): ([^\n"]+)/;

export function regalParseFailure(stderr: string): RegalParseFailure | undefined {
  // The message sits inside a JSON string; decode it so paths lose their escaping.
  let text = stderr;
  try {
    const parsed = JSON.parse(stderr) as { errors?: unknown[] };
    if (Array.isArray(parsed.errors)) text = parsed.errors.map(String).join('\n');
  } catch {
    // Not JSON: match the raw text.
  }
  const m = FAILURE.exec(text);
  if (!m) return undefined;
  const count = /failed to parse (\d+) module/.exec(text);
  return {
    file: m[1]!.trim(),
    row: Number(m[2]),
    code: m[3]!,
    message: m[4]!.trim(),
    modules: count ? Number(count[1]) : 1,
  };
}

/** The INVALID_REGO envelope for a module Regal could not parse. */
export function regalParseError(f: RegalParseFailure): ToolEnvelope<never> {
  const file = sanitizeInlinePath(f.file);
  const others = f.modules > 1 ? ` ${f.modules - 1} more module(s) also failed to parse.` : '';
  return err(
    'INVALID_REGO',
    `Regal could not parse ${file} at row ${f.row}: ${f.message}.${others}`,
    {
      hint: 'Fix the syntax error first; rego_check reports every parse error at once.',
      details: { file, row: f.row, code: f.code, message: f.message, modulesFailed: f.modules },
    },
  );
}
