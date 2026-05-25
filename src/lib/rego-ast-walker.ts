/**
 * AST walker: OpaModule → VerifyWalkResult.
 *
 * Responsibilities:
 *   1. Traverse all rules in the module, grouping clauses by rule name.
 *   2. Inline cross-module rule references (non-recursive, depth <= MAX_INLINE_DEPTH).
 *   3. Collect all input.* paths referenced anywhere in scope.
 *   4. Detect and record every construct Phase 1 cannot handle.
 *
 * The encoder never touches OPA AST types -- all AST knowledge lives here.
 */
import type {
  OpaExpression,
  OpaModule,
  OpaRule,
  OpaTerm,
  OpaTermValue,
} from './rego-ast-types.js';
import type {
  UnsupportedConstruct,
  VerifyExpr,
  VerifyRuleClause,
  VerifyValue,
  VerifyWalkResult,
} from './rego-ir.js';

const MAX_INLINE_DEPTH = 5;

/** Operator names (first-term ref) that Phase 1 can encode in SMT. */
const SUPPORTED_BINARY_OPS = new Set([
  'equal',      // ==
  'eq',         // = (unification)
  'assign',     // :=
  'neq',        // !=
  'gt',         // >
  'gte',        // >=
  'lt',         // <
  'lte',        // <=
  'startswith',
  'endswith',
  'contains',
  'regex.match',
]);

export function walkModule(ast: OpaModule): VerifyWalkResult {
  const result: VerifyWalkResult = {
    rules: new Map(),
    defaults: new Map(),
    inputPaths: new Map(),
    unsupported: [],
  };

  // Collect all rule names defined in this module for inlining detection.
  const ruleNames = new Set(ast.rules.map((r) => r.head.name));

  let clauseIndex = 0;
  for (const rule of ast.rules) {
    walkRule(rule, result, ast, ruleNames, new Set(), 0, clauseIndex++);
  }

  return result;
}

function walkRule(
  rule: OpaRule,
  result: VerifyWalkResult,
  ast: OpaModule,
  ruleNames: Set<string>,
  inliningStack: Set<string>,
  depth: number,
  clauseIndex: number,
): void {
  const name = rule.head.name;

  if (rule.else !== undefined) {
    addUnsupported(result, 'else_chain', `Rule '${name}' uses an else chain.`);
    return;
  }

  if (rule.head.args && rule.head.args.length > 0) {
    addUnsupported(result, 'function_rule', `Rule '${name}' is a function (has arguments).`);
    return;
  }

  if (rule.default === true) {
    const dv = extractLiteralValue(rule.head.value);
    if (dv !== undefined) result.defaults.set(name, dv);
    return;
  }

  const headValue = extractLiteralValue(rule.head.value) ?? true;
  const exprs: VerifyExpr[] = [];
  let anonCounter = 0;

  for (const bodyExpr of rule.body) {
    // Default rule body: single boolean true term -- skip.
    if (!Array.isArray(bodyExpr.terms) && bodyExpr.terms.type === 'boolean') continue;

    if (bodyExpr.negated === true) {
      addUnsupported(result, 'naf', `Rule '${name}' uses negation-as-failure.`, bodyExpr);
      exprs.push({ kind: 'unsupported', constructType: 'naf', reason: 'negation-as-failure' });
      continue;
    }

    if (bodyExpr.with !== undefined) {
      addUnsupported(result, 'with_modifier', `Rule '${name}' uses a 'with' modifier.`);
      exprs.push({ kind: 'unsupported', constructType: 'with_modifier', reason: 'with modifier' });
      continue;
    }

    const ve = walkExpression(
      bodyExpr,
      name,
      clauseIndex,
      ruleNames,
      inliningStack,
      depth,
      result,
      ast,
      () => anonCounter++,
    );

    for (const e of ve) exprs.push(e);
  }

  const clauses = result.rules.get(name) ?? [];
  clauses.push({ clauseIndex, headValue, expressions: exprs });
  result.rules.set(name, clauses);
}

/**
 * Convert one body expression to zero or more VerifyExprs.
 * Returns multiple results when a cross-rule reference is inlined (that
 * rule's own clauses become AND'd conditions within this clause).
 */
function walkExpression(
  expr: OpaExpression,
  ruleName: string,
  clauseIndex: number,
  ruleNames: Set<string>,
  inliningStack: Set<string>,
  depth: number,
  result: VerifyWalkResult,
  ast: OpaModule,
  nextAnon: () => number,
): VerifyExpr[] {
  const { terms } = expr;

  // Single-term expression.
  if (!Array.isArray(terms)) {
    return walkSingleTerm(terms, ruleName, clauseIndex, ruleNames, inliningStack, depth, result, ast);
  }

  // Array of terms: terms[0] is the operator ref, rest are arguments.
  if (terms.length === 0) return [];
  const [opTerm, ...args] = terms;
  if (opTerm === undefined) return [];

  const opName = getOperatorName(opTerm);
  if (opName === null) {
    addUnsupported(result, 'unknown_operator', `Rule '${ruleName}' has an expression with an unrecognized operator shape.`);
    return [{ kind: 'unsupported', constructType: 'unknown_operator', reason: 'unrecognized operator' }];
  }

  // Detect unsupported constructs from the operator.
  const comprehensionOps = new Set(['arraycomprehension', 'setcomprehension', 'objectcomprehension']);
  if (opName === 'every' || args.some((a) => comprehensionOps.has(a.type))) {
    addUnsupported(result, 'comprehension_or_every', `Rule '${ruleName}' uses a comprehension or 'every'.`);
    return [{ kind: 'unsupported', constructType: 'comprehension_or_every', reason: 'comprehension or every' }];
  }
  // Check if any arg itself is a comprehension/every term type
  for (const arg of args) {
    if (comprehensionOps.has(arg.type) || arg.type === 'every') {
      addUnsupported(result, 'comprehension_or_every', `Rule '${ruleName}' uses a comprehension or 'every'.`);
      return [{ kind: 'unsupported', constructType: 'comprehension_or_every', reason: 'comprehension' }];
    }
  }

  if (!SUPPORTED_BINARY_OPS.has(opName)) {
    addUnsupported(result, 'unknown_builtin', `Rule '${ruleName}' calls unsupported built-in '${opName}'.`);
    return [{ kind: 'unsupported', constructType: 'unknown_builtin', reason: `unsupported built-in '${opName}'` }];
  }

  return [buildBinaryExpr(opName, args, ruleName, clauseIndex, result, nextAnon)];
}

function walkSingleTerm(
  term: OpaTerm,
  ruleName: string,
  clauseIndex: number,
  ruleNames: Set<string>,
  inliningStack: Set<string>,
  depth: number,
  result: VerifyWalkResult,
  ast: OpaModule,
): VerifyExpr[] {
  // Bare var: could be a cross-rule reference or a local variable.
  if (term.type === 'var' && typeof term.value === 'string') {
    const varName = term.value;
    if (ruleNames.has(varName)) {
      return inlineRule(varName, ruleName, clauseIndex, ruleNames, inliningStack, depth, result, ast);
    }
    // Local var used as bool check -- unusual but handle gracefully.
    return [{ kind: 'bool_check', ref: { kind: 'local_var', name: scopedLocal(clauseIndex, varName) } }];
  }

  // Bare ref: input.field (bool truthiness check) or data.* (unsupported).
  if (term.type === 'ref' && Array.isArray(term.value)) {
    const refTerms = term.value as OpaTerm[];
    const root = refTerms[0];
    if (root?.type === 'var' && root.value === 'input') {
      const vv = extractInputRef(refTerms, result);
      if (vv) return [{ kind: 'bool_check', ref: vv }];
    }
    if (root?.type === 'var' && root.value === 'data') {
      addUnsupported(result, 'data_ref', `Rule '${ruleName}' references external data (data.*).`);
      return [{ kind: 'unsupported', constructType: 'data_ref', reason: 'data reference' }];
    }
    // Ref to another package rule or unknown -- unsupported.
    addUnsupported(result, 'unknown_ref', `Rule '${ruleName}' contains an unresolvable reference.`);
    return [{ kind: 'unsupported', constructType: 'unknown_ref', reason: 'unresolvable reference' }];
  }

  // Comprehension types as bare terms.
  if (
    term.type === 'arraycomprehension' ||
    term.type === 'setcomprehension' ||
    term.type === 'objectcomprehension' ||
    term.type === 'every'
  ) {
    addUnsupported(result, 'comprehension_or_every', `Rule '${ruleName}' uses a comprehension or 'every'.`);
    return [{ kind: 'unsupported', constructType: 'comprehension_or_every', reason: term.type }];
  }

  addUnsupported(result, 'unknown_expression', `Rule '${ruleName}' has an unrecognized single-term expression (type: ${term.type}).`);
  return [{ kind: 'unsupported', constructType: 'unknown_expression', reason: term.type }];
}

/**
 * Inline a rule reference: substitute "helper_rule is true" with all of
 * that rule's body conditions, flattened into the caller's clause (AND).
 *
 * Supports any number of body expressions in the target rule's single clause.
 * Multi-clause rules (OR semantics) are still marked unsupported because
 * they cannot be flattened into the caller's AND chain.
 */
function inlineRule(
  targetName: string,
  callerName: string,
  clauseIndex: number,
  ruleNames: Set<string>,
  inliningStack: Set<string>,
  depth: number,
  result: VerifyWalkResult,
  ast: OpaModule,
): VerifyExpr[] {
  if (inliningStack.has(targetName)) {
    addUnsupported(result, 'recursive_rule', `Rules '${callerName}' and '${targetName}' form a recursive cycle.`);
    return [{ kind: 'unsupported', constructType: 'recursive_rule', reason: 'recursive rule reference' }];
  }

  if (depth >= MAX_INLINE_DEPTH) {
    addUnsupported(result, 'inline_depth_exceeded', `Rule inlining exceeded maximum depth (${MAX_INLINE_DEPTH}).`);
    return [{ kind: 'unsupported', constructType: 'inline_depth_exceeded', reason: 'max inline depth' }];
  }

  // Find all non-default clauses for targetName.
  const targetRules = ast.rules.filter(
    (r) => r.head.name === targetName && r.default !== true,
  );

  if (targetRules.length === 0) {
    // Rule only has a default (always false/true) -- treat as literal.
    const defVal = ast.rules.find((r) => r.head.name === targetName && r.default === true);
    const v = defVal ? (extractLiteralValue(defVal.head.value) ?? false) : false;
    return [{ kind: 'eq', left: { kind: 'literal_bool', value: true }, right: { kind: 'literal_bool', value: v as boolean } }];
  }

  if (targetRules.length > 1) {
    // Multiple clauses: OR semantics can't be flattened into the caller's AND.
    addUnsupported(result, 'multi_clause_inline', `Rule '${targetName}' (referenced from '${callerName}') has multiple clauses; OR inlining is not supported in Phase 1.`);
    return [{ kind: 'unsupported', constructType: 'multi_clause_inline', reason: 'multi-clause rule reference' }];
  }

  const targetRule = targetRules[0]!;

  if (targetRule.else !== undefined) {
    addUnsupported(result, 'else_chain', `Inlined rule '${targetName}' uses an else chain.`);
    return [{ kind: 'unsupported', constructType: 'else_chain', reason: 'else chain in inlined rule' }];
  }

  const newStack = new Set(inliningStack);
  newStack.add(targetName);

  const bodyExprs = targetRule.body.filter(
    (e) => !((!Array.isArray(e.terms)) && e.terms.type === 'boolean'),
  );

  if (bodyExprs.length === 0) {
    return [{ kind: 'eq', left: { kind: 'literal_bool', value: true }, right: { kind: 'literal_bool', value: true } }];
  }

  // Walk every body expression and collect into a flat list. Each becomes an
  // additional conjunct in the caller's clause (AND semantics). This handles
  // any number of conditions in the helper rule, including transitive inlining
  // of nested helpers.
  let anonCounter = 0;
  const inlined: VerifyExpr[] = [];

  for (const bodyExpr of bodyExprs) {
    if (bodyExpr.negated === true) {
      addUnsupported(result, 'naf', `Inlined rule '${targetName}' uses negation-as-failure.`);
      inlined.push({ kind: 'unsupported', constructType: 'naf', reason: 'negation-as-failure in inlined rule' });
      continue;
    }

    if (bodyExpr.with !== undefined) {
      addUnsupported(result, 'with_modifier', `Inlined rule '${targetName}' uses a 'with' modifier.`);
      inlined.push({ kind: 'unsupported', constructType: 'with_modifier', reason: 'with modifier in inlined rule' });
      continue;
    }

    const ve = walkExpression(
      bodyExpr,
      targetName,
      clauseIndex,
      ruleNames,
      newStack,
      depth + 1,
      result,
      ast,
      () => anonCounter++,
    );
    for (const e of ve) inlined.push(e);
  }

  return inlined.length > 0
    ? inlined
    : [{ kind: 'eq', left: { kind: 'literal_bool', value: true }, right: { kind: 'literal_bool', value: true } }];
}

/**
 * Build a VerifyExpr for a two-argument operator expression.
 */
function buildBinaryExpr(
  opName: string,
  args: OpaTerm[],
  ruleName: string,
  clauseIndex: number,
  result: VerifyWalkResult,
  nextAnon: () => number,
): VerifyExpr {
  if (args.length < 2) {
    addUnsupported(result, 'arity_error', `Operator '${opName}' in rule '${ruleName}' has fewer than 2 arguments.`);
    return { kind: 'unsupported', constructType: 'arity_error', reason: `${opName} arity` };
  }

  const left = termToValue(args[0]!, clauseIndex, result, nextAnon);
  const right = termToValue(args[1]!, clauseIndex, result, nextAnon);

  if (left === null || right === null) {
    return { kind: 'unsupported', constructType: 'unsupported_value', reason: 'unsupported operand type' };
  }

  switch (opName) {
    case 'equal':
    case 'eq':
      return { kind: 'eq', left, right };
    case 'assign': {
      // LHS must be a var (the local being bound).
      const a0 = args[0]!;
      if (a0.type !== 'var' || typeof a0.value !== 'string') {
        addUnsupported(result, 'complex_assign', `Complex assignment in rule '${ruleName}'.`);
        return { kind: 'unsupported', constructType: 'complex_assign', reason: 'non-var LHS in assign' };
      }
      return { kind: 'assign', local: scopedLocal(clauseIndex, a0.value), value: right };
    }
    case 'neq':
      return { kind: 'neq', left, right };
    case 'gt':
      return { kind: 'gt', left, right };
    case 'gte':
      return { kind: 'gte', left, right };
    case 'lt':
      return { kind: 'lt', left, right };
    case 'lte':
      return { kind: 'lte', left, right };
    case 'startswith':
      return { kind: 'startswith', str: left, prefix: right };
    case 'endswith':
      return { kind: 'endswith', str: left, suffix: right };
    case 'contains':
      return { kind: 'contains', str: left, sub: right };
    case 'regex.match':
      // regex.match(pattern, string) -- pattern is args[0], string is args[1].
      return { kind: 'regex_match', pattern: left, str: right };
    default:
      addUnsupported(result, 'unknown_builtin', `Rule '${ruleName}' calls unsupported built-in '${opName}'.`);
      return { kind: 'unsupported', constructType: 'unknown_builtin', reason: opName };
  }
}

/**
 * Convert an OpaTerm to a VerifyValue.
 * Returns null when the term cannot be represented (triggers unsupported).
 */
function termToValue(
  term: OpaTerm,
  clauseIndex: number,
  result: VerifyWalkResult,
  nextAnon: () => number,
): VerifyValue | null {
  switch (term.type) {
    case 'string':
      return { kind: 'literal_string', value: term.value as string };
    case 'number':
      return { kind: 'literal_number', value: term.value as number };
    case 'boolean':
      return { kind: 'literal_bool', value: term.value as boolean };
    case 'null':
      return { kind: 'literal_null' };
    case 'var': {
      const varName = term.value as string;
      if (varName === '_') {
        return { kind: 'local_var', name: scopedLocal(clauseIndex, `_anon${nextAnon()}`) };
      }
      return { kind: 'local_var', name: scopedLocal(clauseIndex, varName) };
    }
    case 'ref': {
      const refTerms = term.value as OpaTerm[];
      const root = refTerms[0];
      if (root?.type === 'var' && root.value === 'input') {
        return extractInputRef(refTerms, result);
      }
      if (root?.type === 'var' && root.value === 'data') {
        return null; // caller adds unsupported
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract an input.* ref into a VerifyValue and register it in inputPaths.
 */
function extractInputRef(
  refTerms: OpaTerm[],
  result: VerifyWalkResult,
): VerifyValue | null {
  const segments: string[] = [];
  for (let i = 1; i < refTerms.length; i++) {
    const t = refTerms[i]!;
    if (t.type === 'string' && typeof t.value === 'string') {
      segments.push(t.value);
    } else if (t.type === 'var') {
      // Dynamic/wildcard key -- unsupported.
      return null;
    } else {
      return null;
    }
  }

  const path = 'input.' + segments.join('.');
  if (!result.inputPaths.has(path)) {
    result.inputPaths.set(path, segments);
  }
  return { kind: 'input_ref', path, segments };
}

/**
 * Get the operator name from the first term of a terms array.
 * Single-element ref → "equal", compound ref → "regex.match", etc.
 * Returns null if the shape is not a recognizable operator ref.
 */
function getOperatorName(opTerm: OpaTerm): string | null {
  if (opTerm.type !== 'ref' || !Array.isArray(opTerm.value)) return null;
  const parts = opTerm.value as OpaTerm[];
  return parts
    .map((p) => {
      if (p.type === 'var' && typeof p.value === 'string') return p.value;
      if (p.type === 'string' && typeof p.value === 'string') return p.value;
      return null;
    })
    .filter((s): s is string => s !== null)
    .join('.');
}

/**
 * Extract a literal scalar from a rule head value term.
 */
function extractLiteralValue(
  term: OpaTerm | undefined,
): boolean | number | string | null | undefined {
  if (term === undefined) return undefined;
  switch (term.type) {
    case 'boolean':
      return term.value as boolean;
    case 'number':
      return term.value as number;
    case 'string':
      return term.value as string;
    case 'null':
      return null;
    default:
      return undefined;
  }
}

function extractLocation(
  terms: OpaTerm | OpaTerm[],
): { row: number; col: number; file?: string } | undefined {
  const t = Array.isArray(terms) ? terms[0] : terms;
  if (t?.location) return t.location;
  return undefined;
}

function addUnsupported(
  result: VerifyWalkResult,
  constructType: string,
  description: string,
  expr?: OpaExpression,
): void {
  const existing = result.unsupported.find((u) => u.constructType === constructType);
  if (existing) return; // deduplicate same construct type
  const loc = expr ? extractLocation(expr.terms) : undefined;
  result.unsupported.push({ constructType, description, location: loc });
}

function scopedLocal(clauseIndex: number, varName: string): string {
  return `local_${clauseIndex}_${varName}`;
}

/**
 * Collect all input.* paths recursively from a raw OPA AST value.
 * Used for deep scans of comprehension bodies (Phase 2), but exported
 * here for reuse in the engine's path-discovery pass.
 */
export function collectAllInputPaths(node: unknown, out: Map<string, string[]>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectAllInputPaths(item, out);
    return;
  }

  const obj = node as Record<string, unknown>;
  if (obj['type'] === 'ref' && Array.isArray(obj['value'])) {
    const terms = obj['value'] as OpaTerm[];
    if (terms[0]?.type === 'var' && terms[0]?.value === 'input') {
      const segs: string[] = [];
      let ok = true;
      for (let i = 1; i < terms.length; i++) {
        const t = terms[i]!;
        if (t.type === 'string' && typeof t.value === 'string') segs.push(t.value);
        else { ok = false; break; }
      }
      if (ok && segs.length > 0) {
        const path = 'input.' + segs.join('.');
        if (!out.has(path)) out.set(path, segs);
      }
    }
  }

  for (const val of Object.values(obj)) collectAllInputPaths(val, out);
}
