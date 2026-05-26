/**
 * TypeScript types mirroring the JSON output of `opa parse --format=json`.
 *
 * Field names and value shapes are verified against real OPA 0.69 output.
 * Exact operator names confirmed: equal(==), eq(=), assign(:=), neq, gt,
 * gte, lt, lte, startswith, endswith, contains, regex.match (compound ref).
 */

export type OpaTermType =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'var'
  | 'ref'
  | 'array'
  | 'set'
  | 'object'
  | 'call'
  | 'every'
  | 'arraycomprehension'
  | 'setcomprehension'
  | 'objectcomprehension';

export interface OpaLocation {
  file: string;
  row: number;
  col: number;
}

export interface OpaTerm {
  type: OpaTermType;
  value: OpaTermValue;
  location?: OpaLocation;
}

/**
 * Union of possible value shapes for each term type:
 *   null       → null
 *   boolean    → boolean
 *   number     → number
 *   string/var → string
 *   ref/array  → OpaTerm[]
 *   object     → Array<[OpaTerm, OpaTerm]>  (key-value pairs)
 *   call       → OpaTerm[]  (first element is the function ref)
 *   every      → OpaEvery
 *   *comprehension → OpaComprehension
 */
export type OpaTermValue =
  | null
  | boolean
  | number
  | string
  | OpaTerm[]
  | Array<[OpaTerm, OpaTerm]>
  | OpaEvery
  | OpaComprehension;

export interface OpaEvery {
  key?: OpaTerm;
  value: OpaTerm;
  domain: OpaTerm;
  body: OpaExpression[];
}

export interface OpaComprehension {
  term?: OpaTerm;
  key?: OpaTerm;
  value?: OpaTerm;
  body: OpaExpression[];
}

/**
 * A single expression in a rule body.
 *
 * `terms` is EITHER a single OpaTerm (bare expression: boolean literal,
 * var reference, or input ref truthiness check) OR an OpaTerm[] where the
 * first element is a ref to the operator/builtin and the rest are arguments.
 *
 * `negated: true` signals negation-as-failure (`not expr`).
 */
export interface OpaExpression {
  index: number;
  terms: OpaTerm | OpaTerm[];
  negated?: boolean;
  with?: unknown;
}

export interface OpaRuleHead {
  name: string;
  value?: OpaTerm;
  key?: OpaTerm;
  args?: OpaTerm[];
  assign?: boolean;
  ref?: OpaTerm[];
}

export interface OpaRule {
  head: OpaRuleHead;
  body: OpaExpression[];
  default?: boolean;
  else?: OpaRule;
}

export interface OpaModule {
  package: { path: OpaTerm[] };
  imports?: unknown[];
  rules: OpaRule[];
  comments?: unknown[];
}
