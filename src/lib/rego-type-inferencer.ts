/**
 * Infer Z3 sorts for all input paths by examining how they are used in
 * the IR expressions across all rule clauses.
 *
 * Rules applied in priority order per path:
 *   1. Used in startswith/endswith/contains/regex_match → string
 *   2. Compared to a string literal → string
 *   3. Compared to a boolean literal → bool
 *   4. Compared to a number literal, or in gt/gte/lt/lte → int
 *   5. Conflicting evidence → uninterpreted (equality-only in encoder)
 *   6. No evidence → string (safe default: Z3 string theory is flexible)
 */
import type { VerifyExpr, VerifyRuleClause, VerifyValue } from './rego-ir.js';

export type Z3Sort = 'bool' | 'int' | 'string' | 'uninterpreted';

export interface TypeInferenceResult {
  sorts: Map<string, Z3Sort>;
  conflicts: Array<{ path: string; reason: string }>;
}

type SortEvidence = 'string' | 'int' | 'bool';

export function inferTypes(
  clauses: IterableIterator<VerifyRuleClause[]>,
  inputPaths: Map<string, string[]>,
): TypeInferenceResult {
  const evidence = new Map<string, Set<SortEvidence>>();

  // Initialize all known paths.
  for (const path of inputPaths.keys()) {
    evidence.set(path, new Set());
  }

  // Collect evidence from every clause of every rule.
  for (const ruleClauses of clauses) {
    for (const clause of ruleClauses) {
      for (const expr of clause.expressions) {
        collectEvidence(expr, evidence);
      }
    }
  }

  const sorts = new Map<string, Z3Sort>();
  const conflicts: Array<{ path: string; reason: string }> = [];

  for (const [path, ev] of evidence) {
    if (ev.size === 0) {
      sorts.set(path, 'string');
    } else if (ev.size === 1) {
      const only = [...ev][0]!;
      sorts.set(path, only);
    } else {
      conflicts.push({
        path,
        reason: `Path '${path}' used as both ${[...ev].join(' and ')}; using uninterpreted sort (equality only).`,
      });
      sorts.set(path, 'uninterpreted');
    }
  }

  return { sorts, conflicts };
}

function collectEvidence(expr: VerifyExpr, evidence: Map<string, Set<SortEvidence>>): void {
  switch (expr.kind) {
    case 'eq':
    case 'neq':
      addLiteralEvidence(expr.left, expr.right, evidence);
      addLiteralEvidence(expr.right, expr.left, evidence);
      break;
    case 'assign':
      // The value being assigned tells us the local's type, not an input path.
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      addSortEvidence(expr.left, 'int', evidence);
      addSortEvidence(expr.right, 'int', evidence);
      break;
    case 'startswith':
    case 'endswith':
      addSortEvidence(expr.str, 'string', evidence);
      break;
    case 'contains':
      addSortEvidence(expr.str, 'string', evidence);
      break;
    case 'regex_match':
      addSortEvidence(expr.str, 'string', evidence);
      break;
    case 'bool_check':
      addSortEvidence(expr.ref, 'bool', evidence);
      break;
    default:
      break;
  }
}

function addLiteralEvidence(
  subject: VerifyValue,
  comparand: VerifyValue,
  evidence: Map<string, Set<SortEvidence>>,
): void {
  if (subject.kind !== 'input_ref') return;
  switch (comparand.kind) {
    case 'literal_string':
      addSortEvidence(subject, 'string', evidence);
      break;
    case 'literal_number':
      addSortEvidence(subject, 'int', evidence);
      break;
    case 'literal_bool':
      addSortEvidence(subject, 'bool', evidence);
      break;
    default:
      break;
  }
}

function addSortEvidence(
  value: VerifyValue,
  sort: SortEvidence,
  evidence: Map<string, Set<SortEvidence>>,
): void {
  if (value.kind !== 'input_ref') return;
  const ev = evidence.get(value.path);
  if (ev !== undefined) ev.add(sort);
}
