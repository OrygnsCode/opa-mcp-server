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
 *
 * Local variable aliases (x := input.path) are resolved so that sort
 * evidence from comparisons on x propagates back to input.path.
 */
import type { VerifyExpr, VerifyRuleClause, VerifyValue } from './rego-ir.js';

export type Z3Sort = 'bool' | 'int' | 'string' | 'uninterpreted';

export interface TypeInferenceResult {
  sorts: Map<string, Z3Sort>;
  conflicts: Array<{ path: string; reason: string }>;
}

type SortEvidence = 'string' | 'int' | 'bool';

export function inferTypes(
  clauses: VerifyRuleClause[][],
  inputPaths: Map<string, string[]>,
): TypeInferenceResult {
  // Pass 1: collect every local-variable assignment as a raw VerifyValue.
  // This covers both direct (x := input.age) and chained (x := y; y := input.age)
  // assignments. resolveToInputPath follows chains transitively.
  const localAssignments = new Map<string, VerifyValue>(); // local_var_name → assigned VerifyValue
  for (const ruleClauses of clauses) {
    for (const clause of ruleClauses) {
      for (const expr of clause.expressions) {
        if (expr.kind === 'assign') {
          localAssignments.set(expr.local, expr.value);
        }
      }
    }
  }

  // Initialize evidence sets from all known paths.
  const evidence = new Map<string, Set<SortEvidence>>();
  for (const path of inputPaths.keys()) {
    evidence.set(path, new Set());
  }

  // Pass 2: collect sort evidence from all expressions, resolving locals via the
  // assignment map (transitively, so x := y; y := input.age propagates correctly).
  for (const ruleClauses of clauses) {
    for (const clause of ruleClauses) {
      for (const expr of clause.expressions) {
        collectEvidence(expr, evidence, localAssignments);
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

function collectEvidence(
  expr: VerifyExpr,
  evidence: Map<string, Set<SortEvidence>>,
  localAssignments: Map<string, VerifyValue>,
): void {
  switch (expr.kind) {
    case 'eq':
    case 'neq':
      addLiteralEvidence(expr.left, expr.right, evidence, localAssignments);
      addLiteralEvidence(expr.right, expr.left, evidence, localAssignments);
      break;
    case 'assign':
      // The local variable itself is not an input path; evidence flows via localAssignments.
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      addSortEvidence(expr.left, 'int', evidence, localAssignments);
      addSortEvidence(expr.right, 'int', evidence, localAssignments);
      break;
    case 'startswith':
    case 'endswith':
      addSortEvidence(expr.str, 'string', evidence, localAssignments);
      break;
    case 'contains':
      addSortEvidence(expr.str, 'string', evidence, localAssignments);
      break;
    case 'regex_match':
      addSortEvidence(expr.str, 'string', evidence, localAssignments);
      break;
    case 'bool_check':
      addSortEvidence(expr.ref, 'bool', evidence, localAssignments);
      break;
    default:
      break;
  }
}

/**
 * Follow an assignment chain from a VerifyValue back to an input path.
 *
 * Handles transitive local-variable chains:
 *   x := y; y := input.age  →  resolveToInputPath(x) = 'input.age'
 *
 * Returns undefined when the chain terminates at a literal, an unaliased
 * local, a data ref, or a cycle.
 */
function resolveToInputPath(
  value: VerifyValue,
  localAssignments: Map<string, VerifyValue>,
): string | undefined {
  const visited = new Set<string>();
  let current: VerifyValue = value;

  while (true) {
    if (current.kind === 'input_ref') return current.path;
    if (current.kind !== 'local_var') return undefined; // literal or unsupported
    if (visited.has(current.name)) return undefined; // cycle guard
    visited.add(current.name);
    const next = localAssignments.get(current.name);
    if (next === undefined) return undefined; // unassigned local
    current = next;
  }
}

function addLiteralEvidence(
  subject: VerifyValue,
  comparand: VerifyValue,
  evidence: Map<string, Set<SortEvidence>>,
  localAssignments: Map<string, VerifyValue>,
): void {
  const path = resolveToInputPath(subject, localAssignments);
  if (path === undefined) return;
  switch (comparand.kind) {
    case 'literal_string':
      addPathEvidence(path, 'string', evidence);
      break;
    case 'literal_number':
      addPathEvidence(path, 'int', evidence);
      break;
    case 'literal_bool':
      addPathEvidence(path, 'bool', evidence);
      break;
    default:
      break;
  }
}

function addSortEvidence(
  value: VerifyValue,
  sort: SortEvidence,
  evidence: Map<string, Set<SortEvidence>>,
  localAssignments: Map<string, VerifyValue>,
): void {
  const path = resolveToInputPath(value, localAssignments);
  if (path === undefined) return;
  addPathEvidence(path, sort, evidence);
}

function addPathEvidence(
  path: string,
  sort: SortEvidence,
  evidence: Map<string, Set<SortEvidence>>,
): void {
  const ev = evidence.get(path);
  if (ev !== undefined) ev.add(sort);
}
