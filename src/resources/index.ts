/**
 * MCP Resources — read-only references the agent can fetch by URI.
 *
 * - opa://builtins      — derived at read-time from `opa capabilities`.
 * - opa://style-guide   — curated Rego style guide content.
 * - opa://patterns      — pattern library: RBAC, ABAC, K8s admission,
 *                         IaC gates, API authz, rate limiting.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';
import { OpaCli } from '../lib/opa-cli.js';
import { tryParseJson } from '../lib/tool-helpers.js';
import { STYLE_GUIDE } from './style-guide.js';
import { PATTERNS } from './patterns.js';

interface CapabilitiesShape {
  builtins?: Array<{
    name?: string;
    decl?: { args?: unknown[]; result?: unknown };
    categories?: string[];
  }>;
  future_keywords?: unknown[];
  features?: unknown[];
  wasm_abi_versions?: unknown[];
}

function categorizeBuiltins(caps: CapabilitiesShape): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const builtin of caps.builtins ?? []) {
    if (!builtin.name) continue;
    const categoryList = builtin.categories ?? [];
    if (categoryList.length === 0) {
      grouped['uncategorized'] ??= [];
      grouped['uncategorized'].push(builtin.name);
      continue;
    }
    for (const category of categoryList) {
      grouped[category] ??= [];
      grouped[category].push(builtin.name);
    }
  }
  for (const list of Object.values(grouped)) list.sort();
  return grouped;
}

const SECURITY_SENSITIVE = new Set([
  'http.send',
  'opa.runtime',
  'crypto.x509.parse_certificates',
  'crypto.x509.parse_certificate_request',
  'crypto.x509.parse_keypair',
  'crypto.x509.parse_rsa_private_key',
  'crypto.parse_private_keys',
]);

async function buildBuiltinsResource(opa: OpaCli): Promise<string> {
  const result = await opa.capabilities({ current: true });
  if (result.exitCode !== 0) {
    return JSON.stringify(
      {
        error: 'opa capabilities --current failed',
        stderr: result.stderr.trim(),
      },
      null,
      2,
    );
  }
  const caps = tryParseJson<CapabilitiesShape>(result.stdout);
  if (!caps) {
    return JSON.stringify({ error: 'opa capabilities produced no parseable JSON' }, null, 2);
  }

  const grouped = categorizeBuiltins(caps);
  const sensitive = (caps.builtins ?? [])
    .map((b) => b.name)
    .filter((n): n is string => typeof n === 'string' && SECURITY_SENSITIVE.has(n))
    .sort();

  return JSON.stringify(
    {
      version_note:
        'Derived at read time from `opa capabilities --current`. Reflects the OPA build linked into this MCP server, not necessarily the OPA the user has installed locally.',
      builtin_count: caps.builtins?.length ?? 0,
      categories: grouped,
      future_keywords: caps.future_keywords ?? [],
      features: caps.features ?? [],
      wasm_abi_versions: caps.wasm_abi_versions ?? [],
      security_sensitive_builtins: sensitive,
      security_note:
        'The functions in `security_sensitive_builtins` introduce side effects (HTTP fetches, crypto operations, runtime introspection). Use them sparingly in policy hot paths and confirm operator approval.',
    },
    null,
    2,
  );
}

export function registerResources(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerResource(
    'opa-builtins',
    'opa://builtins',
    {
      title: 'OPA built-in functions',
      description:
        'The OPA built-in function catalog, categorized by namespace, with security-sensitive functions flagged. Derived at read time from `opa capabilities --current` so the list stays in sync with the actual OPA binary.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const content = await buildBuiltinsResource(opa);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: content,
          },
        ],
      };
    },
  );

  server.registerResource(
    'opa-style-guide',
    'opa://style-guide',
    {
      title: 'Rego style guide',
      description:
        'Condensed Rego style guide adapted from the Styra reference: rego.v1, package layout, naming, default-deny, comprehensions vs every, schema annotations.',
      mimeType: 'text/markdown',
    },
    (uri) =>
      Promise.resolve({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: STYLE_GUIDE,
          },
        ],
      }),
  );

  server.registerResource(
    'opa-patterns',
    'opa://patterns',
    {
      title: 'Rego pattern library',
      description:
        'Curated Rego patterns: RBAC, ABAC, Kubernetes admission, IaC gates, API authorization, rate limiting. Each pattern includes when to use it, a full working example, a test, and common pitfalls.',
      mimeType: 'text/markdown',
    },
    (uri) =>
      Promise.resolve({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: PATTERNS,
          },
        ],
      }),
  );
}
