/**
 * Rendering of an `input` path that is injective over its segments.
 *
 * Joining segments with dots made `input["a.b"]` and `input.a.b` the same
 * string, so the two fields shared one Z3 constant and the witness for one
 * was rebuilt as the other. A segment that is a plain identifier is written
 * `.seg`; any other is written `["..."]` with JSON quoting, which is how Rego
 * itself spells it, and the two forms cannot collide.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Render `["user", "a.b"]` as `input.user["a.b"]`. */
export function renderInputPath(segments: readonly string[]): string {
  let out = 'input';
  for (const seg of segments) {
    out += IDENT.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/**
 * Parse a rendered path back into its segments. The inverse of
 * renderInputPath; anything it did not produce is read as best it can, one
 * dot-separated segment at a time, so a plain `input.a.b` still works, and a
 * bracket without a well-formed string inside is taken as literal text
 * rather than thrown on.
 */
export function parseInputPath(path: string): string[] {
  let rest = /^input(?=[.[]|$)/.test(path) ? path.slice('input'.length) : path;
  const segments: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const m = /^\.([^.[]+)/.exec(rest);
      if (!m) {
        // A dot with no name after it is not a rendering of ours either.
        segments.push(rest);
        break;
      }
      segments.push(m[1]!);
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('["')) {
      // A JSON string literal: find its closing quote, honouring escapes.
      let i = 2;
      while (i < rest.length && rest[i] !== '"') i += rest[i] === '\\' ? 2 : 1;
      const closed = i < rest.length && rest[i + 1] === ']';
      let literal: unknown;
      if (closed) {
        try {
          literal = JSON.parse(rest.slice(1, i + 1));
        } catch {
          literal = undefined;
        }
      }
      if (typeof literal !== 'string') {
        segments.push(rest);
        break;
      }
      segments.push(literal);
      rest = rest.slice(i + 2);
    } else {
      // Not a rendering of ours; take the remainder as one segment.
      segments.push(rest);
      break;
    }
  }
  return segments;
}
