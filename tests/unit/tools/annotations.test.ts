/**
 * Annotation invariants across every registered tool. A tool that runs Rego
 * can reach the network through http.send, so it must not present itself as
 * closed-world or read-only; the next evaluating tool added with a
 * copy-pasted annotation block fails here rather than shipping.
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
];

describe('tool annotations', () => {
  const server = buildServer(baseConfig);
  const names = registeredToolNames(server);

  it('registers every tool the lists name', () => {
    for (const name of [...EVALUATING, ...STATIC]) expect(names).toContain(name);
  });

  it('marks every Rego-evaluating tool open-world and not read-only', () => {
    for (const name of EVALUATING) {
      const a = getToolAnnotations(server, name);
      expect(a['openWorldHint'], name).toBe(true);
      expect(a['readOnlyHint'], name).toBe(false);
    }
  });

  it('leaves the static tools closed-world', () => {
    for (const name of STATIC) {
      expect(getToolAnnotations(server, name)['openWorldHint'], name).toBe(false);
    }
  });
});
