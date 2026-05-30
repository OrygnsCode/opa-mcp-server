/**
 * `rego_playground_share` -- publish a Rego policy as a public GitHub Gist
 * and return a shareable URL.
 *
 * Why Gist and not the OPA playground? Every endpoint on
 * play.openpolicyagent.org requires a GitHub OAuth session cookie -- there is
 * no public API key path. Gists are a natural substitute: they render Rego
 * with syntax highlighting, are forkable, and the raw URL is directly loadable
 * by OPA or Conftest.
 *
 * Requires a GitHub personal access token with the `gist` scope, supplied via
 * the GITHUB_TOKEN environment variable.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Config } from '../../config.js';
import { err, ok } from '../../lib/errors.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';

// ─── Input schema ─────────────────────────────────────────────────────────────

const RegoPlaygroundShareInput = {
  policy: z.string().min(1).describe('Rego source code to share (the contents of a .rego file).'),
  query: z
    .string()
    .optional()
    .describe(
      'Default query to evaluate against the policy, e.g. "data.authz.allow". ' +
        'Stored in metadata.json alongside the policy file.',
    ),
  input: z
    .string()
    .optional()
    .describe(
      'Input document as a JSON string. Stored in metadata.json alongside the policy file.',
    ),
  data: z
    .string()
    .optional()
    .describe('Data document as a JSON string. Stored in metadata.json alongside the policy file.'),
  description: z
    .string()
    .optional()
    .describe('Short description for the Gist (shown on github.com/gists).'),
};

// ─── Output types ─────────────────────────────────────────────────────────────

export interface RegoPlaygroundShareOutput {
  /** URL to the Gist page on github.com -- the primary shareable link. */
  gistUrl: string;
  /** Direct raw URL to the policy.rego file inside the Gist. */
  rawPolicyUrl: string;
  /** GitHub Gist ID. */
  id: string;
}

// ─── GitHub Gist API types ────────────────────────────────────────────────────

interface GistFile {
  content: string;
}

interface GistCreateBody {
  description: string;
  public: boolean;
  files: Record<string, GistFile>;
}

interface GistCreateResponse {
  id: string;
  html_url: string;
  files: Record<string, { raw_url?: string }>;
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerRegoPlaygroundShare(server: McpServer, _config: Config): void {
  server.registerTool(
    'rego_playground_share',
    {
      title: 'Share Rego policy as a GitHub Gist',
      description:
        'Share a Rego policy with teammates or create a reproducible example by publishing it ' +
        'as a public GitHub Gist. Returns { gistUrl, rawPolicyUrl, id }: the gistUrl renders ' +
        'the policy with syntax highlighting on github.com; the rawPolicyUrl can be passed ' +
        'directly to OPA (`opa eval -d <rawPolicyUrl> <query>`) or used as a data source in ' +
        'Conftest. When query, input, or data are supplied, a metadata.json file is bundled ' +
        'into the Gist so recipients have the full evaluation context to reproduce results. ' +
        'Each call creates a new Gist -- use the returned id to reference it later. ' +
        'Requires GITHUB_TOKEN in the environment (GitHub personal access token with the ' +
        '"gist" scope); returns GITHUB_TOKEN_MISSING with setup instructions if unset.',
      inputSchema: RegoPlaygroundShareInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ policy, query, input, data, description }, { signal }) => {
      return withToolEnvelope(_config, async () => {
        // ── Token check ────────────────────────────────────────────────────
        const token = process.env['GITHUB_TOKEN'];
        if (!token) {
          return err(
            'GITHUB_TOKEN_MISSING',
            'GITHUB_TOKEN environment variable is not set. ' +
              'A GitHub personal access token with the "gist" scope is required to create Gists.',
            {
              hint:
                'Create a token at https://github.com/settings/tokens (select "gist" scope), ' +
                'then set GITHUB_TOKEN in your shell or in the "env" block of your MCP client config.',
            },
          );
        }

        // ── Build Gist files ───────────────────────────────────────────────
        const files: Record<string, GistFile> = {
          'policy.rego': { content: policy },
        };

        // Attach supplementary context as a second file only when at least
        // one optional field was provided -- keeps single-file Gists clean.
        const metadata: Record<string, unknown> = {};
        if (query !== undefined) metadata['query'] = query;
        if (input !== undefined) metadata['input'] = input;
        if (data !== undefined) metadata['data'] = data;
        if (Object.keys(metadata).length > 0) {
          files['metadata.json'] = { content: JSON.stringify(metadata, null, 2) };
        }

        const body: GistCreateBody = {
          description: description ?? 'OPA Rego policy',
          public: true,
          files,
        };

        // ── POST to GitHub Gist API ────────────────────────────────────────
        let response: Response;
        try {
          response = await fetch('https://api.github.com/gists', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify(body),
            signal,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return err('UNKNOWN_ERROR', `GitHub Gist API request failed: ${message}`);
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return err(
            'GIST_CREATE_FAILED',
            `GitHub Gist creation failed with HTTP ${response.status.toString()}.`,
            { details: { status: response.status, body: text } },
          );
        }

        // ── Parse response ─────────────────────────────────────────────────
        let gist: GistCreateResponse;
        try {
          gist = (await response.json()) as GistCreateResponse;
        } catch {
          return err('GIST_CREATE_FAILED', 'GitHub returned an unparseable response body.');
        }

        const rawPolicyUrl = gist.files['policy.rego']?.raw_url ?? '';

        return ok<RegoPlaygroundShareOutput>({
          gistUrl: gist.html_url,
          rawPolicyUrl,
          id: gist.id,
        });
      });
    },
  );
}
