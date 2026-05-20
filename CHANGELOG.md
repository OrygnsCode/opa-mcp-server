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

## [0.1.5] - 2026-05-20

### Added

- **`rego_policy_diff` tool.** Evaluates the same query against two policies
  in parallel and compares the results. Returns `equal: true/false`,
  `resultA` / `resultB` (the extracted expression values), and `changedPaths`
  (dot/bracket JSON paths that differ, e.g. `["allow", "roles[0]"]`).
  Each side accepts either inline source (`sourceA` / `sourceB`) or a file /
  directory path (`pathA` / `pathB`). Supports `input`, `inputPath`, and
  `dataPaths` for full evaluation context. Both evaluations run concurrently.
  Exports `extractResultValue` and `diffValues` as standalone functions tested
  in isolation.

- **`rego_format_write` tool.** Runs `opa fmt --write` to canonically format
  one or more Rego files or directories in place. Uses a two-phase approach:
  `opa fmt --list` identifies which files would change and validates all files
  parse successfully; `opa fmt --write` then rewrites only the dirty files.
  `dryRun: true` returns the list of files that would be reformatted without
  touching the filesystem. Supports `regoV1`, `v0Compatible`, and
  `v1Compatible` flags. If any file fails to parse the entire operation is
  aborted so no partial writes occur. Returns `OPA_BINARY_NOT_FOUND` if the
  `opa` binary is absent. Only requires `opa`; does not require `regal`.

- **`rego_fix` tool.** Wraps `regal fix` to auto-apply fixes for the five
  rules regal 0.30.0 supports: `opa-fmt`, `use-rego-v1`,
  `use-assignment-operator`, `no-whitespace-comment`, and
  `directory-package-mismatch`. Accepts `dryRun: true` to preview what
  would change without modifying files. Returns a structured per-file
  summary -- which rules were fixed and, for `directory-package-mismatch`,
  the new path the file was moved to. Passes `--no-color` always;
  exposes `force`, `disable`, `enable`, `configFile`, and `ignoreFiles`
  for full control. Requires regal; returns `REGAL_NOT_FOUND` if absent.

- **`rego_infer_input_schema` tool.** Statically analyses one or more Rego
  policies using `opa parse --format=json` and returns a JSON Schema
  (draft-07) object describing every `input.*` field the policies read.
  String-keyed path components become nested object properties; variable
  wildcards (array iteration like `input.users[_].role`) mark the parent
  field as an `array` type. Also returns a sorted `inputPaths` list in
  dot-notation (e.g. `["input.action", "input.user.role"]`) for quick
  reference. Accepts inline `source`, individual files, or directories
  (walked recursively for `*.rego` files). No running OPA server required.

## [0.1.4] - 2026-05-20

### Fixed

- **`rego_inspect` never returned annotation data.** `opa inspect` was
  invoked without the `--annotations` flag, so `# METADATA` block
  contents were always absent from the output even though the tool's
  output type declared them. The flag is now passed on every call.

- **`rego_security_audit` remediation hints were keyed to wrong rule
  titles.** Three entries in `REMEDIATION_HINTS` used names that do not
  match real regal rule titles: `duplicate-definition` (actual:
  `duplicate-rule`), `shadowing-builtin` (actual: `rule-shadows-builtin`),
  and `sprintf-formatting` (actual: `sprintf-arguments-mismatch`). All
  three keys are corrected; affected violations were silently falling
  back to the generic remediation string instead of the specific guidance.

### Tests

- Added integration test (`regal-cli.test.ts`) that runs a policy
  containing `constant-condition` and `duplicate-rule` against real
  regal 0.30.0 and asserts both violation titles appear in the output.
  Confirms the `bugs` category produces findings in the installed regal
  version and that every returned violation carries `category: "bugs"`.

## [0.1.3] - 2026-05-18

### Added

- **`rego_coverage_gaps` tool.** Runs `opa test --coverage` and returns a
  per-file breakdown of uncovered line ranges, sorted by coverage ascending
  so the worst-covered files appear first. Accepts an optional `threshold`
  to limit output to files below a target coverage percentage. Surfaces
  `testsPassed`, `testsFailed`, `testsSkipped`, and `overallCoverage` in
  the envelope alongside the gap report.

- **`rego_security_audit` tool.** Runs regal lint restricted to the
  `security` and `bugs` categories across one or more policy directories.
  Returns findings grouped by severity (high / medium) with per-finding
  remediation guidance. Designed for fleet-wide periodic sweeps rather
  than per-file style review. Requires regal.

- **`mcp_server_info` tool.** Returns the server name, version, resolved
  `opa` and `regal` versions, transport type, and Node.js version in a
  single call. Useful for verifying which server instance an agent is
  talking to and confirming binary paths resolved correctly.

- **Claude Code install section** in README with the `claude mcp add --env`
  command. Standing-instructions template (`examples/CLAUDE.md`) and
  PostToolUse hook config (`examples/claude-code-hook.json`) for policy
  repos using Claude Code.

- **Node 24 added to CI matrix.** Unit tests now run on Node 20, 22, and 24
  across Ubuntu, macOS, and Windows.

### Changed

- All em dashes in source comments replaced with `--` (U+002D pairs).
  No behavior change; cosmetic consistency fix.

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

[Unreleased]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.2
[0.1.1]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.1
[0.1.0]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.0
