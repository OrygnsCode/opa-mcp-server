/**
 * `rego_verify` -- formal SMT-based policy verification.
 *
 * Uses Microsoft Z3 (via WASM) to mathematically prove or disprove
 * a property about a Rego rule for ALL possible inputs. Returns a
 * concrete counterexample when the property fails.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, tryParseJson, withToolEnvelope } from '../../lib/tool-helpers.js';
import { parseProperty } from '../../lib/rego-property-parser.js';
import { runVerify, type VerifyResult } from '../../lib/rego-verify-engine.js';
import type { OpaModule } from '../../lib/rego-ast-types.js';

const RegoVerifyInput = {
  source: z.string().min(1).describe('Rego source to verify.'),
  rule: z.string().min(1).describe('Name of the rule to verify (e.g. "allow", "deny").'),
  kind: z
    .enum(['always_true', 'never_true', 'satisfiable'])
    .describe(
      'Property to prove:\n' +
        '  always_true  - rule is true for every possible input (finds inputs that violate this)\n' +
        '  never_true   - rule is never true for any input (finds inputs that trigger it)\n' +
        '  satisfiable  - at least one input exists where rule is true (returns a witness)',
    ),
};

export function registerRegoVerify(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_verify',
    {
      title: 'Formally verify a Rego policy rule',
      description:
        'Formally verify a property about a Rego rule using SMT solving (Microsoft Z3). ' +
        'Unlike testing, this checks ALL possible inputs and either proves the property holds or ' +
        'returns a concrete counterexample input that falsifies it. ' +
        'Supports equality, comparison, startswith, endswith, contains, and simple regex.match patterns ' +
        '(prefix: ^lit.*, suffix: .*lit$, exact: ^lit$, contains: .*lit.*, wildcard: .*). ' +
        'Complex regex patterns (character classes, quantifiers, alternation) return INCONCLUSIVE. ' +
        'Also reports INCONCLUSIVE for negation-as-failure (not), comprehensions, and other unsupported constructs.',
      inputSchema: RegoVerifyInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source, rule, kind }, { signal }) => {
      return withToolEnvelope<VerifyResult>(config, async () => {
        // Parse property spec
        const { property, errors: propErrors } = parseProperty({ rule, kind });
        if (propErrors.length > 0) {
          return err('INVALID_INPUT', 'Invalid property specification.', {
            details: { errors: propErrors },
          });
        }

        // Parse the Rego source via OPA
        const parseResult = await opa.parse({ source }, signal);
        const subprocessFailure = mapSubprocessFailure(parseResult, 'opa');
        if (subprocessFailure) return subprocessFailure;
        if (parseResult.exitCode !== 0) {
          return err('INVALID_REGO', 'opa parse rejected the policy source.', {
            hint: 'Fix syntax errors before verifying.',
            details: { stderr: parseResult.stderr.trim() },
          });
        }

        const ast = tryParseJson<OpaModule>(parseResult.stdout);
        if (ast === undefined) {
          return err('UNKNOWN_ERROR', 'opa parse produced no parseable JSON AST.');
        }

        // Run the verification pipeline
        const result = await runVerify(ast, property!, signal);

        const warnings: string[] = [...result.warnings];
        if (result.unsupportedConstructs.length > 0) {
          warnings.push(
            `${result.unsupportedConstructs.length} unsupported construct(s) were skipped: ` +
              result.unsupportedConstructs.map((u) => u.constructType).join(', '),
          );
        }

        return ok<VerifyResult>(result, warnings.length > 0 ? warnings : undefined);
      });
    },
  );
}
