/**
 * The `v0Compatible` input shared by every tool that has `opa` load Rego.
 *
 * OPA 1.x parses Rego v1 by default and refuses a policy written for 0.x
 * (`deny[msg] { ... }`, rules without `if`) until it is told to read v0. Each
 * tool declares the same field with the same text, so an agent comparing a
 * legacy policy with its migrated copy sees one option, not a dozen variants.
 */
import { z } from 'zod';

/**
 * What OPA says about a pre-1.0 policy read as v1: a rule body without `if`,
 * a partial set without `contains`, or a call to a built-in v1 removed.
 */
export const PRE_V1_ERRORS =
  /`(if|contains)` keyword is required|deprecated built-in function calls/;

/** What to do about a policy that failed for being pre-1.0 Rego. */
export const PRE_V1_HINT =
  'This looks like Rego v0, the syntax before OPA 1.0. Pass `v0Compatible: true` to read it as v0, or convert it with rego_migrate_v1.';

/** Whether any of these diagnostics (strings, or objects with a message) is a pre-1.0 failure. */
export function mentionsPreV1(...diagnostics: unknown[]): boolean {
  return diagnostics.some((d) =>
    PRE_V1_ERRORS.test(typeof d === 'string' ? d : JSON.stringify(d ?? '')),
  );
}

export const v0CompatibleField = z
  .boolean()
  .optional()
  .describe(
    'Read the policy as Rego v0 (`--v0-compatible`), the syntax OPA used before 1.0: rules without `if`, partial sets as `deny[msg] { ... }`. Needed for a policy that has not been migrated, which OPA 1.x otherwise refuses to load. Where the tool also takes a query, the query is read as v0 too, with the future keywords imported so `in`, `every` and `some x in` still work in it.',
  );
