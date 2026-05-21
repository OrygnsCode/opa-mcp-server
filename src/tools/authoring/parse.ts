/**
 * `rego_parse_ast` -- parse Rego source to a JSON AST.
 *
 * Wraps `opa parse --format=json`. Useful for tools that want to walk
 * the structure of a policy programmatically (rule discovery, ref
 * extraction, etc.) without re-implementing the parser.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, tryParseJson, withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoParseAstInput = {
  source: z.string().min(1).describe('Rego source code to parse.'),
};

export interface RegoParseAstOutput {
  ast: unknown;
}

export function registerRegoParseAst(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_parse_ast',
    {
      title: 'Parse Rego to AST',
      description:
        'Parse Rego source to a JSON AST using `opa parse`. Returns the AST as a tree of nodes (package, imports, rules, expressions, terms). Use this when you need to introspect policy structure programmatically.',
      inputSchema: RegoParseAstInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source }, { signal }) => {
      return withToolEnvelope<RegoParseAstOutput>(config, async () => {
        const result = await opa.parse({ source }, signal);

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          const parsed = tryParseJson<{ errors?: unknown[] }>(result.stdout);
          return err('INVALID_REGO', 'opa parse rejected the source.', {
            details: parsed ?? { stderr: result.stderr.trim() },
          });
        }

        const ast = tryParseJson(result.stdout);
        if (ast === undefined) {
          return err('UNKNOWN_ERROR', 'opa parse produced no parseable JSON on stdout.', {
            details: { stdout: result.stdout.trim() },
          });
        }
        return ok<RegoParseAstOutput>({ ast });
      });
    },
  );
}
