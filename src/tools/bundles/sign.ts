/**
 * `opa_bundle_sign` -- sign a bundle directory or archive via `opa sign`.
 *
 * `opa sign` writes `.signatures.json` to `--output-file-path`, which defaults
 * to the process working directory, so the location is always passed. A
 * directory bundle is signed in place, by name from its parent directory:
 * OPA records each file as `<name>/<file>` exactly as the path was given, and
 * only ever reads the signature from inside the bundle, so this is the one
 * form that verifies wherever the directory is placed under that name.
 * Success is reported only after the file is observed on disk.
 */
import type { Stats } from 'node:fs';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { isKeyOrAlgorithmError, readSignaturesSummary } from '../../lib/bundle-signatures.js';
import { err, ok } from '../../lib/errors.js';
import { OpaCli, type SignInput } from '../../lib/opa-cli.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const SIGNATURES_FILE = '.signatures.json';

/**
 * How far before the call a pre-existing `.signatures.json` may have been
 * modified and still count as written by this call. Filesystems with coarse
 * timestamps (FAT: 2s, HFS+: 1s) can report an unchanged mtime for a rewrite
 * inside the same tick, and a clock only ever compares against itself here.
 */
const MTIME_SLACK_MS = 2000;

const OpaBundleSignInput = {
  bundle: z
    .string()
    .min(1)
    .describe('Path to a bundle directory or `.tar.gz` archive. Must be inside an allowed root.'),
  signingKey: z
    .string()
    .min(1)
    .describe(
      'Path to the PEM private key (RSA or ECDSA), or for HMAC algorithms a file holding the secret. Must be inside an allowed root.',
    ),
  signingAlg: z
    .string()
    .optional()
    .describe(
      'Signing algorithm: RS256 (default), RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512, HS256, HS384, HS512.',
    ),
  claimsFile: z
    .string()
    .optional()
    .describe(
      'Path to a JSON file of extra claims to sign, such as {"keyid": "...", "scope": "..."}. Must be inside an allowed root.',
    ),
  outputDir: z
    .string()
    .optional()
    .describe(
      "For an archive, the directory that receives `.signatures.json`; defaults to the archive's own directory. Must exist and be inside an allowed root. Not accepted for a directory bundle, which is signed in place.",
    ),
};

export interface OpaBundleSignOutput {
  signed: true;
  /** Absolute path of the `.signatures.json` that was written. */
  signaturesPath: string;
  /** JWT algorithm recorded in the signature header. */
  algorithm: string;
  /** Number of files the signature covers. */
  filesSigned: number;
  keyId?: string;
  scope?: string;
}

/** lstat, so a symlink is reported as itself rather than as its target. */
async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

export function registerOpaBundleSign(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'opa_bundle_sign',
    {
      title: 'Sign OPA bundle',
      description:
        'Sign a bundle directory or `.tar.gz` archive with `opa sign`. ' +
        'A directory is signed in place: `.signatures.json` is written into it and files are recorded as `<directory name>/<file>`, so the signed directory verifies wherever it is placed as long as its name is unchanged, with `opa_bundle_verify` or with `opa build` or `opa run --bundle <name>` from its parent. ' +
        "For an archive the signature is written beside it, into `outputDir` or the archive's own directory, and the archive is not modified; a signed archive comes from `opa_bundle_build` with `signingKey`. " +
        'The key is a PEM private key (RSA or ECDSA); for HMAC algorithms pass a file holding the secret. Extra claims such as `keyid` and `scope` come from `claimsFile`. ' +
        'Returns the path written, the algorithm, and the number of files covered.',
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
        const [resolvedBundle, resolvedKey, resolvedClaims] = validation.resolved;

        // validatePath returns the path as given once its real target is
        // inside an allowed root. OPA's directory walk does not descend a
        // symlink or junction root, so a linked bundle would sign as an empty
        // file list; the real path is what gets signed.
        const realBundle = await realpath(resolvedBundle!);
        const isDirectory = (await stat(realBundle)).isDirectory();

        let outputDir: string;
        if (isDirectory) {
          if (input.outputDir !== undefined) {
            return err(
              'INVALID_INPUT',
              `outputDir applies to archives only. A directory bundle is signed in place, since OPA reads ${SIGNATURES_FILE} from inside the bundle and cannot use a detached one.`,
              { details: { bundle: input.bundle } },
            );
          }
          outputDir = realBundle;
        } else {
          // The archive's own directory is derived from the path as given,
          // not from the real path: an allowed root that is itself a symlink
          // or a Windows short name (a macOS /var, an 8.3 temp directory)
          // would otherwise fail the syntactic containment check against its
          // own canonical form. Validation resolves the symlink itself.
          const requested = input.outputDir ?? dirname(resolvedBundle!);
          const outputValidation = validatePaths([requested], config, { mustExist: true });
          if (!outputValidation.ok) return outputValidation.error;
          outputDir = outputValidation.resolved[0]!;
          if (!(await stat(outputDir)).isDirectory()) {
            return err('INVALID_INPUT', 'outputDir must be an existing directory.', {
              details: { outputDir },
            });
          }
        }

        const signaturesPath = join(outputDir, SIGNATURES_FILE);

        // The directory is inside an allowed root, but the file inside it need
        // not be: a pre-existing `.signatures.json` that is a symlink would
        // have opa write through it to wherever it points.
        const before = await lstatOrUndefined(signaturesPath);
        if (before?.isSymbolicLink()) {
          return err(
            'PATH_NOT_ALLOWED',
            `${SIGNATURES_FILE} at the output location is a symbolic link; refusing to write through it.`,
            { details: { signaturesPath } },
          );
        }
        const startedAt = Date.now();

        const signInput: SignInput = {
          bundle: isDirectory ? basename(realBundle) : realBundle,
          signingKey: resolvedKey!,
          outputDir,
        };
        if (isDirectory) signInput.cwd = dirname(realBundle);
        if (input.signingAlg !== undefined) signInput.signingAlg = input.signingAlg;
        if (resolvedClaims !== undefined) signInput.claimsFile = resolvedClaims;
        const result = await opa.sign(signInput, signal);

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        // opa prints its own errors on stdout, so both streams are kept.
        const streams = { stderr: result.stderr.trim(), stdout: result.stdout.trim() };
        if (result.exitCode !== 0) {
          if (isKeyOrAlgorithmError(`${result.stdout}\n${result.stderr}`)) {
            return err('INVALID_INPUT', 'The signing key or algorithm could not be used.', {
              hint: 'signingKey must be a PEM private key, or for HS256, HS384 and HS512 a file holding the secret, and signingAlg one OPA supports.',
              details: streams,
            });
          }
          return err('INVALID_BUNDLE', 'opa sign failed.', { details: streams });
        }

        // Exit 0 is not the claim; the file is. A signature that was not
        // written, or a stale one from an earlier run, must not be reported
        // as this call's work.
        const after = await lstatOrUndefined(signaturesPath);
        if (after?.isSymbolicLink()) {
          // A link planted between the check above and opa's write has
          // already been followed. Say so, and do not report success.
          const target = await readlink(signaturesPath).catch(() => undefined);
          return err(
            'PATH_NOT_ALLOWED',
            `${SIGNATURES_FILE} at the output location became a symbolic link while opa ran; the signature may have been written to its target. Not reporting success.`,
            { details: { signaturesPath, target } },
          );
        }
        const written =
          after !== undefined &&
          (before === undefined || after.mtimeMs >= startedAt - MTIME_SLACK_MS);
        if (!written) {
          return err('UNKNOWN_ERROR', `opa sign exited 0 but did not write ${SIGNATURES_FILE}.`, {
            details: { signaturesPath, ...streams },
          });
        }

        let summary;
        try {
          summary = await readSignaturesSummary(signaturesPath);
        } catch (e) {
          return err(
            'UNKNOWN_ERROR',
            `opa sign wrote a ${SIGNATURES_FILE} this tool could not read.`,
            { details: { signaturesPath, error: e instanceof Error ? e.message : String(e) } },
          );
        }

        // A signature over nothing is what an empty directory produces. It
        // verifies nothing and is not worth reporting as success.
        if (summary.filesSigned === 0) {
          return err('INVALID_BUNDLE', 'opa sign covered no files: the bundle is empty.', {
            details: { signaturesPath },
          });
        }

        const output: OpaBundleSignOutput = {
          signed: true,
          signaturesPath,
          algorithm: summary.algorithm,
          filesSigned: summary.filesSigned,
        };
        if (summary.keyId !== undefined) output.keyId = summary.keyId;
        if (summary.scope !== undefined) output.scope = summary.scope;
        return ok<OpaBundleSignOutput>(output);
      });
    },
  );
}
