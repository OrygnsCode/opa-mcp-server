/**
 * Tool registration entry point.
 *
 * Each category module exports a `register*` function. They're called
 * here in order; ordering doesn't affect behavior but keeps the
 * declaration site tidy.
 *
 * Tools (47 total):
 *   Category A -- Authoring:        rego_format, rego_check, rego_lint,
 *                                   rego_parse_ast, rego_inspect,
 *                                   rego_capabilities, rego_deps
 *   Category B -- Evaluation:       rego_eval, rego_eval_with_explain,
 *                                   rego_eval_with_profile,
 *                                   rego_eval_with_coverage, rego_test,
 *                                   rego_bench, rego_compile_query
 *   Category C -- Bundles:          opa_bundle_build, opa_bundle_sign,
 *                                   opa_bundle_verify, opa_exec
 *   Category D -- Server mgmt:      opa_list_policies, opa_get_policy,
 *                                   opa_put_policy, opa_delete_policy,
 *                                   opa_get_data, opa_put_data,
 *                                   opa_patch_data, opa_delete_data,
 *                                   opa_query_decision, opa_compile_query,
 *                                   opa_health, opa_status, opa_config
 *   Category E -- Helpers:          rego_explain_decision,
 *                                   rego_generate_test_skeleton,
 *                                   rego_describe_policy,
 *                                   rego_suggest_fix,
 *                                   rego_coverage_gaps,
 *                                   rego_security_audit,
 *                                   rego_infer_input_schema,
 *                                   rego_fix, rego_format_write,
 *                                   rego_migrate_v1, rego_policy_diff
 *   Category F -- Conftest:         conftest_test, conftest_verify,
 *                                   conftest_pull, conftest_push
 *   Category G -- Meta:             mcp_server_info
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';
import { registerAuthoringTools } from './authoring/index.js';
import { registerBundleTools } from './bundles/index.js';
import { registerConftestTools } from './conftest/index.js';
import { registerEvaluationTools } from './evaluation/index.js';
import { registerHelperTools } from './helpers/index.js';
import { registerMetaTools } from './meta/index.js';
import { registerServerManagementTools } from './server-management/index.js';

export function registerTools(server: McpServer, config: Config): void {
  registerAuthoringTools(server, config);
  registerEvaluationTools(server, config);
  registerBundleTools(server, config);
  registerServerManagementTools(server, config);
  registerHelperTools(server, config);
  registerConftestTools(server, config);
  registerMetaTools(server, config);
}
