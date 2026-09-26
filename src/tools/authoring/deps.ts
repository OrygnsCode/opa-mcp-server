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
import { PRE_V1_SYNTAX } from '../_rego-version.js';
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ paths, ref }, { signal }) => {
      return withToolEnvelope<RegoDepsOutput>(config, async () => {
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        const result = await opa.deps({ paths: validation.resolved, ref }, signal);
        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          const stderr = result.stderr.trim();
          return err(
            'INVALID_REGO',
            'opa deps exited non-zero -- the policy did not compile or the ref is invalid.',
            {
              // opa deps has no --v0-compatible, unlike the other commands.
              ...(PRE_V1_SYNTAX.test(stderr)
                ? {
                    hint: 'The policy looks like pre-1.0 Rego, and opa deps reads Rego v1 only. Migrate it with rego_migrate_v1 first.',
                  }
                : {}),
              details: { stderr, ref },
            },
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
