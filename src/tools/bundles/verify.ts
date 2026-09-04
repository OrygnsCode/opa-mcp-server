/**
 * `opa_bundle_verify` -- verify the signature of a signed OPA bundle.
 *
 * OPA has no standalone verify command. The check runs as
 * `opa build --verification-key` into a temp file that is discarded; see
 * `OpaCli.bundleVerify`. A directory is verified by name from its parent, the
 * same way `opa_bundle_sign` signs it. OPA reports the first failure it hits,
 * and the reason is classified into `details.reason` so a caller can tell a
 * wrong key from a tampered file.
 */
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { classifyVerificationFailure } from '../../lib/bundle-signatures.js';
import { err, ok } from '../../lib/errors.js';
import { OpaCli, type BundleVerifyInput } from '../../lib/opa-cli.js';
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
      'Path to the PEM file containing the RSA or ECDSA public key, or for HMAC algorithms a file holding the secret. Must be inside an allowed root.',
    ),
  verificationKeyId: z
    .string()
    .optional()
    .describe(
      'Name the key is registered under for OPA (`--verification-key-id`, default `default`). With a single key OPA verifies against it regardless of the signature keyid claim, so this rarely needs setting.',
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
      'Expected `scope` claim in the signature. Pass exactly the value the bundle was signed with, and nothing if it was signed without one; the failure reason is scope_mismatch otherwise.',
    ),
  v0Compatible: z
    .boolean()
    .optional()
    .describe(
      'Load the bundle as Rego v0 (`--v0-compatible`). A policy written before Rego v1 otherwise fails to load, after the signature and digests have already been checked.',
    ),
};

export interface OpaBundleVerifyOutput {
  bundle: string;
  verified: true;
}

export function registerOpaBundleVerify(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'opa_bundle_verify',
    {
      title: 'Verify OPA bundle signature',
      description:
        'Verify the signature of a signed bundle directory or `.tar.gz` archive with the public key. ' +
        'OPA has no standalone verify command, so this runs `opa build --verification-key` into a private temp file that is discarded. ' +
        'A directory is verified by name from its parent, matching how `opa_bundle_sign` signs it. ' +
        'OPA reads the key, checks the JWT in `.signatures.json`, compares the scope claim, then checks every file: Rego files by digest before parsing, data files and `.manifest` by parsed value, so an unparseable data file fails before its digest is compared. ' +
        'Failures return `INVALID_BUNDLE` with `details.reason` set to one of signature_invalid, scope_mismatch, file_modified, file_added, file_missing, file_unparseable, unsigned, signatures_malformed, not_a_bundle, bundle_load_error, or unknown when the message is not recognised; the raw output is in `details`. ' +
        'A key or algorithm OPA cannot use returns `INVALID_INPUT`. ' +
        'Pass `scope` exactly as the bundle was signed with. With a single key OPA does not check `verificationKeyId` against the signature keyid claim. ' +
        '`verified: true` is returned only when OPA loaded the bundle with its signature intact.',
      inputSchema: OpaBundleVerifyInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, { signal }) => {
      return withToolEnvelope<OpaBundleVerifyOutput>(config, async () => {
        const validation = validatePaths([input.bundle, input.verificationKey], config, {
          mustExist: true,
        });
        if (!validation.ok) return validation.error;
        const [resolvedBundle, resolvedKey] = validation.resolved;

        // Same resolution as the sign tool: OPA does not descend a symlink or
        // junction root, and a directory's signature names files under the
        // directory name, so a directory is loaded by name from its parent.
        const realBundle = await realpath(resolvedBundle!);
        const isDirectory = (await stat(realBundle)).isDirectory();

        const verifyInput: BundleVerifyInput = {
          bundle: isDirectory ? basename(realBundle) : realBundle,
          verificationKey: resolvedKey!,
        };
        if (isDirectory) verifyInput.cwd = dirname(realBundle);
        if (input.verificationKeyId !== undefined) {
          verifyInput.verificationKeyId = input.verificationKeyId;
        }
        if (input.signingAlg !== undefined) verifyInput.signingAlg = input.signingAlg;
        if (input.scope !== undefined) verifyInput.scope = input.scope;
        if (input.v0Compatible) verifyInput.v0Compatible = true;

        const result = await opa.bundleVerify(verifyInput, signal);

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          // opa build prints the reason on stdout, not stderr.
          const failure = classifyVerificationFailure(`${result.stdout}\n${result.stderr}`);
          const details = {
            reason: failure.reason,
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
          };
          if (failure.reason === 'key_invalid') {
            return err(
              'INVALID_INPUT',
              `The verification key or algorithm could not be used: ${failure.summary}.`,
              { hint: failure.hint, details },
            );
          }
          return err(
            'INVALID_BUNDLE',
            `Bundle signature verification failed: ${failure.summary}.`,
            { hint: failure.hint, details },
          );
        }

        return ok<OpaBundleVerifyOutput>({ bundle: input.bundle, verified: true });
      });
    },
  );
}
