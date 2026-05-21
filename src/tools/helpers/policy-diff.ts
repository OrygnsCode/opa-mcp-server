/**
 * `rego_policy_diff` -- evaluate the same query against two policies and
 * compare the results.
 *
 * Both evaluations run in parallel. The output surfaces:
 *   - `resultA` / `resultB`: the extracted expression value from each eval
 *     (undefined when the query is undefined for that policy)
 *   - `equal`: true when the results are structurally identical
 *   - `changedPaths`: dot/bracket paths where values differ, e.g.
 *     ["allow", "violations[0].code"]
 *
 * Typical use case: compare a refactored policy against the original to
 * verify behavioral equivalence (or intentional divergence) for a
 * representative input.
 *
 * Each side accepts either inline source (sourceA / sourceB) or a file /
 * directory path (pathA / pathB). File paths must be within allowed roots.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoPolicyDiffInput = {
  sourceA: z
    .string()
    .optional()
    .describe('Inline Rego source for policy A. Mutually exclusive with pathA.'),
  pathA: z
    .string()
    .optional()
    .describe(
      'File or directory path for policy A. Must be inside an allowed root. Mutually exclusive with sourceA.',
    ),
  sourceB: z
    .string()
    .optional()
    .describe('Inline Rego source for policy B. Mutually exclusive with pathB.'),
  pathB: z
    .string()
    .optional()
    .describe(
      'File or directory path for policy B. Must be inside an allowed root. Mutually exclusive with sourceB.',
    ),
  query: z
    .string()
    .min(1)
    .describe('The query to evaluate against both policies, e.g. "data.example.allow".'),
  input: z
    .unknown()
    .optional()
    .describe('Inline input document (JSON). Mutually exclusive with inputPath.'),
  inputPath: z
    .string()
    .optional()
    .describe(
      'Path to a JSON input file. Must be inside an allowed root. Mutually exclusive with input.',
    ),
  dataPaths: z
    .array(z.string())
    .optional()
    .describe(
      'Additional data or policy paths loaded for both evaluations. Each must be inside an allowed root.',
    ),
};

/** Raw value extracted from one side of an OPA eval result. */
type ResultValue = unknown;

export interface RegoPolicyDiffOutput {
  /** The query that was evaluated. */
  query: string;
  /** True when resultA and resultB are structurally identical. */
  equal: boolean;
  /** Value extracted from policy A's evaluation. Undefined when the query is undefined for that policy. */
  resultA: ResultValue;
  /** Value extracted from policy B's evaluation. */
  resultB: ResultValue;
  /**
   * Dot/bracket paths that differ between resultA and resultB.
   * Empty when equal is true. "." denotes a root-level scalar difference.
   */
  changedPaths: string[];
}

/**
 * Extract the meaningful value from `opa eval --format=json` stdout.
 *
 * - Single result, single expression: returns expressions[0].value
 * - Multiple result rows (iteration binding): returns the full result array
 * - Empty result (`{}` or `{"result":[]}`) or parse failure: returns undefined
 */
export function extractResultValue(stdout: string): ResultValue {
  const text = stdout.trim();
  if (!text || text === '{}') return undefined;

  try {
    const parsed = JSON.parse(text) as {
      result?: Array<{
        expressions?: Array<{ value?: unknown }>;
      }>;
    };
    if (!parsed.result || parsed.result.length === 0) return undefined;

    if (parsed.result.length === 1) {
      const exprs = parsed.result[0]?.expressions ?? [];
      if (exprs.length === 1) return exprs[0]?.value;
      return exprs.map((e) => e?.value);
    }

    // Multiple result rows from iteration -- return the full result array so
    // the caller can compare the complete set of solutions.
    return parsed.result;
  } catch {
    return undefined;
  }
}

/**
 * Return the set of dot/bracket paths where `a` and `b` differ.
 *
 * Rules:
 * - Identical values (JSON.stringify equal): []
 * - Different types, nulls, or undefined on either side: [path || '.']
 * - Both arrays with different lengths: [path || '.']
 * - Both arrays, same length: recurse per index using `[i]` notation
 * - Both plain objects: recurse per key using dot notation
 */
export function diffValues(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];

  const label = path || '.';

  if (
    a === null ||
    b === null ||
    a === undefined ||
    b === undefined ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return [label];
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [label];
    const diffs: string[] = [];
    for (let i = 0; i < a.length; i++) {
      diffs.push(...diffValues(a[i], b[i], `${path}[${i}]`));
    }
    return diffs;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
  const diffs: string[] = [];

  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;
    diffs.push(...diffValues(objA[key], objB[key], childPath));
  }

  return diffs;
}

export function registerRegoPolicyDiff(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_policy_diff',
    {
      title: 'Diff two Rego policies',
      description:
        'Evaluate the same query against two policies (or two versions of the same policy) and compare the results. Both evaluations run in parallel. Returns `equal: true/false`, the raw result from each side, and `changedPaths` -- the dot/bracket paths that differ. Useful for verifying that a refactor preserves behavior, or understanding exactly where two policies diverge. Each side takes either inline source (sourceA/sourceB) or a file/directory path (pathA/pathB). The same input and query are used for both evaluations.',
      inputSchema: RegoPolicyDiffInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sourceA, pathA, sourceB, pathB, query, input, inputPath, dataPaths }, { signal }) => {
      return withToolEnvelope<RegoPolicyDiffOutput>(config, async () => {
        // ── Input validation ──────────────────────────────────────────────
        if (sourceA === undefined && pathA === undefined) {
          return err('INVALID_INPUT', 'One of sourceA or pathA is required.');
        }
        if (sourceA !== undefined && pathA !== undefined) {
          return err('INVALID_INPUT', 'Provide either sourceA or pathA, not both.');
        }
        if (sourceB === undefined && pathB === undefined) {
          return err('INVALID_INPUT', 'One of sourceB or pathB is required.');
        }
        if (sourceB !== undefined && pathB !== undefined) {
          return err('INVALID_INPUT', 'Provide either sourceB or pathB, not both.');
        }
        if (input !== undefined && inputPath !== undefined) {
          return err('INVALID_INPUT', 'Provide either input or inputPath, not both.');
        }

        // ── Path validation ───────────────────────────────────────────────
        let resolvedPathA: string | undefined;
        if (pathA !== undefined) {
          const v = validatePaths([pathA], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedPathA = v.resolved[0];
        }

        let resolvedPathB: string | undefined;
        if (pathB !== undefined) {
          const v = validatePaths([pathB], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedPathB = v.resolved[0];
        }

        let resolvedInputPath: string | undefined;
        if (inputPath !== undefined) {
          const v = validatePaths([inputPath], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedInputPath = v.resolved[0];
        }

        let resolvedDataPaths: string[] = [];
        if (dataPaths && dataPaths.length > 0) {
          const v = validatePaths(dataPaths, config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedDataPaths = v.resolved;
        }

        // ── Build eval inputs ─────────────────────────────────────────────
        const commonOpts = {
          query,
          ...(input !== undefined ? { input } : {}),
          ...(resolvedInputPath !== undefined ? { inputPath: resolvedInputPath } : {}),
        };

        const evalInputA =
          sourceA !== undefined
            ? { ...commonOpts, source: sourceA, paths: resolvedDataPaths }
            : { ...commonOpts, paths: [...resolvedDataPaths, resolvedPathA!] };

        const evalInputB =
          sourceB !== undefined
            ? { ...commonOpts, source: sourceB, paths: resolvedDataPaths }
            : { ...commonOpts, paths: [...resolvedDataPaths, resolvedPathB!] };

        // ── Run both evals in parallel ─────────────────────────────────────
        const [resultA, resultB] = await Promise.all([
          opa.eval(evalInputA, signal),
          opa.eval(evalInputB, signal),
        ]);

        // ── Error mapping (check A first, then B) ─────────────────────────
        const binaryFailure = mapSubprocessFailure(resultA, 'opa');
        if (binaryFailure) return binaryFailure;

        if (resultA.exitCode !== 0) {
          return err('INVALID_REGO', 'Policy A failed to evaluate.', {
            details: { policy: 'A', stderr: resultA.stderr.trim(), exitCode: resultA.exitCode },
          });
        }

        const binaryFailureB = mapSubprocessFailure(resultB, 'opa');
        if (binaryFailureB) return binaryFailureB;

        if (resultB.exitCode !== 0) {
          return err('INVALID_REGO', 'Policy B failed to evaluate.', {
            details: { policy: 'B', stderr: resultB.stderr.trim(), exitCode: resultB.exitCode },
          });
        }

        // ── Extract and compare ───────────────────────────────────────────
        const valueA = extractResultValue(resultA.stdout);
        const valueB = extractResultValue(resultB.stdout);
        const changedPaths = diffValues(valueA, valueB);

        return ok<RegoPolicyDiffOutput>({
          query,
          equal: changedPaths.length === 0,
          resultA: valueA,
          resultB: valueB,
          changedPaths,
        });
      });
    },
  );
}
