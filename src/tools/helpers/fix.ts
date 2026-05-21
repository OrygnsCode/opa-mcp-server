/**
 * `rego_fix` -- run `regal fix` to auto-apply mechanical fixes for the
 * five rules regal 0.30.0 supports:
 *
 *   opa-fmt                    format the file (like opa fmt --write)
 *   use-rego-v1                add `import rego.v1` and update syntax
 *   use-assignment-operator    replace `=` with `:=` in rule heads
 *   no-whitespace-comment      add a space after `#` in comments
 *   directory-package-mismatch move the file to a path matching its package
 *
 * WARNING: `directory-package-mismatch` moves files on disk. The newPath
 * field in the output tells you where a file was moved. Run with
 * `dryRun: true` first to see what would change.
 *
 * Files with uncommitted git changes are refused unless `force: true`
 * is set. This is regal's own safety check, not ours.
 */
import { join } from 'node:path';
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { RegalCli } from '../../lib/regal-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoFixInput = {
  paths: z
    .array(z.string())
    .min(1)
    .describe(
      'Policy files or directories to fix. Each must be inside an allowed root (OPA_MCP_ALLOWED_PATHS).',
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Preview what would be fixed without modifying any files. Recommended before the first real run.',
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      'Allow fixing files that have uncommitted git changes, or when the project is not a git repository. Without this flag regal refuses to touch uncommitted files.',
    ),
  configFile: z.string().optional().describe('Path to a Regal config file (.regal/config.yaml).'),
  disable: z
    .array(z.string())
    .optional()
    .describe(
      'Disable specific fix rules. Useful to skip directory-package-mismatch if you do not want files moved.',
    ),
  enable: z.array(z.string()).optional().describe('Enable specific fix rules.'),
  disableCategory: z.array(z.string()).optional().describe('Disable all rules in a category.'),
  enableCategory: z.array(z.string()).optional().describe('Enable all rules in a category.'),
  ignoreFiles: z.array(z.string()).optional().describe('Glob patterns to exclude from fixing.'),
};

export interface FixedFile {
  /** Absolute path to the file that was (or would be) fixed. */
  path: string;
  /**
   * Present only when the file was moved by the directory-package-mismatch
   * fix. This is the absolute destination path.
   */
  newPath?: string;
  /** Which fix rules were applied to this file. */
  rules: string[];
}

export interface RegoFixOutput {
  /** Total number of individual rule fixes applied (or that would apply). */
  fixCount: number;
  /** Per-file breakdown of what was fixed. */
  fixedFiles: FixedFile[];
  /** Echoes the dryRun input so the caller knows whether files were written. */
  dryRun: boolean;
}

/**
 * Parse the plain-text output of `regal fix --no-color` into a structured
 * result. The format produced by regal 0.30.0 is:
 *
 *   No fixes to apply.
 *
 * or:
 *
 *   X fix(es) to apply:
 *   In project root: <absolute-root>
 *   <filename>[-> <new-relative-path>]:
 *   - <rule-name>
 *   ...
 */
export function parseFixOutput(stdout: string): { fixCount: number; fixedFiles: FixedFile[] } {
  const text = stdout.trim();

  if (!text || text === 'No fixes to apply.') {
    return { fixCount: 0, fixedFiles: [] };
  }

  const countMatch = /(\d+) fix(?:es)? to apply/.exec(text);
  if (!countMatch) return { fixCount: 0, fixedFiles: [] };
  const fixCount = parseInt(countMatch[1] ?? '0', 10);

  // Locate the summary block that starts with "In project root:"
  const rootIdx = text.indexOf('\nIn project root: ');
  if (rootIdx === -1) return { fixCount, fixedFiles: [] };

  const summaryLines = text.slice(rootIdx + 1).split('\n');
  const root = (summaryLines[0] ?? '').replace('In project root: ', '').trim();

  const fixedFiles: FixedFile[] = [];
  let current: FixedFile | null = null;

  for (let i = 1; i < summaryLines.length; i++) {
    const line = summaryLines[i];
    if (!line?.trim()) continue;

    if (line.trim().startsWith('- ')) {
      // Rule entry under the current file
      if (current) current.rules.push(line.trim().slice(2));
    } else if (line.trim().endsWith(':')) {
      // New file entry: "filename:" or "old -> new:"
      if (current) fixedFiles.push(current);
      const entry = line.trim().slice(0, -1); // strip trailing ":"
      const arrowIdx = entry.indexOf(' -> ');
      if (arrowIdx !== -1) {
        const oldName = entry.slice(0, arrowIdx).trim();
        const newName = entry.slice(arrowIdx + 4).trim();
        current = {
          path: join(root, oldName),
          newPath: join(root, newName),
          rules: [],
        };
      } else {
        current = { path: join(root, entry.trim()), rules: [] };
      }
    }
  }
  if (current) fixedFiles.push(current);

  return { fixCount, fixedFiles };
}

export function registerRegoFix(server: McpServer, config: Config): void {
  const regal = new RegalCli(config);

  server.registerTool(
    'rego_fix',
    {
      title: 'Auto-fix Rego violations',
      description:
        'Run regal fix to automatically apply mechanical fixes for the five rules regal 0.30.0 supports: opa-fmt, use-rego-v1, use-assignment-operator, no-whitespace-comment, and directory-package-mismatch. Use dryRun: true to preview changes before modifying files. NOTE: directory-package-mismatch moves files to match their package path -- use disable: ["directory-package-mismatch"] to skip it. Files with uncommitted git changes require force: true. Requires regal.',
      inputSchema: RegoFixInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (
      {
        paths,
        dryRun,
        force,
        configFile,
        disable,
        enable,
        disableCategory,
        enableCategory,
        ignoreFiles,
      },
      { signal },
    ) => {
      return withToolEnvelope<RegoFixOutput>(config, async () => {
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        let resolvedConfigFile: string | undefined;
        if (configFile) {
          const v = validatePaths([configFile], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedConfigFile = v.resolved[0];
        }

        const result = await regal.fix(
          {
            paths: validation.resolved,
            dryRun,
            force,
            configFile: resolvedConfigFile,
            disable,
            enable,
            disableCategory,
            enableCategory,
            ignoreFiles,
          },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'regal');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err('UNKNOWN_ERROR', 'regal fix failed.', {
            details: { stderr: result.stderr.trim(), exitCode: result.exitCode },
          });
        }

        const { fixCount, fixedFiles } = parseFixOutput(result.stdout);

        return ok<RegoFixOutput>({
          fixCount,
          fixedFiles,
          dryRun: dryRun ?? false,
        });
      });
    },
  );
}
