/**
 * Annotation invariants across every registered tool. A tool that runs Rego
 * can reach the network through http.send, so it must not present itself as
 * closed-world or read-only. Every registered tool has to appear in one of
 * the three lists below, so a new tool cannot arrive with a copy-pasted
 * annotation block and pass unnoticed.
 */
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../../src/server.js';
import { baseConfig, getToolAnnotations, registeredToolNames } from './_helpers.js';

/** Tools that evaluate Rego: OPA's own, conftest's, and Regal's custom rules. */
const EVALUATING = [
  'rego_eval',
  'rego_eval_with_explain',
  'rego_eval_with_profile',
  'rego_eval_with_coverage',
  'rego_test',
  'rego_test_multiroot',
  'rego_bench',
  'rego_compile_query',
  'opa_exec',
  'rego_explain_decision',
  'rego_explain_undefined',
  'rego_policy_diff',
  'rego_coverage_gaps',
  'conftest_test',
  'conftest_verify',
  'rego_lint',
  'rego_security_audit',
  'rego_fix',
];

/** Static tools: parse, format, check, or in-process analysis only. */
const STATIC = [
  'rego_parse_ast',
  'rego_check',
  'rego_format',
  'rego_verify',
  'rego_describe_policy',
  'rego_infer_input_schema',
  'rego_generate_test_skeleton',
  'rego_suggest_fix',
  'rego_capabilities',
  'rego_migrate_v1',
];

/**
 * Everything else: server-management calls, bundle handling, sharing, meta.
 * Their annotations describe what the call does to the thing it addresses.
 */
const OTHER = [
  'conftest_pull',
  'conftest_push',
  'mcp_server_info',
  'opa_bundle_build',
  'opa_bundle_sign',
  'opa_bundle_verify',
  'opa_compile_query',
  'opa_config',
  'opa_delete_data',
  'opa_delete_policy',
  'opa_get_data',
  'opa_get_policy',
  'opa_health',
  'opa_list_policies',
  'opa_patch_data',
  'opa_put_data',
  'opa_put_policy',
  'opa_query_decision',
  'opa_status',
  'rego_check_schema',
  'rego_deps',
  'rego_format_write',
  'rego_inspect',
  'rego_playground_share',
];

describe('tool annotations', () => {
  const server = buildServer(baseConfig);
  const names = registeredToolNames(server);

  it('lists every registered tool exactly once', () => {
    const listed = [...EVALUATING, ...STATIC, ...OTHER];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...names].sort()).toEqual([...listed].sort());
  });

  it('marks every Rego-evaluating tool open-world, not read-only, and claims nothing more', () => {
    for (const name of EVALUATING) {
      const a = getToolAnnotations(server, name);
      expect(a['openWorldHint'], name).toBe(true);
      expect(a['readOnlyHint'], name).toBe(false);
      // A policy chooses its own HTTP method, so neither hint can be promised;
      // rego_fix is the one tool here whose own writes are the point.
      if (name !== 'rego_fix') {
        expect(a['destructiveHint'], name).toBeUndefined();
        expect(a['idempotentHint'], name).toBeUndefined();
      }
    }
  });

  it('leaves the static tools closed-world', () => {
    for (const name of STATIC) {
      expect(getToolAnnotations(server, name)['openWorldHint'], name).toBe(false);
    }
  });
});
