/**
 * SMT encoder: translates a VerifyWalkResult into Z3 formulas.
 *
 * The encoder knows Z3 API details but knows nothing about OPA AST.
 * It receives typed IR from the walker and produces Z3 Bool expressions.
 *
 * Design:
 *   - One Z3 constant per input path, typed by the type inferencer.
 *   - One Z3 constant per local variable, scoped per clause.
 *   - Each clause body becomes an AND of its expression formulas.
 *   - The full rule formula is an OR of all its clause formulas.
 *   - Uninterpreted sorts get a dedicated Z3 uninterpreted sort and
 *     can only participate in equality/inequality constraints.
 */
import type { init as Z3Init } from 'z3-solver';

import type { Z3Sort } from './rego-type-inferencer.js';
import type { VerifyExpr, VerifyRuleClause, VerifyValue } from './rego-ir.js';

type Z3Context = ReturnType<Awaited<ReturnType<typeof Z3Init>>['Context']>;
type Z3Bool = ReturnType<Z3Context['Bool']['const']>;
type Z3AnyExpr =
  | Z3Bool
  | ReturnType<Z3Context['Int']['const']>
  | ReturnType<Z3Context['String']['const']>;

export interface EncoderContext {
  Z3: Z3Context;
  inputVars: Map<string, Z3AnyExpr>;
  sorts: Map<string, Z3Sort>;
  /** Per-call unique prefix for all Z3 constant names. Prevents sort conflicts
   *  when the same input path is inferred as different sorts across calls in the
   *  same Z3 singleton context (e.g. one policy treats input.x as string, another
   *  as int). Each call gets a fresh prefix so constants never collide. */
  callId: string;
}

export interface EncodedRule {
  formula: Z3Bool;
  warnings: string[];
}

/**
 * Create Z3 constants for all input paths based on inferred sorts.
 * Each constant name is prefixed with callId to ensure uniqueness across
 * verification calls in the same Z3 singleton context.
 */
export function createInputVars(
  Z3: Z3Context,
  inputPaths: Map<string, string[]>,
  sorts: Map<string, Z3Sort>,
  callId: string,
): Map<string, Z3AnyExpr> {
  const vars = new Map<string, Z3AnyExpr>();

  for (const path of inputPaths.keys()) {
    const sort = sorts.get(path) ?? 'string';
    const varName = `${callId}_${pathToVarName(path)}`;

    switch (sort) {
      case 'string':
        vars.set(path, Z3.String.const(varName));
        break;
      case 'int':
        vars.set(path, Z3.Int.const(varName));
        break;
      case 'bool':
        vars.set(path, Z3.Bool.const(varName));
        break;
      case 'uninterpreted': {
        // Declare a fresh uninterpreted sort per path; equality-only semantics.
        const s = Z3.Sort.declare(varName + '_sort');
        vars.set(path, Z3.Const(varName, s) as unknown as Z3AnyExpr);
        break;
      }
    }
  }

  return vars;
}

/**
 * Encode a complete rule as a Z3 Bool formula.
 * rule_formula = clause_0 OR clause_1 OR ... OR clause_n
 */
export function encodeRule(clauses: VerifyRuleClause[], ctx: EncoderContext): EncodedRule {
  const { Z3 } = ctx;
  const warnings: string[] = [];

  const clauseFormulas: Z3Bool[] = [];
  for (const clause of clauses) {
    const localVars = new Map<string, Z3AnyExpr>();
    const localSorts = new Map<string, Z3Sort>();
    const clauseResult = encodeClause(clause, ctx, localVars, localSorts);
    if (clauseResult.formula !== null) {
      clauseFormulas.push(clauseResult.formula);
    }
    warnings.push(...clauseResult.warnings);
  }

  if (clauseFormulas.length === 0) {
    return { formula: Z3.Bool.val(false), warnings };
  }
  if (clauseFormulas.length === 1) {
    return { formula: clauseFormulas[0]!, warnings };
  }

  return { formula: Z3.Or(...clauseFormulas), warnings };
}

interface ClauseResult {
  formula: Z3Bool | null;
  warnings: string[];
}

function encodeClause(
  clause: VerifyRuleClause,
  ctx: EncoderContext,
  localVars: Map<string, Z3AnyExpr>,
  localSorts: Map<string, Z3Sort>,
): ClauseResult {
  const { Z3 } = ctx;
  const warnings: string[] = [];
  const conjuncts: Z3Bool[] = [];

  for (const expr of clause.expressions) {
    if (expr.kind === 'unsupported') continue; // engine skips these clauses already

    const encoded = encodeExpr(expr, ctx, localVars, localSorts, warnings);
    if (encoded !== null) {
      conjuncts.push(encoded);
    }
  }

  if (conjuncts.length === 0) {
    // Empty body (no constraints) = always true.
    return { formula: Z3.Bool.val(true), warnings };
  }
  if (conjuncts.length === 1) {
    return { formula: conjuncts[0]!, warnings };
  }

  return { formula: Z3.And(...conjuncts), warnings };
}

function encodeExpr(
  expr: VerifyExpr,
  ctx: EncoderContext,
  localVars: Map<string, Z3AnyExpr>,
  localSorts: Map<string, Z3Sort>,
  warnings: string[],
): Z3Bool | null {
  const { Z3 } = ctx;

  switch (expr.kind) {
    case 'eq': {
      const l = resolveValue(expr.left, ctx, localVars, localSorts, warnings);
      const r = resolveValue(expr.right, ctx, localVars, localSorts, warnings);
      if (l === null || r === null) return null;
      return Z3.Eq(l, r);
    }
    case 'neq': {
      const l = resolveValue(expr.left, ctx, localVars, localSorts, warnings);
      const r = resolveValue(expr.right, ctx, localVars, localSorts, warnings);
      if (l === null || r === null) return null;
      return Z3.Not(Z3.Eq(l, r));
    }
    case 'gt': {
      const l = resolveValue(expr.left, ctx, localVars, localSorts, warnings);
      const r = resolveValue(expr.right, ctx, localVars, localSorts, warnings);
      if (l === null || r === null) return null;
      return Z3.GT(
        l as ReturnType<Z3Context['Int']['const']>,
        r as ReturnType<Z3Context['Int']['const']>,
      );
    }
    case 'gte': {
      const l = resolveValue(expr.left, ctx, localVars, localSorts, warnings);
      const r = resolveValue(expr.right, ctx, localVars, localSorts, warnings);
      if (l === null || r === null) return null;
      return Z3.GE(
        l as ReturnType<Z3Context['Int']['const']>,
        r as ReturnType<Z3Context['Int']['const']>,
      );
    }
    case 'lt': {
      const l = resolveValue(expr.left, ctx, localVars, localSorts, warnings);
      const r = resolveValue(expr.right, ctx, localVars, localSorts, warnings);
      if (l === null || r === null) return null;
      return Z3.LT(
        l as ReturnType<Z3Context['Int']['const']>,
        r as ReturnType<Z3Context['Int']['const']>,
      );
    }
    case 'lte': {
      const l = resolveValue(expr.left, ctx, localVars, localSorts, warnings);
      const r = resolveValue(expr.right, ctx, localVars, localSorts, warnings);
      if (l === null || r === null) return null;
      return Z3.LE(
        l as ReturnType<Z3Context['Int']['const']>,
        r as ReturnType<Z3Context['Int']['const']>,
      );
    }
    case 'startswith': {
      const str = resolveValue(expr.str, ctx, localVars, localSorts, warnings);
      const prefix = resolveValue(expr.prefix, ctx, localVars, localSorts, warnings);
      if (str === null || prefix === null) return null;
      // Z3 string API: prefix.prefixOf(str) means "prefix is a prefix of str"
      type StringExpr = ReturnType<Z3Context['String']['const']>;
      return (prefix as StringExpr).prefixOf(str as StringExpr);
    }
    case 'endswith': {
      const str = resolveValue(expr.str, ctx, localVars, localSorts, warnings);
      const suffix = resolveValue(expr.suffix, ctx, localVars, localSorts, warnings);
      if (str === null || suffix === null) return null;
      type StringExpr = ReturnType<Z3Context['String']['const']>;
      return (suffix as StringExpr).suffixOf(str as StringExpr);
    }
    case 'contains': {
      const str = resolveValue(expr.str, ctx, localVars, localSorts, warnings);
      const sub = resolveValue(expr.sub, ctx, localVars, localSorts, warnings);
      if (str === null || sub === null) return null;
      type StringExpr = ReturnType<Z3Context['String']['const']>;
      return (str as StringExpr).contains(sub as StringExpr);
    }
    case 'regex_match': {
      const str = resolveValue(expr.str, ctx, localVars, localSorts, warnings);
      if (str === null) return null;
      type StringExpr = ReturnType<Z3Context['String']['const']>;

      if (expr.pattern.kind === 'literal_string') {
        // Walker guarantees only simple patterns reach here (see isSimpleRegexPattern).
        const simplified = tryRegexAsStringConstraint(Z3, str as StringExpr, expr.pattern.value);
        if (simplified !== null) return simplified;
        // Defensive: should not be reached in normal flow.
        warnings.push(
          `regex_match pattern '${expr.pattern.value}' bypassed walker guard; constraint skipped.`,
        );
        return null;
      }

      // Variable patterns are marked unsupported by the walker and never reach here.
      warnings.push('regex_match with variable pattern is not encodable; constraint skipped.');
      return null;
    }
    case 'bool_check': {
      const ref = resolveValue(expr.ref, ctx, localVars, localSorts, warnings);
      if (ref === null) return null;
      // Treat as: ref == true
      return Z3.Eq(ref, Z3.Bool.val(true));
    }
    case 'assign': {
      // x := value → determine the sort from the RHS, create a correctly-typed
      // local constant, then constrain it to equal the value.
      const rhsSort = sortOfVerifyValue(expr.value, ctx, localSorts);
      const val = resolveValue(expr.value, ctx, localVars, localSorts, warnings);
      if (val === null) return null;
      const localConst = createLocalVar(Z3, expr.local, rhsSort, localVars, localSorts, ctx.callId);
      return Z3.Eq(localConst, val);
    }
    case 'unsupported':
      return null;
  }
}

/**
 * Return the Z3Sort for a VerifyValue without creating any Z3 expressions.
 * Used to determine the sort of a local variable at assignment time.
 */
function sortOfVerifyValue(
  value: VerifyValue,
  ctx: EncoderContext,
  localSorts: Map<string, Z3Sort>,
): Z3Sort {
  switch (value.kind) {
    case 'literal_string':
      return 'string';
    case 'literal_number':
      return 'int';
    case 'literal_bool':
      return 'bool';
    case 'literal_null':
      return 'string'; // best-effort; null is untyped in Rego
    case 'input_ref':
      return ctx.sorts.get(value.path) ?? 'string';
    case 'local_var':
      return localSorts.get(value.name) ?? 'string';
  }
}

/**
 * Resolve a VerifyValue to a Z3 expression.
 */
function resolveValue(
  value: VerifyValue,
  ctx: EncoderContext,
  localVars: Map<string, Z3AnyExpr>,
  localSorts: Map<string, Z3Sort>,
  warnings: string[],
): Z3AnyExpr | null {
  const { Z3, inputVars } = ctx;

  switch (value.kind) {
    case 'input_ref': {
      const v = inputVars.get(value.path);
      if (v === undefined) {
        warnings.push(`No Z3 variable for input path '${value.path}'.`);
        return null;
      }
      return v;
    }
    case 'local_var': {
      const v = localVars.get(value.name);
      if (v !== undefined) return v;
      // Local referenced before its assign expression -- create with the sort
      // recorded by a prior encodeExpr call, or default to string.
      const sort = localSorts.get(value.name) ?? 'string';
      return createLocalVar(Z3, value.name, sort, localVars, localSorts, ctx.callId);
    }
    case 'literal_string':
      return Z3.String.val(value.value);
    case 'literal_number':
      return Z3.Int.val(value.value);
    case 'literal_bool':
      return Z3.Bool.val(value.value);
    case 'literal_null':
      warnings.push('null literal encoded as uninterpreted constant.');
      return null;
  }
}

/**
 * Create a Z3 constant for a local variable with an explicitly-known sort.
 * Caches it so subsequent references to the same local reuse the same constant.
 * The callId prefix ensures names are unique across calls in the same Z3 context.
 */
function createLocalVar(
  Z3: Z3Context,
  name: string,
  sort: Z3Sort,
  localVars: Map<string, Z3AnyExpr>,
  localSorts: Map<string, Z3Sort>,
  callId: string,
): Z3AnyExpr {
  if (localVars.has(name)) return localVars.get(name)!;

  const z3Name = `${callId}_${name}`;
  let c: Z3AnyExpr;
  switch (sort) {
    case 'string':
      c = Z3.String.const(z3Name);
      break;
    case 'int':
      c = Z3.Int.const(z3Name);
      break;
    case 'bool':
      c = Z3.Bool.const(z3Name);
      break;
    case 'uninterpreted': {
      const s = Z3.Sort.declare(z3Name + '_sort');
      c = Z3.Const(z3Name, s) as unknown as Z3AnyExpr;
      break;
    }
  }

  localVars.set(name, c);
  localSorts.set(name, sort);
  return c;
}

/** Convert an input path like "input.user.role" to a valid Z3 var name. */
export function pathToVarName(path: string): string {
  return path.replace(/\./g, '__');
}

/** Reconstruct a nested JSON object from flat Z3 var name → value pairs. */
export function varNameToPath(varName: string): string {
  return varName.replace(/__/g, '.');
}

// ─── Regex simplifier ────────────────────────────────────────────────────────
// Detects structurally simple patterns and maps them to cheap Z3 string
// predicates (prefixOf / suffixOf / contains / Eq). These are the only
// regex.match idioms the verifier can encode -- complex patterns (character
// classes, quantifiers, alternation, etc.) are caught by the walker before
// they reach the encoder.

/** True if every char in s is a non-metacharacter (safe as a literal). */
function isRegexLiteral(s: string): boolean {
  return s.length > 0 && !/[.+*?^${}()|[\]\\]/.test(s);
}

/**
 * Return true if the pattern can be encoded as a cheap Z3 string predicate.
 *
 * Handled idioms:
 *   .*  / ^.*$ / ^.* / .*$   → Bool.val(true)  (matches any string)
 *   ^lit$                     → Eq(str, lit)
 *   ^lit.*                    → prefixOf(lit, str)
 *   .*lit$                    → suffixOf(lit, str)
 *   .*lit.*                   → contains(str, lit)
 *
 * Everything else returns false. The walker uses this to guard which
 * regex.match expressions reach the encoder, preventing Z3 InRe hangs.
 */
export function isSimpleRegexPattern(pattern: string): boolean {
  const hasStart = pattern.startsWith('^');
  const hasEnd = pattern.endsWith('$') && !pattern.endsWith('\\$');
  const core = pattern.slice(hasStart ? 1 : 0, hasEnd ? pattern.length - 1 : undefined);

  if (core === '.*') return true;
  if (hasStart && hasEnd && isRegexLiteral(core)) return true;
  if (hasStart && core.endsWith('.*') && isRegexLiteral(core.slice(0, -2))) return true;
  if (hasEnd && core.startsWith('.*') && isRegexLiteral(core.slice(2))) return true;
  if (core.startsWith('.*') && core.endsWith('.*') && isRegexLiteral(core.slice(2, -2)))
    return true;

  return false;
}

type StringExpr = ReturnType<Z3Context['String']['const']>;

/**
 * Try to encode a regex pattern as a cheap Z3 string predicate.
 * Returns null only if the pattern is not one of the five supported idioms.
 * The walker guarantees only simple patterns reach here, so null is defensive.
 */
function tryRegexAsStringConstraint(
  Z3: Z3Context,
  str: StringExpr,
  pattern: string,
): Z3Bool | null {
  const hasStart = pattern.startsWith('^');
  const hasEnd = pattern.endsWith('$') && !pattern.endsWith('\\$');
  const core = pattern.slice(hasStart ? 1 : 0, hasEnd ? pattern.length - 1 : undefined);

  // Pure wildcard: .* (with or without anchors) matches any string -- always true.
  if (core === '.*') {
    return Z3.Bool.val(true);
  }

  // ^lit$ → exact equality
  if (hasStart && hasEnd && isRegexLiteral(core)) {
    return Z3.Eq(str, Z3.String.val(core));
  }

  // ^lit.* → startswith
  if (hasStart && core.endsWith('.*')) {
    const prefix = core.slice(0, -2);
    if (isRegexLiteral(prefix)) {
      return Z3.String.val(prefix).prefixOf(str);
    }
  }

  // .*lit$ → endswith
  if (hasEnd && core.startsWith('.*')) {
    const suffix = core.slice(2);
    if (isRegexLiteral(suffix)) {
      return Z3.String.val(suffix).suffixOf(str);
    }
  }

  // .*lit.* → contains
  if (core.startsWith('.*') && core.endsWith('.*')) {
    const sub = core.slice(2, -2);
    if (isRegexLiteral(sub)) {
      return str.contains(Z3.String.val(sub));
    }
  }

  return null;
}
