/**
 * `rego_inspect` -- inspect a bundle, directory, or single Rego file
 * via `opa inspect`. Returns the manifest (if present), namespaces,
 * and rule annotations as JSON.
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

const RegoInspectInput = {
  target: z
    .string()
    .min(1)
    .describe('Path to a bundle archive (`*.tar.gz`), directory, or single Rego file.'),
};

export interface RegoInspectOutput {
  manifest?: unknown;
  namespaces?: Record<string, unknown>;
  annotations?: unknown;
  signatures?: unknown;
}

export function registerRegoInspect(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_inspect',
    {
      title: 'Inspect bundle or policy',
      description:
        'Inspect an OPA bundle, policy directory, or single Rego file with `opa inspect`. Returns manifest data, namespaces, rule annotations, and (if signed) signature metadata.',
      inputSchema: RegoInspectInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ target }) => {
      return withToolEnvelope<RegoInspectOutput>(config, async () => {
        const validation = validatePaths([target], config, { mustExist: true });
        if (!validation.ok) return validation.error;
        const [resolved] = validation.resolved;

        const result = await opa.inspect({ target: resolved! });

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err(
            'INVALID_BUNDLE',
            'opa inspect rejected the target -- it is not a valid bundle, directory, or Rego file.',
            {
              details: { stderr: result.stderr.trim(), stdout: result.stdout.trim() },
            },
          );
        }

        const parsed = tryParseJson<RegoInspectOutput>(result.stdout);
        if (parsed === undefined) {
          return err('UNKNOWN_ERROR', 'opa inspect produced no parseable JSON output.', {
            details: { stdout: result.stdout.trim() },
          });
        }
        return ok<RegoInspectOutput>(parsed);
      });
    },
  );
}
