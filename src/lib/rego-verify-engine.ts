/**
 * rego_verify engine - orchestrates the full verification pipeline:
 *
 *   Rego source
 *     → opa parse (JSON AST)
 *     → walkModule (IR)
 *     → inferTypes (Z3 sorts)
 *     → createInputVars (Z3 constants)
 *     → encodeRule (Z3 Bool formula)
 *     → negate / check property
 *     → solver.check() → sat | unsat | unknown
 *     → extractCounterexample (on sat)
 *     → VerifyResult
 */
import type { OpaModule } from './rego-ast-types.js';
import { walkModule } from './rego-ast-walker.js';
import { inferTypes } from './rego-type-inferencer.js';
import { createInputVars, encodeRule } from './rego-smt-encoder.js';
import { extractCounterexample, formatCounterexample, type CounterexampleInput } from './rego-counterexample.js';
import { describeProperty, type VerifyProperty } from './rego-property-parser.js';
import { getZ3 } from './rego-z3.js';

export type VerifyVerdict = 'proven' | 'counterexample' | 'inconclusive';

export interface VerifyResult {
  verdict: VerifyVerdict;
  property: string;
  rule: string;
  counterexample?: CounterexampleInput;
  counterexampleFormatted?: string;
  unsupportedConstructs: Array<{ constructType: string; description: string }>;
  warnings: string[];
  message: string;
}

/** Timeout for Z3 solver in milliseconds. */
const SOLVER_TIMEOUT_MS = 10_000;

/**
 * Run formal verification on a pre-parsed OPA module.
 * The caller must pass the JSON-parsed result of `opa parse --format=json`.
 */
export async function runVerify(
  ast: OpaModule,
  property: VerifyProperty,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const walked = walkModule(ast);
  const warnings: string[] = [];

  // Check for unsupported constructs in the target rule
  const targetClauses = walked.rules.get(property.ruleName);
  const unsupportedInRule = walked.unsupported.filter((u) =>
    // Report all unsupported constructs; we can't know which rule they came from.
    true,
  );

  if (targetClauses === undefined || targetClauses.length === 0) {
    return inconclusive(
      property,
      `Rule "${property.ruleName}" not found in the provided policy.`,
      unsupportedInRule,
      warnings,
    );
  }

  // Any clause with an unsupported expression makes verification incomplete.
  const hasUnsupportedInClauses = targetClauses.some((c) =>
    c.expressions.some((e) => e.kind === 'unsupported'),
  );
  if (hasUnsupportedInClauses) {
    return inconclusive(
      property,
      `Rule "${property.ruleName}" contains constructs that cannot be encoded in Z3 (e.g. negation-as-failure, comprehensions, built-ins beyond string/comparison ops). Verification is inconclusive.`,
      unsupportedInRule,
      warnings,
    );
  }

  // Type inference + Z3 setup
  const typeResult = inferTypes([...walked.rules.values()], walked.inputPaths);
  for (const conflict of typeResult.conflicts) {
    warnings.push(conflict.reason);
  }

  signal?.throwIfAborted();

  const Z3 = await getZ3();

  signal?.throwIfAborted();

  const inputVars = createInputVars(Z3, walked.inputPaths, typeResult.sorts);
  const ctx = { Z3, inputVars, sorts: typeResult.sorts };
  const encoded = encodeRule(targetClauses, ctx);
  warnings.push(...encoded.warnings);

  // Build the formula to check based on property kind
  const solver = new Z3.Solver();

  // Set timeout to prevent hanging on complex policies
  solver.set('timeout', SOLVER_TIMEOUT_MS);

  switch (property.kind) {
    case 'always_true':
      // Prove rule is always true: check if NOT(rule) is satisfiable.
      // SAT → counterexample (input where rule is false)
      // UNSAT → proven always true
      solver.add(Z3.Not(encoded.formula));
      break;
    case 'never_true':
      // Prove rule is never true: check if rule IS satisfiable.
      // SAT → counterexample (input where rule fires, violating "never")
      // UNSAT → proven never true
      solver.add(encoded.formula);
      break;
    case 'satisfiable':
      // Check if any input satisfies the rule.
      // SAT → witness found (not a bug, just a satisfying input)
      // UNSAT → rule is vacuously false / dead code
      solver.add(encoded.formula);
      break;
  }

  signal?.throwIfAborted();

  const solverResult = await solver.check();

  if (solverResult === 'unknown') {
    return inconclusive(
      property,
      `Z3 solver returned "unknown" (timeout or resource limit reached after ${SOLVER_TIMEOUT_MS}ms). The policy may be too complex for automated verification.`,
      unsupportedInRule,
      warnings,
    );
  }

  if (solverResult === 'unsat') {
    if (property.kind === 'satisfiable') {
      // No satisfying input found - rule is dead code
      return {
        verdict: 'proven',
        property: describeProperty(property),
        rule: property.ruleName,
        unsupportedConstructs: unsupportedInRule,
        warnings,
        message: `UNSATISFIABLE: No input can make "${property.ruleName}" true. The rule may be dead code or have contradictory conditions.`,
      };
    }
    // For always_true / never_true: UNSAT on the negation = property proven
    return {
      verdict: 'proven',
      property: describeProperty(property),
      rule: property.ruleName,
      unsupportedConstructs: unsupportedInRule,
      warnings,
      message: `PROVEN: ${describeProperty(property)}.`,
    };
  }

  // SAT: extract the model
  const model = solver.model();
  const ce = extractCounterexample(model, inputVars, typeResult.sorts);
  const ceFormatted = formatCounterexample(ce);

  if (property.kind === 'satisfiable') {
    return {
      verdict: 'proven',
      property: describeProperty(property),
      rule: property.ruleName,
      counterexample: ce,
      counterexampleFormatted: ceFormatted,
      unsupportedConstructs: unsupportedInRule,
      warnings,
      message: `SATISFIABLE: Found an input that makes "${property.ruleName}" true.\n\nWitness input:\n${ceFormatted}`,
    };
  }

  // always_true / never_true: SAT means we found a violation
  const ceLabel = property.kind === 'always_true'
    ? 'input where rule is FALSE'
    : 'input where rule is TRUE (violates "never")';

  return {
    verdict: 'counterexample',
    property: describeProperty(property),
    rule: property.ruleName,
    counterexample: ce,
    counterexampleFormatted: ceFormatted,
    unsupportedConstructs: unsupportedInRule,
    warnings,
    message: `COUNTEREXAMPLE: Property does NOT hold. Found ${ceLabel}:\n\n${ceFormatted}`,
  };
}

function inconclusive(
  property: VerifyProperty,
  reason: string,
  unsupportedConstructs: Array<{ constructType: string; description: string }>,
  warnings: string[],
): VerifyResult {
  return {
    verdict: 'inconclusive',
    property: describeProperty(property),
    rule: property.ruleName,
    unsupportedConstructs,
    warnings,
    message: `INCONCLUSIVE: ${reason}`,
  };
}
