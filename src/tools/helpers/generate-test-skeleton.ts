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

function makeSkeleton(packageName: string, ruleNames: string[]): string {
  const lines: string[] = [];
  const testPackage = packageName ? `${packageName}_test` : 'main_test';
  lines.push(`package ${testPackage}`);
  lines.push('');
  lines.push('import rego.v1');
  if (packageName) {
    lines.push(`import data.${packageName}`);
  }
  lines.push('');
  for (const name of ruleNames) {
    const testName = `test_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const ruleRef = packageName ? `${packageName}.${name}` : name;
    lines.push(`# TODO: replace placeholder input with a realistic case.`);
    lines.push(`${testName} if {`);
    lines.push(`\t# Arrange`);
    lines.push(`\tinput := {}`);
    lines.push('');
    lines.push(`\t# Act / Assert`);
    lines.push(`\tdata.${ruleRef} with input as input`);
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
        'Generate a `*_test.rego` skeleton from a policy. Parses the AST, finds each rule, and emits one stub test per rule. The agent fills in realistic inputs and assertions.',
      inputSchema: RegoGenerateTestSkeletonInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source }) => {
      return withToolEnvelope<RegoGenerateTestSkeletonOutput>(config, async () => {
        const result = await opa.parse({ source });
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
        const ruleNames = Array.from(
          new Set(
            (ast.rules ?? [])
              .map(ruleNameFromAst)
              .filter((n): n is string => typeof n === 'string' && n.length > 0),
          ),
        );

        if (ruleNames.length === 0) {
          return err('INVALID_INPUT', 'No rules found in the source -- nothing to test.');
        }

        const testFile = makeSkeleton(packageName, ruleNames);
        return ok<RegoGenerateTestSkeletonOutput>({ testFile, ruleNames });
      });
    },
  );
}
