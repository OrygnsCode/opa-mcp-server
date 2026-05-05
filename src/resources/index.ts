/**
 * MCP Resources — read-only references the agent can query.
 *
 * Planned:
 *   opa://builtins      — categorized OPA built-in function reference
 *                         (~22 categories, 200+ functions). Security-
 *                         sensitive functions (http.send, crypto.x509.*,
 *                         opa.runtime) are flagged.
 *   opa://style-guide   — official Rego style guide, formatted for LLMs.
 *   opa://patterns      — curated common-pattern library (RBAC, ABAC,
 *                         K8s admission, IaC gates, API authz, rate
 *                         limiting). Each pattern: when-to-use, full
 *                         Rego example, test example, common pitfalls.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';

export function registerResources(_server: McpServer, _config: Config): void {
  // Resources are registered during the build phase.
}
