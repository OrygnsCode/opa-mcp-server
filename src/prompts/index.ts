/**
 * MCP Prompts — slash-command-like instructions an agent receives when
 * a user invokes a named workflow.
 *
 * Planned:
 *   policy_authoring_assistant   — guide the agent through writing a new policy
 *   policy_review_checklist      — review checklist for an existing policy
 *   decision_debugging_workflow  — diagnostic flow for unexpected decisions
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';

export function registerPrompts(_server: McpServer, _config: Config): void {
  // Prompts are registered during the build phase.
}
