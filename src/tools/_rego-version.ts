/**
 * The `v0Compatible` input shared by every tool that has `opa` load Rego.
 *
 * OPA 1.x parses Rego v1 by default and refuses a policy written for 0.x
 * (`deny[msg] { ... }`, rules without `if`) until it is told to read v0. Each
 * tool declares the same field with the same text, so an agent comparing a
 * legacy policy with its migrated copy sees one option, not a dozen variants.
 */
import { z } from 'zod';

export const v0CompatibleField = z
  .boolean()
  .optional()
  .describe(
    'Read the policy as Rego v0 (`--v0-compatible`), the syntax OPA used before 1.0: rules without `if`, partial sets as `deny[msg] { ... }`. Needed for a policy that has not been migrated, which OPA 1.x otherwise refuses to load.',
  );
