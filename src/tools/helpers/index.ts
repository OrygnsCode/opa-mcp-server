/**
 * Category E -- Higher-level helpers.
 *
 * These tools compose lower-level primitives or do mechanical AST
 * analysis to provide endpoints agents can call directly without
 * stitching together rego_eval / rego_check / rego_parse_ast
 * themselves.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { registerRegoCoverageGaps } from './coverage-gaps.js';
import { registerRegoDescribePolicy } from './describe-policy.js';
import { registerRegoExplainDecision } from './explain-decision.js';
import { registerRegoExplainUndefined } from './explain-undefined.js';
import { registerRegoFix } from './fix.js';
import { registerRegoFormatWrite } from './format-write.js';
import { registerRegoGenerateTestSkeleton } from './generate-test-skeleton.js';
import { registerRegoInferInputSchema } from './infer-input-schema.js';
import { registerRegoPolicyDiff } from './policy-diff.js';
import { registerRegoSecurityAudit } from './security-audit.js';
import { registerRegoSuggestFix } from './suggest-fix.js';
import { registerRegoPlaygroundShare } from './playground-share.js';
import { registerRegoVerify } from './verify.js';

export function registerHelperTools(server: McpServer, config: Config): void {
  registerRegoExplainDecision(server, config);
  registerRegoExplainUndefined(server, config);
  registerRegoGenerateTestSkeleton(server, config);
  registerRegoDescribePolicy(server, config);
  registerRegoSuggestFix(server, config);
  registerRegoCoverageGaps(server, config);
  registerRegoSecurityAudit(server, config);
  registerRegoInferInputSchema(server, config);
  registerRegoFix(server, config);
  registerRegoFormatWrite(server, config);
  registerRegoPolicyDiff(server, config);
  registerRegoVerify(server, config);
  registerRegoPlaygroundShare(server, config);
}
