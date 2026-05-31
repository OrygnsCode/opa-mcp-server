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
        "Defaults to `./policy` (conftest's convention).",
    ),
};

export interface ConftestPullOutput {
  /** The URL that was pulled. */
  url: string;
  /** The local directory where policies were written. */
  policyDir: string;
}

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
        // The policy directory does not have to exist yet -- conftest will
        // create it. Validate only that the parent is within allowed roots
        // by validating the path itself (without mustExist).
        if (input.policy !== undefined) {
          const v = validatePaths([input.policy], config);
          if (!v.ok) return v.error;
          input = { ...input, policy: v.resolved[0] };
        }

        // ── Run conftest pull ────────────────────────────────────────────
        const result = await conftest.pull({ url: input.url, policy: input.policy }, signal);

        const subprocessFailure = mapSubprocessFailure(result, 'conftest');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode === 0) {
          return ok<ConftestPullOutput>({
            url: input.url,
            policyDir: input.policy ?? 'policy',
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
