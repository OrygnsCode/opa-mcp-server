/**
 * `rego_lint` — lint Rego with the optional `regal` binary.
 *
 * The only authoring tool that requires Regal. Returns
 * `REGAL_NOT_FOUND` with an install hint if the binary is missing.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { RegalCli } from '../../lib/regal-cli.js';
import { err, ok } from '../../lib/errors.js';
import {
  mapSubprocessFailure,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';

const RegoLintInput = {
  source: z.string().optional().describe('Inline Rego source. Mutually exclusive with `paths`.'),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Filesystem paths to lint. Each path must be inside an allowed root (OPA_MCP_ALLOWED_PATHS).',
    ),
  configFile: z
    .string()
    .optional()
    .describe('Path to a Regal config file (defaults to .regal/config.yaml lookup).'),
  disable: z.array(z.string()).optional().describe('Disable specific named rules.'),
  enable: z.array(z.string()).optional().describe('Enable specific named rules.'),
  disableCategory: z
    .array(z.string())
    .optional()
    .describe('Disable entire rule categories (e.g. style, idiomatic, bugs).'),
  enableCategory: z.array(z.string()).optional().describe('Enable entire rule categories.'),
  failLevel: z
    .enum(['error', 'warning'])
    .optional()
    .describe('Severity at which Regal returns a non-zero exit. Default: `error`.'),
  ignoreFiles: z.array(z.string()).optional().describe('Glob patterns to skip.'),
};

interface LintViolation {
  title?: string;
  description?: string;
  category?: string;
  level?: string;
  location?: unknown;
  related_resources?: unknown;
}

export interface RegoLintOutput {
  violations: LintViolation[];
  notices?: unknown[];
  summary?: unknown;
}

export function registerRegoLint(server: McpServer, config: Config): void {
  const regal = new RegalCli(config);

  server.registerTool(
    'rego_lint',
    {
      title: 'Lint Rego',
      description:
        'Lint Rego source with the Regal linter. Returns categorized violations (style, bugs, idiomatic, performance) with file/line locations. Requires `regal` on PATH or `REGAL_BINARY` set; returns REGAL_NOT_FOUND otherwise.',
      inputSchema: RegoLintInput,
    },
    async (input) => {
      return withToolEnvelope<RegoLintOutput>(config, async () => {
        const { source, paths } = input;
        if (!source && !paths?.length) {
          return err(
            'INVALID_INPUT',
            'rego_lint requires either `source` or at least one entry in `paths`.',
          );
        }
        if (source && paths?.length) {
          return err('INVALID_INPUT', 'rego_lint does not accept both `source` and `paths`.');
        }

        let resolvedPaths: string[] | undefined;
        if (paths?.length) {
          const validation = validatePaths(paths, config, { mustExist: true });
          if (!validation.ok) return validation.error;
          resolvedPaths = validation.resolved;
        }

        const result = await regal.lint({
          source,
          paths: resolvedPaths,
          configFile: input.configFile,
          disable: input.disable,
          enable: input.enable,
          disableCategory: input.disableCategory,
          enableCategory: input.enableCategory,
          failLevel: input.failLevel,
          ignoreFiles: input.ignoreFiles,
        });

        const subprocessFailure = mapSubprocessFailure(result, 'regal');
        if (subprocessFailure) return subprocessFailure;

        const parsed = tryParseJson<RegoLintOutput>(result.stdout);
        if (!parsed) {
          return err('UNKNOWN_ERROR', 'regal lint produced no parseable JSON output.', {
            details: { stderr: result.stderr.trim(), exitCode: result.exitCode },
          });
        }

        return ok<RegoLintOutput>({
          violations: parsed.violations ?? [],
          notices: parsed.notices,
          summary: parsed.summary,
        });
      });
    },
  );
}
