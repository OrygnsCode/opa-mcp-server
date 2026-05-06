/**
 * Category E — Higher-level helpers.
 *
 * These tools compose lower-level primitives or do mechanical AST
 * analysis to provide endpoints agents can call directly without
 * stitching together rego_eval / rego_check / rego_parse_ast
 * themselves.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { registerRegoDescribePolicy } from './describe-policy.js';
import { registerRegoExplainDecision } from './explain-decision.js';
import { registerRegoGenerateTestSkeleton } from './generate-test-skeleton.js';
import { registerRegoSuggestFix } from './suggest-fix.js';

export function registerHelperTools(server: McpServer, config: Config): void {
  registerRegoExplainDecision(server, config);
  registerRegoGenerateTestSkeleton(server, config);
  registerRegoDescribePolicy(server, config);
  registerRegoSuggestFix(server, config);
}
