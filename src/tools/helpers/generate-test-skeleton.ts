/**
 * `rego_generate_test_skeleton` -- given a policy, parse its AST and
 * emit a `*_test.rego` skeleton with one stub test per rule.
 *
 * The skeleton is mechanical -- the agent fills in real assertions.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, tryParseJson, withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoGenerateTestSkeletonInput = {
  source: z.string().min(1).describe('Rego source to generate tests for.'),
  tableStyle: z
    .boolean()
    .optional()
    .describe(
      'Generate table-driven test stubs instead of single-case stubs. Each rule gets a `cases` array and an `every tc in cases { ... }` assertion loop. Pair with `rego_test varValues: true` to see which case failed.',
    ),
};

interface AstPackage {
  path?: Array<{ value?: string; type?: string }>;
}

interface AstRule {
  head?: {
    name?: string;
    ref?: Array<{ value?: string; type?: string }>;
    key?: unknown;
    value?: { type?: string; value?: unknown };
    args?: unknown[];
  };
}

/**
 * What a rule produces, read from its head. A stub has to reference the rule
 * the way Rego allows and compare it to something of the right shape: a
 * function needs arguments or the whole test file fails to compile, and a
 * set or object is never `== true`.
 */
type RuleKind =
  | { kind: 'boolean' }
  | { kind: 'set' }
  | { kind: 'object' }
  | { kind: 'function'; arity: number }
  /** A value rule; `literal` is the head's value when it is a scalar literal. */
  | { kind: 'value'; literal?: string };

interface RuleStub {
  name: string;
  shape: RuleKind;
}

function ruleKindFromAst(rule: AstRule): RuleKind {
  const head = rule.head ?? {};
  if (Array.isArray(head.args)) return { kind: 'function', arity: head.args.length };
  const value = head.value;
  // A multi-segment ref is a dotted rule name, not a key.
  const keyed = head.key !== undefined;
  if (keyed) {
    // A keyed head with a value is a partial object (`perms[k] := v`); one
    // without, or with the implicit boolean, is a partial set (`deny contains x`).
    return value !== undefined && value.type !== 'boolean' ? { kind: 'object' } : { kind: 'set' };
  }
  if (value === undefined || value.type === 'boolean') return { kind: 'boolean' };
  if (value.type === 'string' || value.type === 'number' || value.type === 'null') {
    return { kind: 'value', literal: JSON.stringify(value.value ?? null) };
  }
  // A call, array, object or set: the type checker would reject a comparison
  // against a placeholder of the wrong type, so the stub asserts only that
  // the rule is defined.
  return { kind: 'value' };
}

/** The expression a stub compares against, and the reference it evaluates. */
function stubParts(
  ruleRef: string,
  shape: RuleKind,
): { reference: string; expected: string; note: string } {
  switch (shape.kind) {
    case 'function': {
      const args = Array.from({ length: shape.arity }, () => 'null').join(', ');
      return {
        reference: `${ruleRef}(${args})`,
        expected: 'true',
        note: `# TODO: replace the ${shape.arity} placeholder argument(s) and the expected value.`,
      };
    }
    case 'set':
      return {
        reference: ruleRef,
        expected: 'set()',
        note: '# Set rule: expected is the set of values, or set() when nothing should match.',
      };
    case 'object':
      return {
        reference: ruleRef,
        expected: '{}',
        note: '# Object rule: expected is the object of entries, or {} when nothing should match.',
      };
    case 'value':
      return shape.literal !== undefined
        ? {
            reference: ruleRef,
            expected: shape.literal,
            note: '# Value rule: the head assigns a value; expected is that value for this input.',
          }
        : {
            reference: ruleRef,
            expected: 'null',
            note: '# Value rule with a computed head: replace the placeholder with the expected value.',
          };
    case 'boolean':
      return {
        reference: ruleRef,
        expected: 'true',
        note: '# Boolean rule: expected is true or false; an undefined rule fails the comparison.',
      };
  }
}

interface ParsedAst {
  package?: AstPackage;
  rules?: AstRule[];
}

export interface RegoGenerateTestSkeletonOutput {
  testFile: string;
  ruleNames: string[];
  /** Inferred input shape derived from field accesses in the policy body. */
  inferredInputShape: Record<string, unknown>;
}

/** Nested template type for inferred input fields. */
interface InputShape {
  [key: string]: InputShape | null;
}

function packageNameFromAst(ast: ParsedAst): string {
  const parts = ast.package?.path ?? [];
  // The first entry is always `data`. Skip it.
  return parts
    .slice(1)
    .map((p) => (typeof p.value === 'string' ? p.value : ''))
    .filter(Boolean)
    .join('.');
}

function ruleNameFromAst(rule: AstRule): string | undefined {
  if (rule.head?.name) return rule.head.name;
  const ref = rule.head?.ref;
  if (Array.isArray(ref) && ref.length > 0) {
    return ref
      .map((p) => (typeof p.value === 'string' ? p.value : ''))
      .filter(Boolean)
      .join('.');
  }
  return undefined;
}

/**
 * Recursively walk any JSON value and record every `input.<field>...` path
 * found in OPA AST ref nodes. Builds a nested shape object where leaves are
 * `null` (placeholder to be filled in by the developer). Deeper paths take
 * precedence: a parent leaf is upgraded to an object if a deeper access is
 * found for the same key.
 */
function walkForInputRefs(value: unknown, shape: InputShape): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkForInputRefs(item, shape);
    return;
  }

  const obj = value as Record<string, unknown>;

  // Detect an OPA AST ref node starting with `input`.
  // Shape: { type: "ref", value: [{type:"var", value:"input"}, {type:"string", value:"field"}, ...] }
  if (
    obj['type'] === 'ref' &&
    Array.isArray(obj['value']) &&
    (obj['value'] as unknown[]).length >= 2
  ) {
    const parts = obj['value'] as Array<{ type?: string; value?: unknown }>;
    const head = parts[0];
    if (head?.type === 'var' && head?.value === 'input') {
      let current: InputShape = shape;
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i]!;
        // Only follow string-keyed accesses; var/number keys are dynamic.
        if (part.type !== 'string' || typeof part.value !== 'string') break;
        const key = part.value;
        const isLast = i === parts.length - 1;
        if (isLast) {
          // Don't downgrade an existing object to null (deeper access wins).
          if (!(key in current)) current[key] = null;
        } else {
          // Upgrade an existing null leaf to an object so we can go deeper.
          if (!(key in current) || current[key] === null) current[key] = {};
          const next = current[key];
          if (typeof next !== 'object' || next === null) break;
          current = next;
        }
      }
    }
  }

  for (const v of Object.values(obj)) {
    walkForInputRefs(v, shape);
  }
}

function inferInputShape(ast: ParsedAst): InputShape {
  const shape: InputShape = {};
  walkForInputRefs(ast, shape);
  return shape;
}

/** Serialize an InputShape to an inline Rego object literal. */
function shapeToRegoLiteral(shape: InputShape): string {
  const entries = Object.entries(shape);
  if (entries.length === 0) return '{}';
  const inner = entries
    .map(([k, v]) => `"${k}": ${v === null ? 'null' : shapeToRegoLiteral(v)}`)
    .join(', ');
  return `{${inner}}`;
}

function makeTableSkeleton(packageName: string, rules: RuleStub[], inputShape: InputShape): string {
  const lines: string[] = [];
  const testPackage = packageName ? `${packageName}_test` : 'main_test';
  lines.push(`package ${testPackage}`);
  lines.push('');
  lines.push('import rego.v1');
  // The stubs reference rules by their full data path, so an import of the
  // package would go unused, which opa check --strict rejects.
  lines.push('');
  const inputLiteral = shapeToRegoLiteral(inputShape);
  for (const { name, shape } of rules) {
    const safeName = name.replace(/[^a-zA-Z0-9_]/g, '_');
    const testName = `test_${safeName}`;
    const ruleRef = packageName ? `data.${packageName}.${name}` : `data.${name}`;
    const { reference, expected, note } = stubParts(ruleRef, shape);
    const casesVar = `${safeName}_cases`;
    lines.push(`# TODO: add test cases -- one object per scenario.`);
    lines.push(note);
    lines.push(`${casesVar} := [`);
    lines.push(`\t{`);
    lines.push(`\t\t"description": "TODO: describe what this case tests",`);
    lines.push(`\t\t"input": ${inputLiteral},`);
    lines.push(`\t\t"expected": ${expected},`);
    lines.push(`\t},`);
    lines.push(`]`);
    lines.push('');
    lines.push(`${testName} if {`);
    lines.push(`\tevery tc in ${casesVar} {`);
    lines.push(`\t\tactual := ${reference} with input as tc.input`);
    lines.push(`\t\tactual == tc.expected`);
    lines.push(`\t}`);
    lines.push(`}`);
    lines.push('');
  }
  return lines.join('\n');
}

function makeSkeleton(packageName: string, rules: RuleStub[], inputShape: InputShape): string {
  const lines: string[] = [];
  const testPackage = packageName ? `${packageName}_test` : 'main_test';
  lines.push(`package ${testPackage}`);
  lines.push('');
  lines.push('import rego.v1');
  // The stubs reference rules by their full data path, so an import of the
  // package would go unused, which opa check --strict rejects.
  lines.push('');
  const inputLiteral = shapeToRegoLiteral(inputShape);
  for (const { name, shape } of rules) {
    const testName = `test_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const ruleRef = packageName ? `data.${packageName}.${name}` : `data.${name}`;
    const { reference, expected, note } = stubParts(ruleRef, shape);
    lines.push(`# TODO: replace the placeholder input and expected value with a realistic case.`);
    lines.push(note);
    lines.push(`${testName} if {`);
    lines.push(`\tactual := ${reference} with input as ${inputLiteral}`);
    // A computed head has no typed placeholder; `!= null` type-checks for any
    // value and still fails when the rule is undefined.
    lines.push(
      shape.kind === 'value' && shape.literal === undefined
        ? '\tactual != null'
        : `\tactual == ${expected}`,
    );
    lines.push(`}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function registerRegoGenerateTestSkeleton(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_generate_test_skeleton',
    {
      title: 'Generate Rego test skeleton',
      description:
        'Generate a `*_test.rego` skeleton from a policy. Parses the AST, finds each non-test rule, and emits one stub test per rule. Existing `test_*` and `todo_test_*` rules are skipped automatically -- only testable production rules get stubs. The AST is walked to infer which `input.*` fields the policy accesses; the inferred shape is used as the placeholder `with input as {...}` in each stub, so the developer only needs to fill in realistic values rather than guess the structure. With `tableStyle: true`, each stub uses an `every tc in cases { ... }` loop so you can add multiple input/expected pairs without duplicating assertion code. The `inferredInputShape` field in the response shows the detected shape for reference.',
      inputSchema: RegoGenerateTestSkeletonInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source, tableStyle }, { signal }) => {
      return withToolEnvelope<RegoGenerateTestSkeletonOutput>(config, async () => {
        const result = await opa.parse({ source }, signal);
        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;
        if (result.exitCode !== 0) {
          return err('INVALID_REGO', 'opa parse rejected the source.', {
            details: { stderr: result.stderr.trim() },
          });
        }

        const ast = tryParseJson<ParsedAst>(result.stdout);
        if (ast === undefined) {
          return err('UNKNOWN_ERROR', 'opa parse produced no parseable JSON.');
        }

        const packageName = packageNameFromAst(ast);

        // Skip existing test rules -- they should not get test stubs generated for them.
        const ruleNames = Array.from(
          new Set(
            (ast.rules ?? [])
              .map(ruleNameFromAst)
              .filter(
                (n): n is string =>
                  typeof n === 'string' &&
                  n.length > 0 &&
                  !n.startsWith('test_') &&
                  !n.startsWith('todo_test_'),
              ),
          ),
        );

        if (ruleNames.length === 0) {
          return err('INVALID_INPUT', 'No testable rules found in the source -- nothing to test.');
        }

        // Infer input shape from AST ref accesses.
        const inputShape = inferInputShape(ast);

        // One stub per rule name, shaped by the first head that carries it.
        const stubs: RuleStub[] = ruleNames.map((name) => {
          const rule = (ast.rules ?? []).find((r) => ruleNameFromAst(r) === name);
          return { name, shape: rule ? ruleKindFromAst(rule) : { kind: 'boolean' } };
        });
        const testFile = tableStyle
          ? makeTableSkeleton(packageName, stubs, inputShape)
          : makeSkeleton(packageName, stubs, inputShape);

        return ok<RegoGenerateTestSkeletonOutput>({
          testFile,
          ruleNames,
          inferredInputShape: inputShape,
        });
      });
    },
  );
}
