/**
 * Extract a counterexample from a Z3 SAT model.
 *
 * Z3 variable names use "__" as path separator (e.g. "input__user__role").
 * This module reconstructs the nested input JSON that Z3 found satisfying,
 * strips the leading "input." prefix, and returns the nested object the
 * MCP caller can put directly into OPA's `--input` flag.
 *
 * Supported Z3 sorts: string, int, bool.
 * Uninterpreted sorts produce a placeholder string in the output.
 */
import type { init as Z3Init } from 'z3-solver';
import type { Z3Sort } from './rego-type-inferencer.js';
import { parseInputPath } from './rego-input-path.js';

type Z3Context = ReturnType<Awaited<ReturnType<typeof Z3Init>>['Context']>;
type Z3Model = ReturnType<InstanceType<Z3Context['Solver']>['model']>;
type Z3AnyExpr =
  | ReturnType<Z3Context['Bool']['const']>
  | ReturnType<Z3Context['Int']['const']>
  | ReturnType<Z3Context['String']['const']>;

export type CounterexampleInput = Record<string, unknown>;

/**
 * Extract the witness/counterexample input object from a Z3 model.
 *
 * @param model   - the SAT model from solver.model()
 * @param inputVars - map from path ("input.user.role") to Z3 constant
 * @param sorts   - inferred sort for each path
 * @returns nested JSON for the "input" field (leading "input." stripped)
 */
export function extractCounterexample(
  model: Z3Model,
  inputVars: Map<string, Z3AnyExpr>,
  sorts: Map<string, Z3Sort>,
  presenceVars?: Map<string, Z3AnyExpr>,
): CounterexampleInput {
  const flat: Record<string, unknown> = {};

  for (const [path, varExpr] of inputVars) {
    // A field the model chose to leave ABSENT must be omitted, not given a
    // value. Emitting one produced witnesses that did not reproduce: the tool
    // said "here is an input where the rule is false" while handing back an
    // input on which the rule was true, because the real reason it was false
    // was that the field was missing.
    const presence = presenceVars?.get(path);
    if (presence !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const isPresent = model.eval(presence, true).toString() === 'true';
      if (!isPresent) continue;
    }

    const sort = sorts.get(path) ?? 'string';
    const evaluated = model.eval(varExpr, true); // true = model completion

    let value: unknown;
    switch (sort) {
      case 'string':
        try {
          value = (evaluated as ReturnType<Z3Context['String']['const']>).asString();
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          value = evaluated.toString().replace(/^"|"$/g, '');
        }
        break;
      case 'real': {
        // Z3 prints negatives as "(- N)" and non-integers as "(/ p q)".
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const raw = evaluated.toString();
        const frac = /^\(\/\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)$/.exec(raw);
        if (frac) {
          value = Number(frac[1]) / Number(frac[2]);
        } else {
          value = Number(raw.replace(/\(-\s+([\d.]+)\)/, '-$1'));
        }
        break;
      }
      case 'bool':
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        value = evaluated.toString() === 'true';
        break;
      case 'uninterpreted':
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        value = `<opaque:${evaluated.toString()}>`;
        break;
    }

    flat[path] = value;
  }

  return buildNestedObject(flat);
}

/**
 * Convert rendered input paths to a nested object.
 * E.g. { 'input.user.role': "admin", 'input["a.b"]': "read" } →
 *      { user: { role: "admin" }, "a.b": "read" }
 * Splitting on dots put a quoted dotted key under nested objects, and the
 * witness did not satisfy the rule it was produced for.
 */
function buildNestedObject(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [renderedPath, value] of Object.entries(flat)) {
    const segments = parseInputPath(renderedPath);
    let cursor: Record<string, unknown> = result;

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      if (typeof cursor[seg] !== 'object' || cursor[seg] === null) {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as Record<string, unknown>;
    }

    const leaf = segments[segments.length - 1]!;
    cursor[leaf] = value;
  }

  return result;
}

/**
 * Format a counterexample as a human-readable string for the MCP response.
 */
export function formatCounterexample(ce: CounterexampleInput): string {
  return JSON.stringify({ input: ce }, null, 2);
}
