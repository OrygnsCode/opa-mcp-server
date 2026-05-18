# Changelog

All notable changes to `@orygn/opa-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The public surface, for the purposes of SemVer, is:

- the set of registered MCP tools, prompts, and resources
- the input and output schemas of those tools
- the set of recognized environment variables
- the CLI entry point (`opa-mcp`) and its supported flags

Internal helpers (`src/lib/**`), type names not re-exported, and log formats are
not part of the public surface and may change in minor releases.

## [Unreleased]

## [0.1.2] - 2026-05-18

### Fixed

- `rego_capabilities` with `current: true` or a `version` argument now
  returns only builtin names, a count, future keywords, and features by
  default (`names_only: true`). Previously the full spec payload -- type
  signatures, documentation, and metadata for every builtin -- routinely
  exceeded the 100 KB `maxResponseBytes` cap and returned a useless
  `__truncated` envelope. Pass `names_only: false` to retrieve the
  complete payload when type signatures or documentation are needed.

## [0.1.1] - 2026-05-09

### Fixed

- `rego_lint` no longer fires `directory-package-mismatch` as a false
  positive on inline `source`. The rule's verdict depends on the
  on-disk path, but inline source is written to a randomized temp file
  whose path can never match the source's declared package, so the rule
  was guaranteed to fire. It is now auto-disabled when `source` is
  used. Re-enable via the `enable` parameter if your workflow actually
  needs it.
- `rego_lint` violation locations no longer leak the temp-file path on
  inline source. `location.file` is reported as `<inline>` for
  inline-source calls; row and column are preserved.

### Added

- Startup self-check probes the configured `opa` and `regal` binaries
  in the background and writes a warning entry to the log file when
  either is unreachable, with an install-hint pointing at the
  `OPA_BINARY` and `REGAL_BINARY` environment variables. The check is
  fire-and-forget and does not delay the MCP `initialize` handshake.
  Most often hit under Claude Desktop, which spawns MCP servers with a
  reduced PATH on macOS and Windows.
- `mcpName: "io.github.OrygnsCode/opa-mcp"` in `package.json`. This is
  the npm-side ownership marker the official MCP Registry requires
  before it accepts a published package; it was missing in 0.1.0.

### Changed

- README architecture diagram switched from Unicode box-drawing
  characters to plain ASCII (`+`, `-`, `|`) so it renders uniformly on
  npm's web UI; the previous Unicode corners showed visible gaps in
  npm's font.

### Security

- Pinned the transitive `hono` dependency to `>= 4.12.18` via a
  `package.json` `overrides` block. This clears three advisories
  (GHSA series for JSX SSR style injection, JWT NumericDate
  validation, and Vary-header handling in cache middleware) reported
  against the version pulled by `@modelcontextprotocol/sdk`. None of
  the affected code paths execute in this server (we run stdio only,
  not the HTTP transport that uses hono), but pinning eliminates the
  `npm audit` noise on user installs.

### Distribution

- Listed on the official MCP Registry at
  `io.github.OrygnsCode/opa-mcp`.

## [0.1.0] - initial public release

### Added

#### Tools (32)

**Authoring (7).** `rego_format`, `rego_check`, `rego_lint`,
`rego_parse_ast`, `rego_inspect`, `rego_capabilities`, `rego_deps`.
Operate on Rego source without a running OPA server.

**Evaluation (7).** `rego_eval` plus `_with_explain`, `_with_profile`,
`_with_coverage` variants; `rego_test`, `rego_bench`,
`rego_compile_query`. Run policies against inputs with optional
trace, profile, and coverage.

**Bundles (2).** `opa_bundle_build`, `opa_bundle_sign`. Build and
sign deployable bundles.

**Server management (12).** `opa_list_policies`, `opa_get_policy`,
`opa_put_policy`, `opa_delete_policy`, `opa_get_data`, `opa_put_data`,
`opa_patch_data`, `opa_query_decision`, `opa_compile_query`,
`opa_health`, `opa_status`, `opa_config`. Manage a running OPA over
its REST API.

**Helpers (4).** `rego_explain_decision` produces a structured
trace and per-rule fired/not-fired summary; `rego_generate_test_skeleton`
emits a `*_test.rego` stub from a policy AST; `rego_describe_policy`
returns a structured summary of package, imports, and rules;
`rego_suggest_fix` maps known diagnostic codes to mechanical fix
suggestions.

#### Prompts (3)

`policy_authoring_assistant`, `policy_review_checklist`,
`decision_debugging_workflow`. Workflow templates that direct the
agent through writing, reviewing, or debugging a policy using the
tools above.

#### Resources (3)

`opa://builtins`. Categorized OPA builtin function reference,
derived at read time from `opa capabilities --current` and annotated
with security-sensitive functions.

`opa://style-guide`. Condensed Rego style guide covering
`rego.v1`, package layout, naming, default-deny, comprehensions vs
`every`, schema annotations, and tests.

`opa://patterns`. Curated pattern library with six worked
examples: RBAC, ABAC, Kubernetes admission, Terraform IaC gates, API
authorization, rate limiting. Each pattern includes a working policy,
a test, and common pitfalls.

#### Distribution

- npm package `@orygn/opa-mcp`.
- Multi-arch Docker image `orygn/opa-mcp` bundling pinned `opa`
  0.69.0 and `regal` 0.30.0 binaries.
- MCPB bundle (`opa-mcp.mcpb`) attached to GitHub releases.
- Smithery descriptor for one-click client installs.

#### Configuration

Environment variables: `OPA_URL`, `OPA_TOKEN`, `OPA_BINARY`,
`REGAL_BINARY`, `OPA_MCP_ALLOWED_PATHS`, `OPA_MCP_LOG_FILE`,
`OPA_MCP_LOG_LEVEL`, `OPA_MCP_MAX_RESPONSE_BYTES`,
`OPA_MCP_TIMEOUT_MS`, `OPA_MCP_HTTP_TIMEOUT_MS`. File-based tools
fail-secure when `OPA_MCP_ALLOWED_PATHS` is unset.

#### Testing

50 unit tests (mocked subprocess) plus 20 integration tests
(real `opa` 0.69.0 and `regal` 0.30.0 binaries) covering both CLI
wrappers end-to-end. CI matrix: Ubuntu, macOS, and Windows on Node
20 and 22, plus CodeQL security scanning and weekly Dependabot updates
for npm, GitHub Actions, and Docker base images.

[Unreleased]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.2
[0.1.1]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.1
[0.1.0]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.0
