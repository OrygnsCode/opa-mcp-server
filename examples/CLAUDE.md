# OPA / Rego policy repo

This repository contains OPA (Open Policy Agent) policies written in Rego.
The `opa-mcp` MCP server is registered for this project.

## Tools to use

Prefer the MCP tools over raw `opa` / `regal` CLI calls for all policy work.

| Task                                   | Tool                          |
| -------------------------------------- | ----------------------------- |
| Format Rego source                     | `rego_format`                 |
| Type-check and validate                | `rego_check`                  |
| Lint (style, bugs, idioms)             | `rego_lint`                   |
| Parse to AST                           | `rego_parse_ast`              |
| Evaluate a query on one or many inputs | `rego_eval`                   |
| Evaluate with execution trace          | `rego_eval_with_explain`      |
| Evaluate with per-line coverage        | `rego_eval_with_coverage`     |
| Run test suite                         | `rego_test`                   |
| Debug an unexpected deny               | `rego_explain_decision`       |
| Find why a rule has no value           | `rego_explain_undefined`      |
| Compare two versions of a policy       | `rego_policy_diff`            |
| Generate test skeleton from policy     | `rego_generate_test_skeleton` |
| Summarize what a policy does           | `rego_describe_policy`        |
| Propose fix for lint or check error    | `rego_suggest_fix`            |
| Push a policy to the OPA server        | `opa_put_policy`              |
| Query the OPA server                   | `opa_query_decision`          |
| Check OPA server health                | `opa_health`                  |
| Get server info and binary versions    | `mcp_server_info`             |

The `opa://patterns` resource contains curated Rego patterns for RBAC, ABAC,
Kubernetes admission, IaC gates, API authz, and rate limiting. Read it before
drafting a policy from scratch.

## Authoring workflow

When writing or editing a `.rego` file:

1. Check `opa://patterns` for an existing pattern that matches the use case.
2. Draft the policy in Rego v1 (`if` before each rule body, `contains` for
   multi-value rules), the default since OPA 1.0. For a file still in
   pre-1.0 syntax, pass `v0Compatible: true` or convert it with
   `rego_migrate_v1`.
3. `rego_format` -- normalize whitespace, spacing, and operator style.
4. `rego_check` with `strict: true` -- catch type errors and unsafe variables.
5. `rego_lint` -- address any finding graded `error` or `warning`.
6. `rego_eval` with an `inputs` batch -- probe the policy with inputs in which
   each field it reads is missing, null or of the wrong type, and confirm
   nothing that should be denied is allowed. Steps 4 and 5 do not catch a
   rule that lets a request through.
7. Keep those probe inputs as tests, then `rego_test` the test directory and
   check `allPassed`. It is false when a test failed, errored or was skipped,
   or when no test ran at all.

If a decision is failing unexpectedly, call `rego_explain_decision` before
modifying the policy. It walks every rule that fired and every rule that
didn't, which almost always pinpoints the issue faster than manual tracing.
When a rule has no value, falls back to its default, or a set such as `deny`
comes back empty, `rego_explain_undefined` names the condition that stopped
it.

## Constraints

- Do not call `opa` or `regal` via the Bash tool. Use the MCP tools above.
- Every policy must pass `rego_check` with `strict: true` before being saved.
- Test files must be named `*_test.rego` and live alongside the policy they test.
- `OPA_MCP_ALLOWED_PATHS` controls which directories the server will read.
  If you add a new policy directory, update that env var in `.mcp.json`.
- `OPA_TOKEN` is never echoed in tool responses or logs. Do not log it or
  include it in policy source.

## Conventions

<!-- Add your project-specific conventions below, e.g.: -->
<!-- Package naming: data.myorg.<domain>.<resource>     -->
<!-- Input schema:   schemas/input.json                 -->
<!-- Bundle entry:   policies/main.rego                 -->
<!-- Test runner:    npm test / make test                -->
