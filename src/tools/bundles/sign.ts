/**
 * `opa_bundle_sign` -- sign an existing bundle directory or archive
 * via `opa sign`.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const OpaBundleSignInput = {
  bundle: z
    .string()
    .min(1)
    .describe('Path to a bundle directory or archive. Must be in an allowed root.'),
  signingKey: z.string().min(1).describe('Path to the signing key.'),
  signingAlg: z.string().optional().describe('Signing algorithm (e.g. RS256). Default: RS256.'),
  claimsFile: z.string().optional().describe('Path to extra claims to include in the signature.'),
};

export interface OpaBundleSignOutput {
  signed: boolean;
  signaturesPath?: string;
}

export function registerOpaBundleSign(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'opa_bundle_sign',
    {
      title: 'Sign OPA bundle',
      description:
        'Sign an OPA bundle with a private key using `opa sign`. Writes a `.signatures.json` next to the bundle directory, or updates the archive in place.',
      inputSchema: OpaBundleSignInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, { signal }) => {
      return withToolEnvelope<OpaBundleSignOutput>(config, async () => {
        const validation = validatePaths(
          [input.bundle, input.signingKey, ...(input.claimsFile ? [input.claimsFile] : [])],
          config,
          { mustExist: true },
        );
        if (!validation.ok) return validation.error;

        const result = await opa.sign(
          {
            bundle: validation.resolved[0]!,
            signingKey: validation.resolved[1]!,
            signingAlg: input.signingAlg,
            claimsFile: input.claimsFile ? validation.resolved[2] : undefined,
          },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err('INVALID_BUNDLE', 'opa sign failed.', {
            details: { stderr: result.stderr.trim() },
          });
        }
        return ok<OpaBundleSignOutput>({ signed: true });
      });
    },
  );
}
