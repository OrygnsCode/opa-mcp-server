/**
 * Category B — Evaluation & testing.
 *
 * Tools in this category run Rego queries against policies + input,
 * with optional trace/profile/coverage output. They wrap `opa eval`
 * and `opa test` and `opa bench`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';

export function registerEvaluationTools(_server: McpServer, _config: Config): void {
  // Tools are registered incrementally during the build phase.
  // Planned: rego_eval, rego_eval_with_explain, rego_eval_with_profile,
  //          rego_eval_with_coverage, rego_test, rego_bench,
  //          rego_compile_query
}
