/**
 * `opa_bundle_verify` -- verify the cryptographic signature of a signed
 * OPA bundle via `opa eval --bundle --verification-key`.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const OpaBundleVerifyInput = {
  bundle: z
    .string()
    .min(1)
    .describe(
      'Path to the signed bundle directory or `.tar.gz` archive. Must be inside an allowed root.',
    ),
  verificationKey: z
    .string()
    .min(1)
    .describe(
      'Path to the PEM file containing the RSA or ECDSA public key, or the path to the HMAC secret file. Must be inside an allowed root.',
    ),
  verificationKeyId: z
    .string()
    .optional()
    .describe(
      'Key ID that must match the `keyid` field in the bundle signature. Required when the bundle was signed with `--public-key-id`.',
    ),
  signingAlg: z
    .string()
    .optional()
    .describe(
      'Signing algorithm used when the bundle was signed (e.g. `RS256`, `PS256`, `ES256`, `HS256`). Defaults to `RS256`.',
    ),
  scope: z
    .string()
    .optional()
    .describe(
      'Expected `scope` value in the bundle signature. Required when the bundle was signed with `--scope`.',
    ),
};

export interface OpaBundleVerifyOutput {
  bundle: string;
  verified: boolean;
}

export function registerOpaBundleVerify(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'opa_bundle_verify',
    {
      title: 'Verify OPA bundle signature',
      description:
        'Verify the cryptographic signature of a signed OPA bundle using `opa eval --bundle --verification-key`. The bundle must have been signed with `opa sign` (or `opa_bundle_sign`). OPA checks the `.signatures.json` manifest inside the bundle against the provided public key before loading any policy -- a tampered or unsigned bundle will fail with `INVALID_BUNDLE`. Returns `{ bundle, verified: true }` on success.',
      inputSchema: OpaBundleVerifyInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      return withToolEnvelope<OpaBundleVerifyOutput>(config, async () => {
        const validation = validatePaths([input.bundle, input.verificationKey], config, {
          mustExist: true,
        });
        if (!validation.ok) return validation.error;

        const [resolvedBundle, resolvedKey] = validation.resolved;

        const result = await opa.bundleVerify({
          bundle: resolvedBundle!,
          verificationKey: resolvedKey!,
          verificationKeyId: input.verificationKeyId,
          signingAlg: input.signingAlg,
          scope: input.scope,
        });

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err('INVALID_BUNDLE', 'Bundle signature verification failed.', {
            details: {
              stderr: result.stderr.trim(),
              stdout: result.stdout.trim(),
            },
          });
        }

        return ok<OpaBundleVerifyOutput>({ bundle: input.bundle, verified: true });
      });
    },
  );
}
