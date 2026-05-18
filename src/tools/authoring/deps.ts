/**
 * `rego_deps` -- static dependency analysis for a Rego ref.
 *
 * Wraps `opa deps`. Given a target like `data.example.allow`, returns
 * the base (input/data) and virtual (rule) document references the
 * target depends on. Helpful for impact analysis when a data shape
 * changes.
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

const RegoDepsInput = {
  paths: z
    .array(z.string())
    .min(1)
    .describe(
      'Policy / data paths to load before computing dependencies. Each must be inside an allowed root (OPA_MCP_ALLOWED_PATHS).',
    ),
  ref: z
    .string()
    .min(1)
    .describe('Reference to compute dependencies for, e.g. "data.example.allow".'),
};

export interface RegoDepsOutput {
  base?: unknown[];
  virtual?: unknown[];
}

export function registerRegoDeps(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_deps',
    {
      title: 'Rego dependency analysis',
      description:
        'Static dependency analysis for a Rego reference. Given a target ref like "data.example.allow", returns the base document references (input/data leaves) and virtual document references (rules) it depends on, transitively.',
      inputSchema: RegoDepsInput,
    },
    async ({ paths, ref }) => {
      return withToolEnvelope<RegoDepsOutput>(config, async () => {
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        const result = await opa.deps({ paths: validation.resolved, ref });
        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err(
            'INVALID_REGO',
            'opa deps exited non-zero -- the policy did not compile or the ref is invalid.',
            { details: { stderr: result.stderr.trim(), ref } },
          );
        }

        const parsed = tryParseJson<RegoDepsOutput>(result.stdout);
        if (parsed === undefined) {
          return err('UNKNOWN_ERROR', 'opa deps produced no parseable JSON output.', {
            details: { stdout: result.stdout.trim() },
          });
        }
        return ok<RegoDepsOutput>(parsed);
      });
    },
  );
}
