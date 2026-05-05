/**
 * Category A — Authoring & static analysis.
 *
 * Tools in this category operate on Rego source code without requiring
 * a running OPA server. They wrap `opa fmt`, `opa check`, `opa parse`,
 * `opa inspect`, `opa capabilities`, `opa deps`, and the `regal` linter.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';

export function registerAuthoringTools(_server: McpServer, _config: Config): void {
  // Tools are registered incrementally during the build phase.
  // Planned: rego_format, rego_check, rego_lint, rego_parse_ast,
  //          rego_inspect, rego_capabilities, rego_deps
}
