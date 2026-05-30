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
  head?: { name?: string; ref?: Array<{ value?: string; type?: string }> };
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

function makeTableSkeleton(
  packageName: string,
  ruleNames: string[],
  inputShape: InputShape,
): string {
  const lines: string[] = [];
  const testPackage = packageName ? `${packageName}_test` : 'main_test';
  lines.push(`package ${testPackage}`);
  lines.push('');
  lines.push('import rego.v1');
  if (packageName) {
    lines.push(`import data.${packageName}`);
  }
  lines.push('');
  const inputLiteral = shapeToRegoLiteral(inputShape);
  for (const name of ruleNames) {
    const safeName = name.replace(/[^a-zA-Z0-9_]/g, '_');
    const testName = `test_${safeName}`;
    const ruleRef = packageName ? `data.${packageName}.${name}` : `data.${name}`;
    const casesVar = `${safeName}_cases`;
    lines.push(`# TODO: add test cases -- one object per scenario.`);
    lines.push(`${casesVar} := [`);
    lines.push(`\t{`);
    lines.push(`\t\t"description": "TODO: describe what this case tests",`);
    lines.push(`\t\t"input": ${inputLiteral},`);
    lines.push(`\t\t"expected": true,`);
    lines.push(`\t},`);
    lines.push(`]`);
    lines.push('');
    lines.push(`${testName} if {`);
    lines.push(`\tevery tc in ${casesVar} {`);
    lines.push(`\t\tactual := ${ruleRef} with input as tc.input`);
    lines.push(`\t\tactual == tc.expected`);
    lines.push(`\t}`);
    lines.push(`}`);
    lines.push('');
  }
  return lines.join('\n');
}

function makeSkeleton(packageName: string, ruleNames: string[], inputShape: InputShape): string {
  const lines: string[] = [];
  const testPackage = packageName ? `${packageName}_test` : 'main_test';
  lines.push(`package ${testPackage}`);
  lines.push('');
  lines.push('import rego.v1');
  if (packageName) {
    lines.push(`import data.${packageName}`);
  }
  lines.push('');
  const inputLiteral = shapeToRegoLiteral(inputShape);
  for (const name of ruleNames) {
    const testName = `test_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const ruleRef = packageName ? `${packageName}.${name}` : name;
    lines.push(`# TODO: replace placeholder input with a realistic case.`);
    lines.push(`${testName} if {`);
    lines.push(`\tdata.${ruleRef} with input as ${inputLiteral}`);
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

        const testFile = tableStyle
          ? makeTableSkeleton(packageName, ruleNames, inputShape)
          : makeSkeleton(packageName, ruleNames, inputShape);

        return ok<RegoGenerateTestSkeletonOutput>({
          testFile,
          ruleNames,
          inferredInputShape: inputShape,
        });
      });
    },
  );
}
