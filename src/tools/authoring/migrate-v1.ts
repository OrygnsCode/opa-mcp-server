/**
 * `rego_migrate_v1` -- migrate Rego v0 source to Rego v1 syntax.
 *
 * Two-phase execution:
 *   1. `opa fmt --rego-v1` auto-fixes reserved keywords (`if`, `contains`,
 *      `every`, `in`) and adds `import rego.v1` where missing.
 *   2. `opa check --v1-compatible` validates the migrated source and surfaces
 *      any remaining semantic issues that `opa fmt` cannot auto-fix.
 *
 * Returns the migrated source even when check finds remaining issues so the
 * caller can inspect the diff and decide how to resolve them.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, tryParseJson, withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoMigrateV1Input = {
  source: z
    .string()
    .min(1)
    .describe(
      'Rego v0 source to migrate to Rego v1 syntax. `opa fmt --rego-v1` auto-fixes reserved keywords and adds `import rego.v1`; any remaining issues are returned in `errors` so you can resolve them manually.',
    ),
};

interface CheckErrorRecord {
  message?: string;
  code?: string;
  location?: { file?: string; row?: number; col?: number };
}

export interface RegoMigrateV1Output {
  /** The source as provided -- returned for side-by-side comparison. */
  original: string;
  /** The source after `opa fmt --rego-v1`. Identical to `original` when no changes were needed. */
  migrated: string;
  /** Whether `opa fmt --rego-v1` changed anything. */
  changed: boolean;
  /** Whether `opa check --v1-compatible` found no errors in the migrated source. */
  valid: boolean;
  /** Structured errors from `opa check --v1-compatible`. Empty when `valid` is true. */
  errors: CheckErrorRecord[];
}

export function registerRegoMigrateV1(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_migrate_v1',
    {
      title: 'Migrate Rego to v1 syntax',
      description:
        'Migrate Rego v0 source to Rego v1 syntax in two phases: (1) `opa fmt --rego-v1` auto-fixes reserved keywords (`if`, `contains`, `every`, `in` in rule heads) and adds `import rego.v1`; (2) `opa check --v1-compatible` validates the migrated source and reports any remaining issues that cannot be auto-fixed (e.g. removed builtins, semantic conflicts). Returns the migrated source and a `changed` flag even when check finds remaining errors -- this lets you inspect what changed and fix the remainder manually. If the source is completely unparseable, returns `INVALID_REGO`.',
      inputSchema: RegoMigrateV1Input,
    },
    async ({ source }) => {
      return withToolEnvelope<RegoMigrateV1Output>(config, async () => {
        // Phase 1: migrate syntax with opa fmt --rego-v1.
        const fmtResult = await opa.fmt({ source, regoV1: true });

        const fmtFailure = mapSubprocessFailure(fmtResult, 'opa');
        if (fmtFailure) return fmtFailure;

        if (fmtResult.exitCode !== 0) {
          const parsedErrors = tryParseJson<{
            errors?: Array<{ message?: string; code?: string; location?: unknown }>;
          }>(fmtResult.stderr);
          return err(
            'INVALID_REGO',
            'opa fmt --rego-v1 could not parse the source. Fix syntax errors before migrating.',
            { details: parsedErrors ?? { stderr: fmtResult.stderr.trim() } },
          );
        }

        const migrated = fmtResult.stdout;
        const changed = migrated !== source;

        // Phase 2: validate the migrated source in v1-compatible mode.
        const checkResult = await opa.check({ source: migrated, v1Compatible: true });

        const checkFailure = mapSubprocessFailure(checkResult, 'opa');
        if (checkFailure) return checkFailure;

        if (checkResult.exitCode === 0) {
          return ok<RegoMigrateV1Output>({
            original: source,
            migrated,
            changed,
            valid: true,
            errors: [],
          });
        }

        // Check found remaining issues -- return them alongside the partial migration.
        const parsed = tryParseJson<{ errors?: CheckErrorRecord[] }>(checkResult.stderr);
        return ok<RegoMigrateV1Output>({
          original: source,
          migrated,
          changed,
          valid: false,
          errors: parsed?.errors ?? [],
        });
      });
    },
  );
}
