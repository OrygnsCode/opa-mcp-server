/**
 * Intermediate Representation produced by the AST walker and consumed by
 * the SMT encoder. This layer insulates the encoder from OPA AST details:
 * the walker owns all AST knowledge, the encoder owns all Z3 knowledge.
 */

/**
 * A value that appears as an operand in a VerifyExpr.
 *
 * input_ref   - a path like input.user.role (path = "input.user.role",
 *               segments = ["user","role"])
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
  | { kind: 'unsupported'; constructType: string; reason: string };

/**
 * One clause of a rule -- corresponds to one `rule { body... }` block.
 * Multiple clauses for the same rule name are OR'd together.
 * Expressions within one clause are AND'd together.
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
  inputPaths: Map<string, string[]>;
  unsupported: UnsupportedConstruct[];
}
