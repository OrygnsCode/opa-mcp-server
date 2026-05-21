/**
 * `rego_format` -- format Rego source via `opa fmt`.
 *
 * Idempotent: running it on already-formatted source produces
 * identical output and `changed: false`.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, tryParseJson, withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoFormatInput = {
  source: z.string().min(1).describe('Rego source code to format.'),
};

export interface RegoFormatOutput {
  formatted: string;
  changed: boolean;
}

export function registerRegoFormat(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_format',
    {
      title: 'Format Rego',
      description:
        'Format Rego source code using `opa fmt`. Returns the formatted source and a `changed` flag indicating whether the input was already canonical.',
      inputSchema: RegoFormatInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source }, { signal }) => {
      return withToolEnvelope(config, async () => {
        const result = await opa.fmt({ source }, signal);

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          // `opa fmt` only fails when the source cannot be parsed.
          // The error report goes to stderr as JSON (or as plain text
          // for older OPA builds). Tools should surface whichever is
          // available.
          const parsedErrors = tryParseJson<{
            errors?: Array<{ message?: string; code?: string; location?: unknown }>;
          }>(result.stderr);
          return err(
            'INVALID_REGO',
            'opa fmt rejected the source; the input is not parseable Rego.',
            {
              details: parsedErrors ?? { stderr: result.stderr.trim() },
            },
          );
        }

        const formatted = result.stdout;
        return ok<RegoFormatOutput>({
          formatted,
          changed: formatted !== source,
        });
      });
    },
  );
}
