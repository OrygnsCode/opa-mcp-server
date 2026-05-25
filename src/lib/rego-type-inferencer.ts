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
  // Pass 1: collect local-variable → input-path aliases from assign expressions.
  // This lets sort evidence from "x >= 21" propagate back to "input.age"
  // when the clause contains "x := input.age".
  const localAliases = new Map<string, string>(); // local_var_name → input_ref_path
  for (const ruleClauses of clauses) {
    for (const clause of ruleClauses) {
      for (const expr of clause.expressions) {
        if (expr.kind === 'assign' && expr.value.kind === 'input_ref') {
          localAliases.set(expr.local, expr.value.path);
        }
      }
    }
  }

  // Initialize evidence sets from all known paths.
  const evidence = new Map<string, Set<SortEvidence>>();
  for (const path of inputPaths.keys()) {
    evidence.set(path, new Set());
  }

  // Pass 2: collect sort evidence from all expressions, resolving locals via aliases.
  for (const ruleClauses of clauses) {
    for (const clause of ruleClauses) {
      for (const expr of clause.expressions) {
        collectEvidence(expr, evidence, localAliases);
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
  localAliases: Map<string, string>,
): void {
  switch (expr.kind) {
    case 'eq':
    case 'neq':
      addLiteralEvidence(expr.left, expr.right, evidence, localAliases);
      addLiteralEvidence(expr.right, expr.left, evidence, localAliases);
      break;
    case 'assign':
      // The local variable itself is not an input path; evidence flows via localAliases.
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      addSortEvidence(expr.left, 'int', evidence, localAliases);
      addSortEvidence(expr.right, 'int', evidence, localAliases);
      break;
    case 'startswith':
    case 'endswith':
      addSortEvidence(expr.str, 'string', evidence, localAliases);
      break;
    case 'contains':
      addSortEvidence(expr.str, 'string', evidence, localAliases);
      break;
    case 'regex_match':
      addSortEvidence(expr.str, 'string', evidence, localAliases);
      break;
    case 'bool_check':
      addSortEvidence(expr.ref, 'bool', evidence, localAliases);
      break;
    default:
      break;
  }
}

/**
 * Resolve a VerifyValue to an input path string.
 * Returns undefined for literals, local vars with no alias, etc.
 */
function resolveToInputPath(
  value: VerifyValue,
  localAliases: Map<string, string>,
): string | undefined {
  if (value.kind === 'input_ref') return value.path;
  if (value.kind === 'local_var') return localAliases.get(value.name);
  return undefined;
}

function addLiteralEvidence(
  subject: VerifyValue,
  comparand: VerifyValue,
  evidence: Map<string, Set<SortEvidence>>,
  localAliases: Map<string, string>,
): void {
  const path = resolveToInputPath(subject, localAliases);
  if (path === undefined) return;
  switch (comparand.kind) {
    case 'literal_string': addPathEvidence(path, 'string', evidence); break;
    case 'literal_number': addPathEvidence(path, 'int', evidence); break;
    case 'literal_bool': addPathEvidence(path, 'bool', evidence); break;
    default: break;
  }
}

function addSortEvidence(
  value: VerifyValue,
  sort: SortEvidence,
  evidence: Map<string, Set<SortEvidence>>,
  localAliases: Map<string, string>,
): void {
  const path = resolveToInputPath(value, localAliases);
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
