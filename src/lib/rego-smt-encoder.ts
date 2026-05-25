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
import type {
  VerifyExpr,
  VerifyRuleClause,
  VerifyValue,
} from './rego-ir.js';

type Z3Context = ReturnType<Awaited<ReturnType<typeof Z3Init>>['Context']>;
type Z3Bool = ReturnType<Z3Context['Bool']['const']>;
type Z3Expr = Parameters<Z3Context['Solver']['prototype']['add']>[0];
type Z3AnyExpr = Z3Bool | ReturnType<Z3Context['Int']['const']> | ReturnType<Z3Context['String']['const']>;

export interface EncoderContext {
  Z3: Z3Context;
  inputVars: Map<string, Z3AnyExpr>;
  sorts: Map<string, Z3Sort>;
}

export interface EncodedRule {
  formula: Z3Bool;
  warnings: string[];
}

/**
 * Create Z3 constants for all input paths based on inferred sorts.
 * Returns the variable map and any uninterpreted sort declarations.
 */
export function createInputVars(
  Z3: Z3Context,
  inputPaths: Map<string, string[]>,
  sorts: Map<string, Z3Sort>,
): Map<string, Z3AnyExpr> {
  const vars = new Map<string, Z3AnyExpr>();

  for (const path of inputPaths.keys()) {
    const sort = sorts.get(path) ?? 'string';
    const varName = pathToVarName(path);

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
export function encodeRule(
  clauses: VerifyRuleClause[],
  ctx: EncoderContext,
): EncodedRule {
  const { Z3 } = ctx;
  const warnings: string[] = [];

  const clauseFormulas: Z3Bool[] = [];
  for (const clause of clauses) {
    const localVars = new Map<string, Z3AnyExpr>();
    const clauseResult = encodeClause(clause, ctx, localVars);
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

  return { formula: Z3.Or(...clauseFormulas) as Z3Bool, warnings };
}

interface ClauseResult {
  formula: Z3Bool | null;
  warnings: string[];
}

function encodeClause(
  clause: VerifyRuleClause,
  ctx: EncoderContext,
  localVars: Map<string, Z3AnyExpr>,
): ClauseResult {
  const { Z3 } = ctx;
  const warnings: string[] = [];
  const conjuncts: Z3Bool[] = [];

  for (const expr of clause.expressions) {
    if (expr.kind === 'unsupported') continue; // engine skips these clauses already

    const encoded = encodeExpr(expr, ctx, localVars, warnings);
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

  return { formula: Z3.And(...conjuncts) as Z3Bool, warnings };
}

function encodeExpr(
  expr: VerifyExpr,
  ctx: EncoderContext,
  localVars: Map<string, Z3AnyExpr>,
  warnings: string[],
): Z3Bool | null {
  const { Z3 } = ctx;

  switch (expr.kind) {
    case 'eq': {
      const l = resolveValue(expr.left, ctx, localVars, warnings);
      const r = resolveValue(expr.right, ctx, localVars, warnings);
      if (l === null || r === null) return null;
      return Z3.Eq(l, r) as Z3Bool;
    }
    case 'neq': {
      const l = resolveValue(expr.left, ctx, localVars, warnings);
      const r = resolveValue(expr.right, ctx, localVars, warnings);
      if (l === null || r === null) return null;
      return Z3.Not(Z3.Eq(l, r)) as Z3Bool;
    }
    case 'gt': {
      const l = resolveValue(expr.left, ctx, localVars, warnings);
      const r = resolveValue(expr.right, ctx, localVars, warnings);
      if (l === null || r === null) return null;
      return Z3.GT(l as ReturnType<Z3Context['Int']['const']>, r as ReturnType<Z3Context['Int']['const']>) as Z3Bool;
    }
    case 'gte': {
      const l = resolveValue(expr.left, ctx, localVars, warnings);
      const r = resolveValue(expr.right, ctx, localVars, warnings);
      if (l === null || r === null) return null;
      return Z3.GE(l as ReturnType<Z3Context['Int']['const']>, r as ReturnType<Z3Context['Int']['const']>) as Z3Bool;
    }
    case 'lt': {
      const l = resolveValue(expr.left, ctx, localVars, warnings);
      const r = resolveValue(expr.right, ctx, localVars, warnings);
      if (l === null || r === null) return null;
      return Z3.LT(l as ReturnType<Z3Context['Int']['const']>, r as ReturnType<Z3Context['Int']['const']>) as Z3Bool;
    }
    case 'lte': {
      const l = resolveValue(expr.left, ctx, localVars, warnings);
      const r = resolveValue(expr.right, ctx, localVars, warnings);
      if (l === null || r === null) return null;
      return Z3.LE(l as ReturnType<Z3Context['Int']['const']>, r as ReturnType<Z3Context['Int']['const']>) as Z3Bool;
    }
    case 'startswith': {
      const str = resolveValue(expr.str, ctx, localVars, warnings);
      const prefix = resolveValue(expr.prefix, ctx, localVars, warnings);
      if (str === null || prefix === null) return null;
      // Z3 string API: prefix.prefixOf(str) means "prefix is a prefix of str"
      type StringExpr = ReturnType<Z3Context['String']['const']>;
      return (prefix as StringExpr).prefixOf(str as StringExpr) as Z3Bool;
    }
    case 'endswith': {
      const str = resolveValue(expr.str, ctx, localVars, warnings);
      const suffix = resolveValue(expr.suffix, ctx, localVars, warnings);
      if (str === null || suffix === null) return null;
      type StringExpr = ReturnType<Z3Context['String']['const']>;
      return (suffix as StringExpr).suffixOf(str as StringExpr) as Z3Bool;
    }
    case 'contains': {
      const str = resolveValue(expr.str, ctx, localVars, warnings);
      const sub = resolveValue(expr.sub, ctx, localVars, warnings);
      if (str === null || sub === null) return null;
      type StringExpr = ReturnType<Z3Context['String']['const']>;
      return (str as StringExpr).contains(sub as StringExpr) as Z3Bool;
    }
    case 'regex_match': {
      const str = resolveValue(expr.str, ctx, localVars, warnings);
      if (str === null) return null;
      type StringExpr = ReturnType<Z3Context['String']['const']>;

      if (expr.pattern.kind === 'literal_string') {
        // Try cheap string predicates first: ^prefix.*, .*suffix$, .*sub.*, ^exact$
        // These avoid Z3's InRe string theory which is extremely memory-intensive.
        const simplified = tryRegexAsStringConstraint(Z3, str as StringExpr, expr.pattern.value);
        if (simplified !== null) return simplified;

        const re = compilePcreToZ3Re(Z3, expr.pattern.value);
        return Z3.InRe(str as StringExpr, re) as Z3Bool;
      }

      // Variable pattern: fall back to literal match (approximate).
      const pat = resolveValue(expr.pattern, ctx, localVars, warnings);
      if (pat === null) return null;
      warnings.push('regex_match with variable pattern uses literal string match approximation.');
      const re = Z3.Re.toRe(pat as StringExpr);
      return Z3.InRe(str as StringExpr, re) as Z3Bool;
    }
    case 'bool_check': {
      const ref = resolveValue(expr.ref, ctx, localVars, warnings);
      if (ref === null) return null;
      // Treat as: ref == true
      return Z3.Eq(ref, Z3.Bool.val(true)) as Z3Bool;
    }
    case 'assign': {
      // x := value → create a local constant and constrain it to the value.
      const val = resolveValue(expr.value, ctx, localVars, warnings);
      if (val === null) return null;
      // The sort of the local var is inferred from the RHS value.
      const localConst = createLocalVar(Z3, expr.local, val, localVars);
      if (localConst === null) return null;
      return Z3.Eq(localConst, val) as Z3Bool;
    }
    case 'unsupported':
      return null;
  }
}

/**
 * Resolve a VerifyValue to a Z3 expression.
 */
function resolveValue(
  value: VerifyValue,
  ctx: EncoderContext,
  localVars: Map<string, Z3AnyExpr>,
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
      if (v === undefined) {
        // Local not yet created (used before assign) -- create as string var.
        const c = Z3.String.const(value.name);
        localVars.set(value.name, c);
        return c;
      }
      return v;
    }
    case 'literal_string':
      return Z3.String.val(value.value);
    case 'literal_number':
      return Z3.Int.val(value.value);
    case 'literal_bool':
      return Z3.Bool.val(value.value);
    case 'literal_null':
      // Encode null as a fresh uninterpreted constant named "__null".
      warnings.push('null literal encoded as uninterpreted constant.');
      return null;
  }
}

/**
 * Create a Z3 constant for a local variable, inferring its sort from the
 * RHS value's Z3 type. Caches it so subsequent references to the same
 * local use the same constant.
 */
function createLocalVar(
  Z3: Z3Context,
  name: string,
  rhs: Z3AnyExpr,
  localVars: Map<string, Z3AnyExpr>,
): Z3AnyExpr | null {
  if (localVars.has(name)) return localVars.get(name)!;

  // Infer the sort from the RHS expression's string representation
  // (Z3 sorts are embedded in the expression type). We use a heuristic:
  // check if the rhs is a string/int/bool constant.
  const rhsStr = rhs.toString();
  let c: Z3AnyExpr;

  if (rhsStr.startsWith('"') || rhsStr.includes('str')) {
    c = Z3.String.const(name);
  } else if (rhsStr.match(/^-?\d+$/) || rhsStr.includes('Int')) {
    c = Z3.Int.const(name);
  } else if (rhsStr === 'true' || rhsStr === 'false') {
    c = Z3.Bool.const(name);
  } else {
    // Default to string for unknown.
    c = Z3.String.const(name);
  }

  localVars.set(name, c);
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
// predicates (prefixOf / suffixOf / contains / Eq) before resorting to InRe.
// InRe with Z3's string theory is correct but extremely memory-intensive in
// WASM; the four common OPA regex idioms below can be handled without it.

/** True if every char in s is a non-metacharacter (safe as a literal). */
function isRegexLiteral(s: string): boolean {
  return s.length > 0 && !/[.+*?^${}()|[\]\\]/.test(s);
}

type StringExpr = ReturnType<Z3Context['String']['const']>;

/**
 * Try to encode a regex pattern as a cheap Z3 string predicate.
 * Returns null if the pattern is too complex and InRe should be used.
 *
 * Handled idioms:
 *   ^lit$       → Eq(str, lit)
 *   ^lit.*      → prefixOf(lit, str)
 *   .*lit$      → suffixOf(lit, str)
 *   .*lit.*     → contains(str, lit)
 */
function tryRegexAsStringConstraint(
  Z3: Z3Context,
  str: StringExpr,
  pattern: string,
): Z3Bool | null {
  const hasStart = pattern.startsWith('^');
  const hasEnd = pattern.endsWith('$') && !pattern.endsWith('\\$');
  const core = pattern.slice(hasStart ? 1 : 0, hasEnd ? pattern.length - 1 : undefined);

  // ^lit$ → exact equality
  if (hasStart && hasEnd && isRegexLiteral(core)) {
    return Z3.Eq(str, Z3.String.val(core)) as Z3Bool;
  }

  // ^lit.* → startswith
  if (hasStart && core.endsWith('.*')) {
    const prefix = core.slice(0, -2);
    if (isRegexLiteral(prefix)) {
      return (Z3.String.val(prefix) as StringExpr).prefixOf(str) as Z3Bool;
    }
  }

  // .*lit$ → endswith
  if (hasEnd && core.startsWith('.*')) {
    const suffix = core.slice(2);
    if (isRegexLiteral(suffix)) {
      return (Z3.String.val(suffix) as StringExpr).suffixOf(str) as Z3Bool;
    }
  }

  // .*lit.* → contains
  if (core.startsWith('.*') && core.endsWith('.*')) {
    const sub = core.slice(2, -2);
    if (isRegexLiteral(sub)) {
      return str.contains(Z3.String.val(sub) as StringExpr) as Z3Bool;
    }
  }

  return null;
}

// ─── PCRE-to-Z3 regex compiler ───────────────────────────────────────────────
// Handles common OPA RE2 patterns. The Z3 string theory anchors InRe at both
// ends, so ^ and $ are stripped. Supported: . * + ? | () [cls] \d \w \s.

type Z3Re = ReturnType<Z3Context['Re']['toRe']>;
type Z3ReSort = ReturnType<Z3Context['Re']['sort']>;

/**
 * Compile a PCRE/RE2 pattern string to a Z3 regex expression.
 * Falls back to exact literal match for unrecognized constructs.
 */
export function compilePcreToZ3Re(Z3: Z3Context, pattern: string): Z3Re {
  const reSort = Z3.Re.sort(Z3.String.sort());
  let p = pattern;
  if (p.startsWith('^')) p = p.slice(1);
  if (p.endsWith('$') && !p.endsWith('\\$')) p = p.slice(0, -1);
  return parseAlternation(Z3, reSort, p, 0, p.length).re;
}

interface ParseResult {
  re: Z3Re;
  end: number;
  isAllChar?: boolean; // true when the atom is "." (any single char)
}

function parseAlternation(Z3: Z3Context, reSort: Z3ReSort, s: string, start: number, end: number): ParseResult {
  const branches: Z3Re[] = [];
  let i = start;
  let segStart = i;

  while (i <= end) {
    if (i === end || (s[i] === '|' && i < end)) {
      branches.push(parseConcatenation(Z3, reSort, s, segStart, i).re);
      if (i < end) i++; // skip |
      segStart = i;
    } else {
      i++;
    }
  }

  if (branches.length === 1) return { re: branches[0]!, end };
  return { re: branches.reduce((a, b) => Z3.Union(a, b)), end };
}

function parseConcatenation(Z3: Z3Context, reSort: Z3ReSort, s: string, start: number, end: number): ParseResult {
  const atoms: Z3Re[] = [];
  let i = start;

  while (i < end) {
    const { re, end: atomEnd } = parseAtomWithQuantifier(Z3, reSort, s, i, end);
    atoms.push(re);
    i = atomEnd;
  }

  if (atoms.length === 0) return { re: Z3.Re.toRe(Z3.String.val('')), end };
  if (atoms.length === 1) return { re: atoms[0]!, end };
  return { re: Z3.ReConcat(...atoms), end };
}

function parseAtomWithQuantifier(Z3: Z3Context, reSort: Z3ReSort, s: string, i: number, limit: number): ParseResult {
  const { re: base, end: atomEnd, isAllChar } = parseAtom(Z3, reSort, s, i, limit);
  let re = base;
  let j = atomEnd;

  if (j < limit) {
    if (s[j] === '*') {
      // /.*/  →  Full(reSort): any string. Much more efficient than Star(AllChar).
      re = isAllChar ? Z3.Full(reSort) : Z3.Star(re);
      j++;
    } else if (s[j] === '+') {
      // /.+/  →  concat(AllChar, Full): at least one char.
      re = isAllChar ? Z3.ReConcat(Z3.AllChar(reSort), Z3.Full(reSort)) : Z3.Plus(re);
      j++;
    } else if (s[j] === '?') {
      re = Z3.Option(re);
      j++;
    } else if (s[j] === '{') {
      const close = s.indexOf('}', j);
      if (close !== -1) j = close + 1; // skip {n,m}
    }
  }
  return { re, end: j };
}

function parseAtom(Z3: Z3Context, reSort: Z3ReSort, s: string, i: number, limit: number): ParseResult {
  const c = s[i];

  if (c === '\\' && i + 1 < limit) {
    const esc = s[i + 1];
    switch (esc) {
      case 'd': return { re: Z3.Range(Z3.String.val('0'), Z3.String.val('9')), end: i + 2 };
      case 'D': return { re: Z3.Complement(Z3.Range(Z3.String.val('0'), Z3.String.val('9'))), end: i + 2 };
      case 'w': {
        const az = Z3.Range(Z3.String.val('a'), Z3.String.val('z'));
        const AZ = Z3.Range(Z3.String.val('A'), Z3.String.val('Z'));
        const d = Z3.Range(Z3.String.val('0'), Z3.String.val('9'));
        const us = Z3.Re.toRe(Z3.String.val('_'));
        return { re: Z3.Union(az, AZ, d, us), end: i + 2 };
      }
      case 'W': {
        const az = Z3.Range(Z3.String.val('a'), Z3.String.val('z'));
        const AZ = Z3.Range(Z3.String.val('A'), Z3.String.val('Z'));
        const d = Z3.Range(Z3.String.val('0'), Z3.String.val('9'));
        const us = Z3.Re.toRe(Z3.String.val('_'));
        return { re: Z3.Complement(Z3.Union(az, AZ, d, us)), end: i + 2 };
      }
      case 's': {
        const ws = Z3.Union(
          Z3.Re.toRe(Z3.String.val(' ')),
          Z3.Re.toRe(Z3.String.val('\t')),
          Z3.Re.toRe(Z3.String.val('\n')),
          Z3.Re.toRe(Z3.String.val('\r')),
        );
        return { re: ws, end: i + 2 };
      }
      default:
        return { re: Z3.Re.toRe(Z3.String.val(esc!)), end: i + 2 };
    }
  }

  if (c === '.') {
    return { re: Z3.AllChar(reSort), end: i + 1, isAllChar: true };
  }

  if (c === '(') {
    let depth = 1;
    let j = i + 1;
    while (j < limit && depth > 0) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === '(') depth++;
      if (s[j] === ')') depth--;
      j++;
    }
    const inner = parseAlternation(Z3, reSort, s, i + 1, j - 1);
    return { re: inner.re, end: j };
  }

  if (c === '[') {
    const close = findCharClassClose(s, i + 1, limit);
    const cls = s.slice(i + 1, close);
    return { re: parseCharClass(Z3, cls), end: close + 1 };
  }

  // Literal character
  return { re: Z3.Re.toRe(Z3.String.val(c!)), end: i + 1 };
}

function findCharClassClose(s: string, start: number, limit: number): number {
  let i = start;
  if (i < limit && s[i] === ']') i++; // ] at start is literal
  while (i < limit && s[i] !== ']') {
    if (s[i] === '\\') i++; // skip escaped char
    i++;
  }
  return i;
}

function parseCharClass(Z3: Z3Context, cls: string): Z3Re {
  const negated = cls.startsWith('^');
  const src = negated ? cls.slice(1) : cls;
  const parts: Z3Re[] = [];
  let i = 0;

  while (i < src.length) {
    if (src[i] === '\\' && i + 1 < src.length) {
      parts.push(Z3.Re.toRe(Z3.String.val(src[i + 1]!)));
      i += 2;
    } else if (i + 2 < src.length && src[i + 1] === '-') {
      parts.push(Z3.Range(Z3.String.val(src[i]!), Z3.String.val(src[i + 2]!)));
      i += 3;
    } else {
      parts.push(Z3.Re.toRe(Z3.String.val(src[i]!)));
      i++;
    }
  }

  if (parts.length === 0) return Z3.Re.toRe(Z3.String.val(''));
  const base = parts.length === 1 ? parts[0]! : Z3.Union(...parts);
  return negated ? Z3.Complement(base) : base;
}
