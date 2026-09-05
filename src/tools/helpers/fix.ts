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
import { join, normalize } from 'node:path';
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
 * result. regal 0.30.0 prints one of:
 *
 *   No fixes to apply.        (dry run)
 *   No fixes applied.         (real run)
 *
 * or a count followed by one or more blocks, each headed by a project root:
 *
 *   X fix(es) to apply:       (dry run)
 *   X fix(es) applied:        (real run)
 *   In project root: <absolute-root>
 *   <path>[ -> <new-path>]:
 *   - <rule-name>
 *   ...
 *
 * Paths are relative to their block's root, or absolute when the root is
 * blank. A file that moves may be listed twice across blocks, once under its
 * old name with the arrow and once under its new one; that is one file.
 */
export function parseFixOutput(stdout: string): { fixCount: number; fixedFiles: FixedFile[] } {
  const text = stdout.trim();
  const firstLine = text.split('\n')[0]?.trim() ?? '';

  if (!text || /^No fixes (?:to apply|applied)\.$/.test(firstLine)) {
    return { fixCount: 0, fixedFiles: [] };
  }

  // A real run says "applied" where a dry run says "to apply". Reading only
  // the dry-run form reported every real run as having changed nothing.
  const countMatch = /^(\d+) fix(?:es)? (?:to apply|applied):?$/.exec(firstLine);
  if (!countMatch) return { fixCount: 0, fixedFiles: [] };
  const fixCount = parseInt(countMatch[1] ?? '0', 10);

  const fixedFiles: FixedFile[] = [];
  for (const block of text.split(/\n(?=In project root:)/).slice(1)) {
    const lines = block.split('\n');
    const root = (lines[0] ?? '').replace('In project root:', '').trim();
    const resolve = (name: string): string => (root ? join(root, name) : name);
    let current: FixedFile | null = null;

    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('- ')) {
        // Rule entry under the current file
        if (current) current.rules.push(line.slice(2));
      } else if (line.endsWith(':')) {
        // New file entry: "path:" or "old -> new:"
        if (current) fixedFiles.push(current);
        const entry = line.slice(0, -1);
        const arrowIdx = entry.indexOf(' -> ');
        current =
          arrowIdx === -1
            ? { path: resolve(entry.trim()), rules: [] }
            : {
                path: resolve(entry.slice(0, arrowIdx).trim()),
                newPath: resolve(entry.slice(arrowIdx + 4).trim()),
                rules: [],
              };
      }
    }
    if (current) fixedFiles.push(current);
  }

  return { fixCount, fixedFiles: foldMoved(fixedFiles) };
}

/**
 * Report a moved file once. regal lists a file that moves in every block that
 * touched it, with the arrow each time, so entries are grouped by original
 * path with their rules joined. An entry listed at a moved file's destination
 * without the arrow is folded into the move as well.
 */
function foldMoved(entries: FixedFile[]): FixedFile[] {
  const byPath = new Map<string, FixedFile>();
  for (const e of entries) {
    const key = normalize(e.path);
    const seen = byPath.get(key);
    if (seen === undefined) {
      byPath.set(key, { ...e, rules: [...e.rules] });
      continue;
    }
    for (const r of e.rules) if (!seen.rules.includes(r)) seen.rules.push(r);
    if (seen.newPath === undefined && e.newPath !== undefined) seen.newPath = e.newPath;
  }
  const merged = [...byPath.values()];
  const movers = new Map<string, FixedFile>();
  for (const e of merged) if (e.newPath) movers.set(normalize(e.newPath), e);
  const out: FixedFile[] = [];
  for (const e of merged) {
    const mover = e.newPath ? undefined : movers.get(normalize(e.path));
    if (mover) {
      for (const r of e.rules) if (!mover.rules.includes(r)) mover.rules.push(r);
      continue;
    }
    out.push(e);
  }
  return out;
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
        // Runs a project's custom Regal rules, which are Rego with the network built-ins.
        openWorldHint: true,
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
