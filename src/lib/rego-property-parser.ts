/**
 * Parse and validate user-supplied verification property specs.
 *
 * The property spec drives what the SMT engine proves:
 *   always_true  - rule evaluates to true for EVERY possible input
 *                  (engine finds inputs where rule is false, expects UNSAT)
 *   never_true   - rule is never true for any input
 *                  (engine finds inputs where rule is true, expects UNSAT)
 *   satisfiable  - at least one input exists that makes rule true
 *                  (engine checks SAT directly, any model is a witness)
 */

export type PropertyKind = 'always_true' | 'never_true' | 'satisfiable';

export interface VerifyProperty {
  ruleName: string;
  kind: PropertyKind;
}

export interface PropertyParseError {
  field: string;
  message: string;
}

export interface PropertyParseResult {
  property: VerifyProperty | null;
  errors: PropertyParseError[];
}

const VALID_KINDS = new Set<PropertyKind>(['always_true', 'never_true', 'satisfiable']);

/**
 * Parse a raw property object from MCP tool input.
 * Returns errors array (non-empty = invalid).
 */
export function parseProperty(raw: unknown): PropertyParseResult {
  const errors: PropertyParseError[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ field: 'property', message: 'Must be an object with "rule" and "kind" fields.' });
    return { property: null, errors };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['rule'] !== 'string' || obj['rule'].trim() === '') {
    errors.push({ field: 'rule', message: 'Must be a non-empty string naming the Rego rule to verify.' });
  }

  if (typeof obj['kind'] !== 'string' || !VALID_KINDS.has(obj['kind'] as PropertyKind)) {
    errors.push({
      field: 'kind',
      message: `Must be one of: ${[...VALID_KINDS].join(', ')}.`,
    });
  }

  if (errors.length > 0) {
    return { property: null, errors };
  }

  return {
    property: {
      ruleName: (obj['rule'] as string).trim(),
      kind: obj['kind'] as PropertyKind,
    },
    errors: [],
  };
}

/**
 * Human-readable description of a property for use in result messages.
 */
export function describeProperty(property: VerifyProperty): string {
  switch (property.kind) {
    case 'always_true':
      return `"${property.ruleName}" is true for all possible inputs`;
    case 'never_true':
      return `"${property.ruleName}" is never true (always false/undefined) for any input`;
    case 'satisfiable':
      return `"${property.ruleName}" is true for at least one input`;
  }
}
