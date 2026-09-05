/**
 * `conftest_pull` -- download Rego policies from an OCI registry or
 * other remote source into a local directory.
 *
 * Teams that publish policy bundles to a registry (e.g. ghcr.io or
 * Docker Hub) use `conftest pull` to hydrate the local `policy/`
 * directory before running `conftest test`. This tool exposes that
 * workflow so an LLM can fetch the latest policies and immediately
 * evaluate config files against them.
 *
 * The URL format follows conftest's conventions:
 *   oci://ghcr.io/org/policies:tag
 *   github.com/open-policy-agent/conftest//examples/playkube/policy
 *
 * Exit code mapping:
 *   null  -- binary not found → CONFTEST_NOT_FOUND
 *   0     -- pull succeeded
 *   non-0 -- network / auth error
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { ConftestCli } from '../../lib/conftest-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const ConftestPullInput = {
  url: z
    .string()
    .min(1)
    .describe(
      'Policy URL to pull. Supported schemes: ' +
        '`oci://registry/repo:tag` (OCI registry), ' +
        '`github.com/org/repo//path` (GitHub subdirectory), ' +
        '`git::https://example.com/repo//path` (generic Git). ' +
        'See https://www.conftest.dev/sharing/ for the full URL syntax.',
    ),
  policy: z
    .string()
    .optional()
    .describe(
      'Local directory where the pulled policies will be written. ' +
        'Must be inside an allowed root (OPA_MCP_ALLOWED_PATHS). ' +
        'Omitted, it falls back to `policy` in the working directory of the server process, the conftest convention, which must itself sit inside an allowed root. ' +
        'The directory is emptied before the pull, so do not point it at one holding anything ' +
        'you want to keep.',
    ),
};

export interface ConftestPullOutput {
  /** The URL that was pulled. */
  url: string;
  /** The local directory where policies were written. */
  policyDir: string;
}

/** Where conftest looks when `--policy` is not given, as an absolute path. */
const DEFAULT_POLICY_DIR = resolve('policy');

export function registerConftestPull(server: McpServer, config: Config): void {
  const conftest = new ConftestCli(config);

  server.registerTool(
    'conftest_pull',
    {
      title: 'Conftest pull',
      description:
        'Download Rego policies from an OCI registry or Git repository into a local directory ' +
        'using `conftest pull`. Use this to hydrate a local `policy/` directory before running ' +
        '`conftest_test`. Requires `conftest` on PATH or `CONFTEST_BINARY` set. ' +
        'The `policy` directory must be inside OPA_MCP_ALLOWED_PATHS. ' +
        'SECURITY: pulled policies are arbitrary Rego source that will be executed by ' +
        '`conftest_test`. Only pull from registries or repositories you own or explicitly ' +
        'trust -- malicious policy code can use OPA built-ins (http.send, opa.runtime) to ' +
        'exfiltrate data or make outbound network requests when the tests run.',
      inputSchema: ConftestPullInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, { signal }) => {
      return withToolEnvelope<ConftestPullOutput>(config, async () => {
        // ── Path validation ──────────────────────────────────────────────
        // The directory does not have to exist yet; conftest creates it. An
        // omitted path means conftest's own default, which it resolves against
        // the working directory. This tool writes files, so that default is
        // checked against the allow-list too rather than escaping it by being
        // implicit.
        const v = validatePaths([input.policy ?? DEFAULT_POLICY_DIR], config);
        if (!v.ok) {
          if (input.policy !== undefined) return v.error;
          return err(
            'PATH_NOT_ALLOWED',
            'The conftest default policy directory is outside the allowed roots.',
            {
              hint: 'Pass `policy` with a directory inside OPA_MCP_ALLOWED_PATHS.',
              details: { defaultPolicyDir: DEFAULT_POLICY_DIR },
            },
          );
        }
        const policyDir = v.resolved[0]!;

        // conftest runs from the parent, so the parent has to exist.
        await mkdir(dirname(policyDir), { recursive: true });

        // ── Run conftest pull ────────────────────────────────────────────
        const result = await conftest.pull({ url: input.url, policy: policyDir }, signal);

        const subprocessFailure = mapSubprocessFailure(result, 'conftest');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode === 0) {
          return ok<ConftestPullOutput>({
            url: input.url,
            policyDir,
          });
        }

        const detail = result.stderr.trim() || result.stdout.trim();
        return err(
          'UNKNOWN_ERROR',
          `conftest pull failed with exit code ${result.exitCode}: ${detail}`,
          { details: { exitCode: result.exitCode, stderr: result.stderr.trim() } },
        );
      });
    },
  );
}
