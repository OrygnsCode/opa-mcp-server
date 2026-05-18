/**
 * `rego_check` -- type-check Rego using `opa check`.
 *
 * Returns `{ valid: true }` when the policy passes. On failure,
 * returns the structured error report `opa check --format=json` writes
 * to its stderr stream.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import {
  mapSubprocessFailure,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';

const RegoCheckInput = {
  source: z.string().optional().describe('Inline Rego source. Mutually exclusive with `paths`.'),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Filesystem paths to check. Each path must be inside an allowed root (OPA_MCP_ALLOWED_PATHS).',
    ),
  strict: z
    .boolean()
    .optional()
    .describe('Enable strict mode -- fail on unused vars, deprecated builtins, etc.'),
  capabilities: z
    .string()
    .optional()
    .describe('Path to a capabilities JSON file restricting allowed builtins.'),
  schemaDir: z.string().optional().describe('Schema directory for input/data validation.'),
};

interface CheckErrorRecord {
  message?: string;
  code?: string;
  location?: { file?: string; row?: number; col?: number };
}

export interface RegoCheckOutput {
  valid: boolean;
  errors: CheckErrorRecord[];
}

export function registerRegoCheck(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_check',
    {
      title: 'Check Rego',
      description:
        'Type-check Rego with `opa check`. Returns `{ valid: true, errors: [] }` on success, or a list of structured diagnostics with file/line locations on failure. Provide either `source` for inline checking or `paths` for file/directory checking.',
      inputSchema: RegoCheckInput,
    },
    async ({ source, paths, strict, capabilities, schemaDir }) => {
      return withToolEnvelope<RegoCheckOutput>(config, async () => {
        if (!source && !paths?.length) {
          return err(
            'INVALID_INPUT',
            'rego_check requires either `source` or at least one entry in `paths`.',
          );
        }
        if (source && paths?.length) {
          return err(
            'INVALID_INPUT',
            'rego_check does not accept both `source` and `paths` -- pass one or the other.',
          );
        }

        let resolvedPaths: string[] | undefined;
        if (paths?.length) {
          const validation = validatePaths(paths, config, { mustExist: true });
          if (!validation.ok) return validation.error;
          resolvedPaths = validation.resolved;
        }

        const result = await opa.check({
          source,
          paths: resolvedPaths,
          strict,
          capabilities,
          schemaDir,
        });

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode === 0) {
          return ok<RegoCheckOutput>({ valid: true, errors: [] });
        }

        // `opa check --format=json` writes diagnostics to stderr.
        const parsed = tryParseJson<{ errors?: CheckErrorRecord[] }>(result.stderr);
        if (!parsed) {
          return err(
            'INVALID_REGO',
            'opa check exited non-zero but produced no parseable diagnostics.',
            { details: { stderr: result.stderr.trim(), stdout: result.stdout.trim() } },
          );
        }
        return ok<RegoCheckOutput>({ valid: false, errors: parsed.errors ?? [] });
      });
    },
  );
}
