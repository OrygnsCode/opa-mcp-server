/**
 * Reading a stream of concatenated JSON values.
 *
 * `opa test --count N` prints one pretty-printed JSON array per repetition,
 * back to back, so the whole output is neither a single JSON value nor NDJSON:
 *
 *     [
 *       { "name": "test_a" }
 *     ]
 *     [
 *       { "name": "test_a" }
 *     ]
 *
 * `JSON.parse` rejects that, and parsing line by line finds no complete value
 * on any line. Splitting into top-level values is the only way to read it.
 */

/**
 * Split `text` into its top-level JSON values, in order.
 *
 * Scans for balanced brackets while tracking string state, so a bracket or a
 * brace inside a string literal cannot end a value early. Returns an empty
 * array when nothing parses, so a caller can treat that exactly as it treats
 * unparseable output.
 */
export function parseJsonValues<T = unknown>(text: string): T[] {
  const values: T[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '[' || ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === ']' || ch === '}') {
      if (depth === 0) continue; // stray closer; nothing is open
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          values.push(JSON.parse(text.slice(start, i + 1)) as T);
        } catch {
          // A malformed value is skipped rather than discarding the rest.
        }
        start = -1;
      }
    }
  }

  return values;
}
