/**
 * Tool registration entry point.
 *
 * Each category module exports a `register*` function. They're called
 * here in order; ordering doesn't affect behavior but keeps the
 * declaration site tidy.
 *
 * Tools (52 total):
 *   Category A -- Authoring:        rego_format, rego_check,
 *                                   rego_check_schema, rego_lint,
 *                                   rego_parse_ast, rego_inspect,
 *                                   rego_capabilities, rego_deps,
 *                                   rego_migrate_v1
 *   Category B -- Evaluation:       rego_eval, rego_eval_with_explain,
 *                                   rego_eval_with_profile,
 *                                   rego_eval_with_coverage, rego_test,
 *                                   rego_test_multiroot, rego_bench,
 *                                   rego_compile_query
 *   Category C -- Bundles:          opa_bundle_build, opa_bundle_sign,
 *                                   opa_bundle_verify, opa_exec
 *   Category D -- Server mgmt:      opa_list_policies, opa_get_policy,
 *                                   opa_put_policy, opa_delete_policy,
 *                                   opa_get_data, opa_put_data,
 *                                   opa_patch_data, opa_delete_data,
 *                                   opa_query_decision, opa_compile_query,
 *                                   opa_health, opa_status, opa_config
 *   Category E -- Helpers:          rego_explain_decision,
 *                                   rego_explain_undefined,
 *                                   rego_generate_test_skeleton,
 *                                   rego_describe_policy,
 *                                   rego_suggest_fix,
 *                                   rego_coverage_gaps,
 *                                   rego_security_audit,
 *                                   rego_infer_input_schema,
 *                                   rego_fix, rego_format_write,
 *                                   rego_policy_diff, rego_verify,
 *                                   rego_playground_share
 *   Category F -- Conftest:         conftest_test, conftest_verify,
 *                                   conftest_pull, conftest_push
 *   Category G -- Meta:             mcp_server_info
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Config } from '../config.js';
import { CRASH_SITE, recordCrashSite } from '../lib/usage-stats.js';
import { registerAuthoringTools } from './authoring/index.js';
import { registerBundleTools } from './bundles/index.js';
import { registerConftestTools } from './conftest/index.js';
import { registerEvaluationTools } from './evaluation/index.js';
import { registerHelperTools } from './helpers/index.js';
import { registerMetaTools } from './meta/index.js';
import { registerServerManagementTools } from './server-management/index.js';

/**
 * Make every tool refuse arguments it does not declare. The SDK turns a raw
 * shape into a non-strict object, which drops unknown keys before the handler
 * runs: an `input_path` meant as rego_eval's `inputPath` was dropped and the
 * query evaluated with no input at all, and a misspelled `stirct` on
 * rego_check was ignored. The published schemas already say
 * `additionalProperties: false`; now the server holds to it.
 */
export function strictArguments(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
    ...args: unknown[]
  ) => {
    const [name, toolConfig, callback] = args as [unknown, { inputSchema?: unknown }, unknown];
    const shape = toolConfig.inputSchema;
    const strict =
      shape !== undefined && !(shape instanceof z.ZodType)
        ? z.object(shape as z.ZodRawShape).strict()
        : shape;
    return register(name, { ...toolConfig, inputSchema: strict }, callback);
  };
}

const registeredNames = new WeakMap<McpServer, Set<string>>();

/** The names of the tools registered on `server`. */
export function toolNames(server: McpServer): ReadonlySet<string> {
  return registeredNames.get(server) ?? new Set();
}

/**
 * Note each tool's name for usage stats, and hand on where an unexpected
 * error was thrown. The SDK sends a validated copy of a result, which drops
 * the CRASH_SITE marker, so it is recorded here under the request's id.
 */
export function trackTools(server: McpServer): void {
  const names = new Set<string>();
  registeredNames.set(server, names);
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
    ...args: unknown[]
  ) => {
    const [name, toolConfig, callback] = args;
    if (typeof name === 'string') names.add(name);
    if (typeof callback !== 'function') return register(...args);
    const handler = callback as (...a: unknown[]) => unknown;
    const watched = async (...cbArgs: unknown[]): Promise<unknown> => {
      const result = await handler(...cbArgs);
      const site = (result as Record<symbol, unknown> | undefined)?.[CRASH_SITE];
      const extra = cbArgs[cbArgs.length - 1] as { requestId?: unknown } | undefined;
      const id = extra?.requestId;
      if (typeof site === 'string' && (typeof id === 'string' || typeof id === 'number')) {
        recordCrashSite(id, site);
      }
      return result;
    };
    return register(name, toolConfig, watched);
  };
}

export function registerTools(server: McpServer, config: Config): void {
  strictArguments(server);
  trackTools(server);
  registerAuthoringTools(server, config);
  registerEvaluationTools(server, config);
  registerBundleTools(server, config);
  registerServerManagementTools(server, config);
  registerHelperTools(server, config);
  registerConftestTools(server, config);
  registerMetaTools(server, config);
}
