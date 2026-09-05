/**
 * Intermediate Representation produced by the AST walker and consumed by
 * the SMT encoder. This layer insulates the encoder from OPA AST details:
 * the walker owns all AST knowledge, the encoder owns all Z3 knowledge.
 */

/**
 * A value that appears as an operand in a VerifyExpr.
 *
 * input_ref   - a path like input.user.role (path = "input.user.role",
 *               segments = ["user","role"]); a segment that is not a plain
 *               identifier is rendered `["..."]`, so paths never collide
 * local_var   - a local variable bound by :=/= in the same clause
 * literal_*   - a constant from the policy source
 */
export type VerifyValue =
  | { kind: 'input_ref'; path: string; segments: string[] }
  | { kind: 'local_var'; name: string }
  | { kind: 'literal_string'; value: string }
  | { kind: 'literal_number'; value: number }
  | { kind: 'literal_bool'; value: boolean }
  | { kind: 'literal_null' };

/**
 * A single verifiable expression derived from a rule body expression.
 *
 * All supported operator semantics map cleanly to Z3. The 'unsupported'
 * variant is included so the walker can pass through the reason; the
 * engine treats any clause containing it as inconclusive.
 *
 * 'contradiction' is the encodable counterpart: a body term that makes the
 * clause unsatisfiable no matter the input, such as a literal `false`. It is
 * distinct from 'unsupported' because the engine CAN reason about it, and
 * dropping it instead would make the clause look satisfiable when it is not.
 */
export type VerifyExpr =
  | { kind: 'eq'; left: VerifyValue; right: VerifyValue }
  | { kind: 'neq'; left: VerifyValue; right: VerifyValue }
  | { kind: 'lt'; left: VerifyValue; right: VerifyValue }
  | { kind: 'lte'; left: VerifyValue; right: VerifyValue }
  | { kind: 'gt'; left: VerifyValue; right: VerifyValue }
  | { kind: 'gte'; left: VerifyValue; right: VerifyValue }
  | { kind: 'startswith'; str: VerifyValue; prefix: VerifyValue }
  | { kind: 'endswith'; str: VerifyValue; suffix: VerifyValue }
  | { kind: 'contains'; str: VerifyValue; sub: VerifyValue }
  | { kind: 'regex_match'; pattern: VerifyValue; str: VerifyValue }
  | { kind: 'bool_check'; ref: VerifyValue }
  | { kind: 'assign'; local: string; value: VerifyValue }
  | { kind: 'contradiction'; reason: string }
  | { kind: 'negation'; inner: VerifyExpr[] }
  | { kind: 'unsupported'; constructType: string; reason: string };

/**
 * The shape of a rule head, which decides whether "is this rule true" is even
 * a meaningful question.
 *
 * complete        - `allow if { ... }` or `allow := <value> if { ... }`. Its
 *                   value is a single term, so it can be compared to `true`.
 * partial_set     - `deny contains msg if { ... }`. Its value is a SET, so it
 *                   is never equal to `true` and asking always_true/never_true
 *                   about it answers a question the caller did not intend.
 * partial_object  - `perms[k] := v if { ... }`. Value is an object, same problem.
 * function        - `f(x) if { ... }`. Needs arguments the caller never supplies.
 * else_chain      - `... else := ...`. Ordered fallthrough the encoder does not model.
 */
export type RuleShape = 'complete' | 'partial_set' | 'partial_object' | 'function' | 'else_chain';

/**
 * One clause of a rule -- corresponds to one `rule { body... }` block.
 *
 * A clause contributes to "the rule is true" only when its head value is
 * literally `true`. It contributes to "the rule is defined" whenever its body
 * is satisfied, whatever the head value is. Keeping those separate is what
 * makes `default` and non-boolean heads encodable rather than silently wrong.
 */
export interface VerifyRuleClause {
  clauseIndex: number;
  headValue: boolean | number | string | null;
  expressions: VerifyExpr[];
}

export interface UnsupportedConstruct {
  constructType: string;
  description: string;
  location?: { row: number; col: number; file?: string };
}

export interface VerifyWalkResult {
  rules: Map<string, VerifyRuleClause[]>;
  defaults: Map<string, boolean | number | string | null>;
  /** Head shape per rule name. Absent means no clause was ever walked for it. */
  shapes: Map<string, RuleShape>;
  inputPaths: Map<string, string[]>;
  unsupported: UnsupportedConstruct[];
}
