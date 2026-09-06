/**
 * `rego_capabilities` -- list OPA's built-in functions and feature flags.
 *
 * Useful as a reference when authoring policies, especially for
 * answering "is `crypto.x509.parse_certificates` available?" without
 * grepping the OPA repo.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, tryParseJson, withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoCapabilitiesInput = {
  current: z
    .boolean()
    .optional()
    .describe(
      'Print the capabilities of the currently installed OPA. Mutually exclusive with `version`.',
    ),
  version: z
    .string()
    .optional()
    .describe(
      'A specific OPA capabilities version (e.g. "v1.19.0"). When neither flag is set, lists available versions.',
    ),
  names_only: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'When true (default), return only builtin names, count, future keywords, and features. The full payload for every builtin is larger than the default response cap (OPA_MCP_MAX_RESPONSE_BYTES), so `names_only: false` on its own needs that cap raised; use `builtins` to get full records for a few names instead.',
    ),
  builtins: z
    .array(z.string().min(1))
    .min(1)
    // About 115 full records fit the default response cap.
    .max(100)
    .optional()
    .describe(
      'Return the full record (type signature, documentation, metadata) for up to 100 builtin names, exact matches only, which fits within the default response cap. `matched` counts the records returned and names not found are listed under `missing`. Implies `names_only: false`.',
    ),
};

export interface RegoCapabilitiesOutput {
  builtins?: unknown[];
  /** How many of the names in a `builtins` filter were found. */
  matched?: number;
  builtin_names?: string[];
  builtin_count?: number;
  future_keywords?: unknown[];
  features?: unknown[];
  wasm_abi_versions?: unknown[];
  versions?: string[];
  /** Names asked for through `builtins` that the capabilities do not hold. */
  missing?: string[];
}

export function registerRegoCapabilities(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_capabilities',
    {
      title: 'OPA capabilities',
      description:
        'Return OPA capabilities -- the available builtins, future keywords, features, and WASM ABI versions. With `current: true`, returns the running OPA\'s capabilities. With `version: "v1.19.0"`, returns those of a specific version. With neither, lists available named versions. By default (`names_only: true`), returns only builtin names and count to stay within response size limits. Pass `builtins: [...]` for the full type signatures and documentation of a few named builtins; `names_only: false` returns every full record, which needs OPA_MCP_MAX_RESPONSE_BYTES raised above its default.',
      inputSchema: RegoCapabilitiesInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ current, version, names_only, builtins }, { signal }) => {
      return withToolEnvelope<RegoCapabilitiesOutput>(config, async () => {
        if (current && version) {
          return err(
            'INVALID_INPUT',
            'rego_capabilities accepts at most one of `current` or `version`.',
          );
        }
        // The schema bounds the filter; the handler does too, before opa is
        // run, since the promise that the records fit the cap holds only up
        // to about 115 of them.
        if (builtins !== undefined && (builtins.length === 0 || builtins.length > 100)) {
          return err('INVALID_INPUT', '`builtins` takes between 1 and 100 names.');
        }

        const result = await opa.capabilities({ current, version }, signal);
        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err(
            'INVALID_INPUT',
            'opa capabilities exited non-zero -- `version` is likely unrecognized.',
            { details: { stderr: result.stderr.trim(), version } },
          );
        }

        // When listing versions (no flags), output is a newline-separated
        // list of names. Otherwise, output is JSON.
        const trimmed = result.stdout.trim();
        if (!current && !version) {
          const versions = trimmed.length === 0 ? [] : trimmed.split(/\r?\n/).filter(Boolean);
          return ok<RegoCapabilitiesOutput>({ versions });
        }

        const parsed = tryParseJson<RegoCapabilitiesOutput>(trimmed);
        if (parsed === undefined) {
          return err('UNKNOWN_ERROR', 'opa capabilities produced no parseable JSON output.', {
            details: { stdout: trimmed },
          });
        }

        // A handful of full records fits the cap where the whole payload does
        // not; this is the way to read a builtin's signature and docs.
        if (builtins !== undefined && builtins.length > 0) {
          const wanted = new Set(builtins);
          const records = (parsed.builtins ?? []).filter((b) =>
            wanted.has((b as { name?: string }).name ?? ''),
          );
          const found = new Set(records.map((b) => (b as { name?: string }).name));
          const missing = builtins.filter((n) => !found.has(n));
          return ok<RegoCapabilitiesOutput>({
            builtins: records,
            matched: records.length,
            ...(missing.length > 0 ? { missing } : {}),
          });
        }

        // names_only defaults to true; treat undefined as true so the default
        // applies even when the MCP SDK's schema validation is bypassed.
        if (names_only !== false) {
          const builtins = parsed.builtins ?? [];
          const builtin_names = builtins
            .map((b) => (b as { name?: string }).name)
            .filter((n): n is string => typeof n === 'string');
          return ok<RegoCapabilitiesOutput>({
            builtin_names,
            builtin_count: builtin_names.length,
            future_keywords: parsed.future_keywords,
            features: parsed.features,
            wasm_abi_versions: parsed.wasm_abi_versions,
          });
        }

        return ok<RegoCapabilitiesOutput>(parsed);
      });
    },
  );
}
