/**
 * Re-hydrate structured tool arguments that arrive as JSON strings.
 *
 * MCP clients (Claude Code, Claude Desktop, and others) serialize a tool
 * argument declared with a permissive schema -- `z.unknown()` -- into a JSON
 * string before sending it over the wire. A handler that then embeds such a
 * value into an HTTP request body or pipes it to `opa eval` receives a string
 * where it expected an object or array, and silently produces a wrong result:
 * a decision evaluated against a string input falls through to the default,
 * and an array stored at a data path is corrupted into a string.
 *
 * `coerceJsonArg` repairs this at the boundary: when the value is a string that
 * parses to a JSON object or array, it returns the parsed value; otherwise it
 * returns the value unchanged. Scalars (including strings that happen to be
 * valid JSON like `"42"` or `"true"`) and non-JSON strings are left as-is, so a
 * genuinely-string argument is never silently retyped.
 */
export function coerceJsonArg(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : value;
  } catch {
    return value;
  }
}
