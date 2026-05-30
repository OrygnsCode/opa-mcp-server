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

// ─── String interpolation version guard ─────────────────────────────────────

/** Returns true if the source uses OPA v1.12.0+ string interpolation syntax. */
function hasStringInterpolation(source: string): boolean {
  return source.includes('$"') || source.includes('$`');
}

/** Returns true if the source contains a literal \\{ that would be corrupted by the formatter bug. */
function hasEscapedBrace(source: string): boolean {
  return source.includes('\\{');
}

/**
 * Parse a semver string to its numeric components.
 * Pre-release suffixes (e.g. "1.12.0-dev") are ignored -- only the
 * M.N.P digits are examined. Returns null when the string does not
 * begin with three dot-separated integers.
 */
function parseVersion(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Returns true when the given OPA version string matches a release that
 * corrupts \\{ escape sequences in string interpolations during `opa fmt`.
 * Affected: 1.12.0, 1.12.1. Fixed: 1.12.2+.
 */
function isFormatterBugAffected(version: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  return v.major === 1 && v.minor === 12 && (v.patch === 0 || v.patch === 1);
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerRegoFormat(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_format',
    {
      title: 'Format Rego',
      description:
        'Format Rego source code using `opa fmt`. Returns the formatted source and a `changed` flag indicating whether the input was already canonical. ' +
        'When the source uses string interpolation ($"..." or $`...` syntax) and OPA v1.12.0 or v1.12.1 is detected, the tool warns about or blocks formatting due to a known OPA bug that corrupts \\{ escape sequences (fixed in OPA v1.12.2).',
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
        const warnings: string[] = [];

        // OPA v1.12.0 and v1.12.1 have a known `opa fmt` bug: \\{ escape
        // sequences inside string interpolations ($"..." syntax) are
        // silently stripped to {, producing invalid Rego output. The bug
        // was fixed in OPA v1.12.2. Check before formatting whenever the
        // source contains interpolation syntax, so we can block the
        // data-corrupting case or warn about the latent risk.
        if (hasStringInterpolation(source)) {
          const opaVersion = await opa.version(signal);
          if (opaVersion !== null && isFormatterBugAffected(opaVersion)) {
            if (hasEscapedBrace(source)) {
              return err(
                'OPA_VERSION_UNSUPPORTED',
                `opa fmt v${opaVersion} has a known bug that silently corrupts \\{ escape sequences inside string interpolations ($"..." syntax). Formatting would produce invalid Rego.`,
                {
                  hint: 'Upgrade OPA to v1.12.2 or later. The \\{ corruption bug was fixed in OPA v1.12.2.',
                  details: { opaVersion, affectedVersions: ['1.12.0', '1.12.1'] },
                },
              );
            }
            warnings.push(
              `OPA v${opaVersion} has a known formatter bug (fixed in v1.12.2): \\{ escape sequences inside string interpolations ($"..." syntax) are silently corrupted to { during formatting. Your source does not currently contain \\{ inside $"...", but upgrade OPA to v1.12.2 or later to prevent future issues.`,
            );
          }
        }

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
        return ok<RegoFormatOutput>(
          { formatted, changed: formatted !== source },
          warnings.length > 0 ? warnings : undefined,
        );
      });
    },
  );
}
