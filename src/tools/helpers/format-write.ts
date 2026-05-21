/**
 * `rego_format_write` -- run `opa fmt --write` to format Rego files in place.
 *
 * Two-phase execution:
 *   1. `opa fmt --list` identifies which files are not already canonical.
 *      If any file cannot be parsed this phase exits non-zero and we bail
 *      before touching the filesystem.
 *   2. `opa fmt --write` rewrites only those files (skipping the write when
 *      dryRun: true).
 *
 * NOTE: `--list` and `--write` are mutually exclusive OPA flags -- combining
 * them suppresses the write. The two calls are intentional.
 *
 * Supports `--rego-v1`, `--v0-compatible`, and `--v1-compatible` pass-through.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoFormatWriteInput = {
  paths: z
    .array(z.string())
    .min(1)
    .describe(
      'Policy files or directories to format in place. Each must be inside an allowed root (OPA_MCP_ALLOWED_PATHS).',
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Preview which files would be reformatted without modifying them. Recommended before the first real run.',
    ),
  regoV1: z
    .boolean()
    .optional()
    .describe(
      'Format module(s) to be compatible with both Rego v1 and the current OPA version. Adds `import rego.v1` where missing.',
    ),
  v0Compatible: z
    .boolean()
    .optional()
    .describe('Use OPA behaviors and syntax prior to the v1.0 release.'),
  v1Compatible: z.boolean().optional().describe('Use OPA v1.0-compatible behaviors.'),
};

export interface RegoFormatWriteOutput {
  /** Absolute paths of files that were (or would be) reformatted. */
  formattedFiles: string[];
  /** Number of files that were (or would be) reformatted. */
  formattedCount: number;
  /** When true, no files were modified -- this was a preview only. */
  dryRun: boolean;
}

/**
 * Parse the newline-delimited stdout produced by `opa fmt --list` into an
 * array of absolute file paths.
 */
export function parseFmtListOutput(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function registerRegoFormatWrite(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_format_write',
    {
      title: 'Format Rego files in place',
      description:
        'Run `opa fmt --write` to canonically format one or more Rego files or directories in place. Use `dryRun: true` to preview which files would change without modifying them. Returns a list of files that were (or would be) reformatted. Unlike `rego_format` which returns formatted source as a string, this tool writes directly to disk. Supports `regoV1`, `v0Compatible`, and `v1Compatible` flags for version-specific formatting. If any file cannot be parsed, the operation is aborted and no files are written.',
      inputSchema: RegoFormatWriteInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ paths, dryRun, regoV1, v0Compatible, v1Compatible }) => {
      return withToolEnvelope<RegoFormatWriteOutput>(config, async () => {
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        const fmtInput = {
          paths: validation.resolved,
          regoV1,
          v0Compatible,
          v1Compatible,
        };

        // Phase 1: identify which files would change. Also validates that all
        // files parse successfully before we touch the filesystem.
        const listResult = await opa.fmtList(fmtInput);

        const listFailure = mapSubprocessFailure(listResult, 'opa');
        if (listFailure) return listFailure;

        if (listResult.exitCode !== 0) {
          return err('INVALID_REGO', 'opa fmt could not parse one or more files.', {
            details: { stderr: listResult.stderr.trim(), exitCode: listResult.exitCode },
          });
        }

        const formattedFiles = parseFmtListOutput(listResult.stdout);

        if (dryRun) {
          return ok<RegoFormatWriteOutput>({
            formattedFiles,
            formattedCount: formattedFiles.length,
            dryRun: true,
          });
        }

        // Phase 2: nothing to write -- skip the subprocess call.
        if (formattedFiles.length === 0) {
          return ok<RegoFormatWriteOutput>({
            formattedFiles: [],
            formattedCount: 0,
            dryRun: false,
          });
        }

        // Phase 2: write.
        const writeResult = await opa.fmtWrite(fmtInput);

        const writeFailure = mapSubprocessFailure(writeResult, 'opa');
        if (writeFailure) return writeFailure;

        if (writeResult.exitCode !== 0) {
          return err('INVALID_REGO', 'opa fmt --write failed.', {
            details: { stderr: writeResult.stderr.trim(), exitCode: writeResult.exitCode },
          });
        }

        return ok<RegoFormatWriteOutput>({
          formattedFiles,
          formattedCount: formattedFiles.length,
          dryRun: false,
        });
      });
    },
  );
}
