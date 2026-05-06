/**
 * `rego_capabilities` — list OPA's built-in functions and feature flags.
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
      'A specific OPA capabilities version (e.g. "v0.69.0"). When neither flag is set, lists available versions.',
    ),
};

export interface RegoCapabilitiesOutput {
  builtins?: unknown[];
  future_keywords?: unknown[];
  features?: unknown[];
  wasm_abi_versions?: unknown[];
  versions?: string[];
}

export function registerRegoCapabilities(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_capabilities',
    {
      title: 'OPA capabilities',
      description:
        'Return OPA capabilities — the available builtins, future keywords, features, and WASM ABI versions. With `current: true`, returns the running OPA\'s capabilities. With `version: "v0.69.0"`, returns those of a specific version. With neither, lists available named versions.',
      inputSchema: RegoCapabilitiesInput,
    },
    async ({ current, version }) => {
      return withToolEnvelope<RegoCapabilitiesOutput>(config, async () => {
        if (current && version) {
          return err(
            'INVALID_INPUT',
            'rego_capabilities accepts at most one of `current` or `version`.',
          );
        }

        const result = await opa.capabilities({ current, version });
        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err(
            'INVALID_INPUT',
            'opa capabilities exited non-zero — `version` is likely unrecognized.',
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
        return ok<RegoCapabilitiesOutput>(parsed);
      });
    },
  );
}
