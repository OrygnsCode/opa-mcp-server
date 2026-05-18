# OPA / Rego policy repo

This repository contains OPA (Open Policy Agent) policies written in Rego.
The `opa-mcp` MCP server is registered for this project.

## Tools to use

Prefer the MCP tools over raw `opa` / `regal` CLI calls for all policy work.

| Task                                | Tool                          |
| ----------------------------------- | ----------------------------- |
| Format Rego source                  | `rego_format`                 |
| Type-check and validate             | `rego_check`                  |
| Lint (style, bugs, idioms)          | `rego_lint`                   |
| Parse to AST                        | `rego_parse_ast`              |
| Evaluate a query                    | `rego_eval`                   |
| Evaluate with execution trace       | `rego_eval_with_explain`      |
| Evaluate with per-line coverage     | `rego_eval_with_coverage`     |
| Run test suite                      | `rego_test`                   |
| Debug an unexpected deny            | `rego_explain_decision`       |
| Generate test skeleton from policy  | `rego_generate_test_skeleton` |
| Summarize what a policy does        | `rego_describe_policy`        |
| Propose fix for lint or check error | `rego_suggest_fix`            |
| Push a policy to the OPA server     | `opa_put_policy`              |
| Query the OPA server                | `opa_query_decision`          |
| Check OPA server health             | `opa_health`                  |
| Get server info and binary versions | `mcp_server_info`             |

The `opa://patterns` resource contains curated Rego patterns for RBAC, ABAC,
Kubernetes admission, IaC gates, API authz, and rate limiting. Read it before
drafting a policy from scratch.

## Authoring workflow

When writing or editing a `.rego` file:

1. Check `opa://patterns` for an existing pattern that matches the use case.
2. Draft the policy. Use `import rego.v1` and keyword `if`/`contains` syntax
   unless the file already uses a different style.
3. `rego_format` -- normalize whitespace, spacing, and operator style.
4. `rego_check --strict` -- catch type errors and unsafe variables.
5. `rego_lint` -- address any finding graded `error` or `warning`.
6. `rego_test` -- run the test directory; confirm all tests pass.
7. If any test documents an edge case you did not cover, add a test for it.

If a decision is failing unexpectedly, call `rego_explain_decision` before
modifying the policy. It walks every rule that fired and every rule that
didn't, which almost always pinpoints the issue faster than manual tracing.

## Constraints

- Do not call `opa` or `regal` via the Bash tool. Use the MCP tools above.
- Every policy must pass `rego_check --strict` before being saved.
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
