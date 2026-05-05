/**
 * Category E — Higher-level helpers.
 *
 * These tools compose lower-level primitives and add AI-enabling logic.
 * They're the differentiation surface — what makes this MCP useful
 * beyond a thin CLI wrapper.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';

export function registerHelperTools(_server: McpServer, _config: Config): void {
  // Planned: rego_explain_decision, rego_generate_test_skeleton,
  //          rego_describe_policy, rego_suggest_fix
}
