/**
 * `rego_describe_policy` -- parse a policy and return a structured
 * summary an agent can read without re-implementing AST traversal.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, tryParseJson, withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoDescribePolicyInput = {
  source: z.string().min(1).describe('Rego source to describe.'),
};

interface AstRefPart {
  value?: string;
  type?: string;
}

interface AstAnnotations {
  title?: string;
  description?: string;
  related_resources?: unknown[];
  authors?: unknown[];
  organizations?: unknown[];
}

interface AstRule {
  head?: {
    name?: string;
    ref?: AstRefPart[];
    value?: unknown;
    args?: unknown[];
  };
  default?: boolean;
  body?: unknown[];
  annotations?: AstAnnotations;
}

interface ParsedAst {
  package?: { path?: AstRefPart[] };
  imports?: Array<{ path?: { value?: AstRefPart[] }; alias?: string }>;
  rules?: AstRule[];
  annotations?: AstAnnotations[];
}

interface DescribedRule {
  name: string;
  /** True when any clause sharing this name is a `default` rule. */
  isDefault: boolean;
  /** Number of rule definitions (clauses) that share this name. */
  clauseCount: number;
  hasArgs: boolean;
  /** Total body expressions summed across every clause with this name. */
  bodyLength: number;
  annotations?: AstAnnotations;
}

export interface RegoDescribePolicyOutput {
  package: string;
  imports: string[];
  ruleCount: number;
  rules: DescribedRule[];
  packageAnnotations?: AstAnnotations[];
}

function refToString(parts: AstRefPart[] | undefined): string {
  if (!parts) return '';
  return parts
    .map((p) => (typeof p.value === 'string' ? p.value : ''))
    .filter(Boolean)
    .join('.');
}

export function registerRegoDescribePolicy(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_describe_policy',
    {
      title: 'Describe Rego policy',
      description:
        'Parse a Rego policy and return a structured summary: package, imports, and rules. Each rule reports clauseCount (how many definitions share the name), isDefault (true if any clause is a default), hasArgs, bodyLength (total body expressions across all clauses), and inline annotations. Useful as the first step in any "what does this policy do" workflow.',
      inputSchema: RegoDescribePolicyInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source }, { signal }) => {
      return withToolEnvelope<RegoDescribePolicyOutput>(config, async () => {
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

        const packageParts = ast.package?.path?.slice(1) ?? [];
        const packageName = refToString(packageParts);

        const imports = (ast.imports ?? []).map((imp) => {
          const path = refToString(imp.path?.value);
          return imp.alias ? `${path} as ${imp.alias}` : path;
        });

        const seen = new Map<string, DescribedRule>();
        for (const rule of ast.rules ?? []) {
          const name = rule.head?.name ?? refToString(rule.head?.ref);
          if (!name) continue;
          const isDefaultClause = rule.default === true;
          const hasArgsClause = Array.isArray(rule.head?.args) && (rule.head?.args.length ?? 0) > 0;
          const bodyLen = rule.body?.length ?? 0;
          const existing = seen.get(name);
          if (existing) {
            existing.clauseCount += 1;
            existing.bodyLength += bodyLen;
            existing.isDefault = existing.isDefault || isDefaultClause;
            existing.hasArgs = existing.hasArgs || hasArgsClause;
            if (!existing.annotations && rule.annotations) existing.annotations = rule.annotations;
            continue;
          }
          seen.set(name, {
            name,
            isDefault: isDefaultClause,
            clauseCount: 1,
            hasArgs: hasArgsClause,
            bodyLength: bodyLen,
            annotations: rule.annotations,
          });
        }
        const rules = [...seen.values()];

        return ok<RegoDescribePolicyOutput>({
          package: packageName,
          imports,
          ruleCount: rules.length,
          rules,
          packageAnnotations: ast.annotations,
        });
      });
    },
  );
}
