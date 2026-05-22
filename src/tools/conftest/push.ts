/**
 * `conftest_push` -- publish a local Rego policy bundle to an OCI registry.
 *
 * Teams that centralize policies in a registry use `conftest push` to
 * distribute them. The tool packages the local `policy/` directory as an
 * OCI artifact and pushes it to the specified repository. Registry
 * credentials are consumed from the host environment (docker login,
 * ORAS keychain, REGISTRY_AUTH_FILE, etc.) -- they are never passed
 * through the tool interface.
 *
 * Exit code mapping:
 *   null  -- binary not found → CONFTEST_NOT_FOUND
 *   0     -- push succeeded
 *   non-0 -- push error (auth failure, network error, etc.)
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { ConftestCli } from '../../lib/conftest-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const ConftestPushInput = {
  repository: z
    .string()
    .min(1)
    .describe(
      'OCI repository URL to push policies to (e.g. `ghcr.io/my-org/policies:latest`). ' +
        'Registry credentials must already be configured in the host environment ' +
        '(via `docker login`, ORAS keychain, or REGISTRY_AUTH_FILE). ' +
        'This tool does not accept or store registry credentials.',
    ),
  policy: z
    .string()
    .optional()
    .describe(
      'Path to the local directory containing Rego policies to push. ' +
        'Must be inside an allowed root (OPA_MCP_ALLOWED_PATHS) and must exist. ' +
        "Defaults to `./policy` (conftest's convention).",
    ),
};

export interface ConftestPushOutput {
  /** The OCI repository the policies were pushed to. */
  repository: string;
  /** The local policy directory that was packaged and pushed. */
  policyDir: string;
}

export function registerConftestPush(server: McpServer, config: Config): void {
  const conftest = new ConftestCli(config);

  server.registerTool(
    'conftest_push',
    {
      title: 'Conftest push',
      description:
        'Package the local Rego policy directory as an OCI artifact and push it to a registry ' +
        'using `conftest push`. Registry credentials must be pre-configured in the host ' +
        'environment (docker login, ORAS keychain, etc.) -- this tool never handles credentials. ' +
        'The `policy` directory must be inside OPA_MCP_ALLOWED_PATHS. ' +
        'Requires `conftest` on PATH or `CONFTEST_BINARY` set.',
      inputSchema: ConftestPushInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, { signal }) => {
      return withToolEnvelope<ConftestPushOutput>(config, async () => {
        // ── Path validation ──────────────────────────────────────────────
        if (input.policy !== undefined) {
          const v = validatePaths([input.policy], config, { mustExist: true });
          if (!v.ok) return v.error;
          input = { ...input, policy: v.resolved[0] };
        }

        // ── Run conftest push ────────────────────────────────────────────
        const result = await conftest.push(
          { repository: input.repository, policy: input.policy },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'conftest');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode === 0) {
          return ok<ConftestPushOutput>({
            repository: input.repository,
            policyDir: input.policy ?? 'policy',
          });
        }

        const detail = result.stderr.trim() || result.stdout.trim();
        return err(
          'UNKNOWN_ERROR',
          `conftest push failed with exit code ${result.exitCode}: ${detail}`,
          { details: { exitCode: result.exitCode, stderr: result.stderr.trim() } },
        );
      });
    },
  );
}
