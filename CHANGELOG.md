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

## [0.1.16] - 2026-05-30

### Added

- **`rego_test` -- four new parameters:**
  - `ignorePatterns: string[]` -- passes `--ignore <pattern>` (once per entry) to
    exclude generated or fixture files from the test run.
  - `bundle: boolean` -- passes `--bundle` to load paths as OPA bundle roots.
    Required for policies structured with `manifest.json` at the root.
  - `count: number` -- passes `--count N` to repeat each test N times. Useful for
    measuring repeatability or catching flaky tests.
  - `timeout: string` -- passes `--timeout <duration>` (e.g. `"30s"`, `"2m"`) to
    raise the per-test limit beyond OPA's default 5s.
- **`rego_test` -- `parameterizedGroups` output field:** when OPA runs
  `test_X[case]`-style parametrized rules, the output now includes a
  `parameterizedGroups` map from the base test name (e.g. `test_X`) to all of
  its case records. Makes it easy to identify which specific table-driven input
  triggered a failure without manually scanning the flat `results` array.
- **`rego_test` -- improved `NO_TESTS_FOUND` hint:** when `runPattern` is supplied
  but matches no tests, the error hint now quotes the pattern you used so the
  developer can immediately see if the regex was wrong.
- **`rego_generate_test_skeleton` -- input shape inference:** the tool now walks the
  OPA AST to find every `input.<field>...` access in the policy body and builds a
  nested template object (`inferredInputShape`) that reflects exactly which input
  fields the rules actually read. The inferred shape is used as the placeholder
  `with input as {...}` in every generated stub, so developers fill in realistic
  values rather than guess the structure. The shape is also returned in the
  `inferredInputShape` field of the response.
- **`rego_generate_test_skeleton` -- removes `input := {}` anti-pattern:** the
  classic single-case skeleton no longer assigns `input := {}` (which shadows
  the built-in `input` keyword). Stubs now use `data.<pkg>.<rule> with input as
  <inferredShape>` directly, which is the idiomatic Rego v1 form.
- **`rego_generate_test_skeleton` -- skips existing test rules:** rules named
  `test_*` or `todo_test_*` are now filtered out before stub generation. A policy
  that already has tests will not produce double-prefixed `test_test_*` stubs, and
  a file containing only test rules now returns `INVALID_INPUT` with a clear message
  instead of silently generating nothing useful.

## [0.1.15] - 2026-05-29

### Added

- **`rego_playground_share`** -- new Category E tool (tool 52) that publishes a
  Rego policy as a public GitHub Gist and returns a shareable URL. The Gist renders
  the policy with syntax highlighting on github.com and its raw URL is directly
  loadable by OPA or Conftest. Optionally includes a `metadata.json` file with a
  default query, input document, and data document when those fields are supplied.
  Requires `GITHUB_TOKEN` in the environment (GitHub personal access token with the
  `gist` scope). Returns `{ gistUrl, rawPolicyUrl, id }` on success, or a
  `GITHUB_TOKEN_MISSING` error with setup instructions when the token is absent.
  `GITHUB_TOKEN` has been added to the declared `environmentVariables` in
  `server.json` (marked optional and secret).
- **String interpolation awareness** -- `rego_format` now detects OPA v1.12.0+
  `$"..."` / `` $`...` `` syntax and guards against a known `opa fmt` bug
  (present in OPA v1.12.0 and v1.12.1, fixed in v1.12.2) that silently corrupts
  `\{` escape sequences inside string interpolations during formatting. If the
  source contains both interpolation syntax and `\{`, formatting is blocked with
  an `OPA_VERSION_UNSUPPORTED` error and an upgrade hint. If the source has
  interpolation syntax but no `\{`, formatting proceeds with a warning. Sources
  without interpolation syntax are unaffected (no extra subprocess call).
- **`rego_verify` string interpolation construct type** -- the SMT encoder now
  classifies `internal.template_string()` calls (the compiled form of `$"..."`
  in the OPA AST) as a named `string_interpolation` unsupported construct type
  rather than the generic `unknown_builtin`, producing a clearer INCONCLUSIVE
  message that names the feature and its AST representation.

- **`rego_test_multiroot`** -- new Category B tool (tool 51) that runs `opa test`
  once per root and aggregates pass/fail/skip counts, per-test records, coverage,
  and errors. Solves the package-conflict problem (OPA issue #4724) that occurs
  when `opa test .` is run on a monorepo with multiple independent package namespaces.
  Two modes: `explicit` (caller supplies a root list with optional per-root `include`
  paths for shared libraries) and `scan` (auto-discovers leaf test roots using the
  leaf rule: a directory is a root only if it directly contains `*_test.rego` files
  and none of its eligible subdirectories do). Scan mode supports `sharedPaths`
  (added to every root's invocation, excluded from discovery), `maxDepth`,
  `maxRoots`, and `ignorePatterns`. Systemic failures (binary not found, timeout)
  abort the entire run; per-root OPA errors (package conflicts, import failures,
  parse errors) are recorded in the root's `error` field so the run continues.
  `overallCoveragePct` is the arithmetic mean of per-root coverage percentages.
  Ancestor directories that have test files alongside descendant test directories
  are skipped and reported in `ancestorSkipped` with a warning.

## [0.1.14] - 2026-05-28

### Added

- **`rego_explain_undefined`** -- new Category E helper (tool 50) that diagnoses
  why a fully-qualified Rego query (e.g. `data.authz.allow`) produces no value.
  Fuses three information sources: a plain `opa eval` to detect the defined/undefined
  split, `opa eval --explain=full` for runtime trace analysis, and
  `opa parse --json-include locations,-comments` for per-condition AST source text.
  For rules that OPA's indexer enters and fails at runtime, the blocking condition is
  identified by matching Fail-event rows against body-expression rows from the AST.
  For rules eliminated by the indexer before entry (equality checks on `input.*`
  being the most common case), each body expression is evaluated as a standalone
  query to determine which condition is not satisfied. Returns `queryResult`,
  `rulesFound`, `defaultValue`, a per-rule `rules` array with `blockingCondition`,
  and a human-readable `summary` ready for direct narration.
- **`ParseInput.includeLocations`** -- new optional flag on the `OpaCli.parse()`
  method. When `true`, passes `--json-include locations,-comments` to `opa parse`,
  adding base64-encoded source text and row/col data to every AST node. Used
  internally by `rego_explain_undefined`.

## [0.1.13] - 2026-05-27

### Added

- **`rego_test`: `varValues` parameter** -- passes `--var-values` to `opa test`.
  When combined with `verbose: true`, each failing test record includes a `trace`
  array with per-step local variable bindings. Essential for debugging
  table-driven tests written with `every tc in cases { ... }`: the trace shows
  the value of `tc` at the point of failure so you can pinpoint which case
  caused the assertion to fail without adding `print` statements or splitting
  the loop.

- **`rego_generate_test_skeleton`: `tableStyle` parameter** -- when `true`,
  generates table-driven test stubs instead of single-case stubs. Each rule
  gets a `<name>_cases` array declared at package scope (with one scaffold entry
  containing `description`, `input`, and `expected` keys) and a corresponding
  `test_<name>` rule that iterates over it with `every tc in <name>_cases { ... }`.
  Pair with `rego_test varValues: true` to see which case failed.
  Default (`false` or omitted) retains the classic single-case skeleton for
  backward compatibility.

## [0.1.12] - 2026-05-25

### Added

- **`rego_verify` (49 tools total)** -- formal SMT-based verification for Rego
  policies using Microsoft Z3 (WASM). Unlike testing, which checks specific
  inputs, `rego_verify` examines ALL possible inputs mathematically and either
  proves a property holds or returns a concrete counterexample. Three property
  kinds are supported: `always_true` (prove a rule is true for every input),
  `never_true` (prove a rule never fires), and `satisfiable` (find at least one
  satisfying input as a witness). Supports equality and inequality operators,
  string built-ins (`startswith`, `endswith`, `contains`, `regex.match`),
  comparison operators (`<`, `<=`, `>`, `>=`), multi-clause rules (OR
  semantics), cross-rule inlining (depth <= 5, cycle-safe), and mixed-type
  input paths. Reports `INCONCLUSIVE` for negation-as-failure (`not`),
  comprehensions, and other constructs that cannot be encoded in Z3.
  Counterexamples are returned as nested JSON ready for use with `opa eval
  --input`. Powered by a layered pipeline: OPA AST walker (IR), Z3 type
  inferencer, and SMT encoder.

### Fixed

- **Transitive local variable chains in type inferencer.** Sort inference
  previously stopped after one level of indirection (`x := input.user.role`
  was resolved, but `y := x; y == "admin"` was not). The inferencer now
  follows chains of arbitrary depth with a cycle guard, so intermediate
  local variables are correctly typed regardless of how many assignments
  separate them from an `input.*` path.

- **Multi-expression helper rule inlining.** Helper rules with multiple body
  expressions (e.g. `is_adult { x := input.age; x >= 18 }`) previously only
  inlined the first expression. The walker now flattens all body expressions
  into the caller clause as AND conjuncts, matching OPA's actual evaluation
  semantics. Inlining also correctly handles per-expression negation-as-failure
  and `with` modifiers inside the helper body.

- **`.*` regex patterns always encode as true.** `regex.match(".*", x)` and
  equivalent anchored forms (`^.*$`, `^.*`, `.*$`) previously created an
  unsatisfiable or redundant Z3 string constraint. They now short-circuit to
  `Bool.val(true)` since any string matches the pattern.

- **`unsatisfiable` verdict for dead-code rules.** When verifying a
  `satisfiable` property and Z3 returns UNSAT, the tool now returns
  `verdict: "unsatisfiable"` with a clear message indicating the rule is dead
  code or has contradictory conditions. Previously this case fell through as a
  generic inconclusive result.

- **Default-only rule verdicts.** Rules with only a `default` clause (e.g.
  `default allow = false`) previously returned `INCONCLUSIVE` because the
  solver found no non-default clauses to encode. The engine now detects this
  case and returns the correct verdict directly -- `PROVEN`, `COUNTEREXAMPLE`,
  `SATISFIABLE`, or `UNSATISFIABLE` -- without invoking Z3, using an empty
  `{}` witness where applicable.

- **Unsupported construct attribution scoped to target rule.** The
  `unsupportedConstructs` field in the result previously listed constructs from
  any rule in the module, including unrelated rules that were never evaluated.
  It is now filtered to only constructs that appear in the target rule's own
  clause expressions.

- **Per-call Z3 variable namespacing.** All Z3 constant names are now prefixed
  with a monotonically increasing call ID (`v0_`, `v1_`, ...). This prevents
  sort-redeclaration errors when the same input path is inferred as different
  sorts across successive calls (e.g. one policy uses `input.x` as a string,
  the next uses it as an int) within the shared Z3 WASM singleton context.

## [0.1.11] - 2026-05-24

### Added

- **`rego_check_schema` (48 tools total)** -- new authoring tool that runs
  `opa check --schema` to validate that every `input.*` field reference in a
  Rego policy exists in the provided JSON Schema. Schema violations surface as
  `rego_type_error` diagnostics with file/line locations. Accepts the schema
  inline (`inlineSchema` -- pass the `schema` output of `rego_infer_input_schema`
  directly) or as a path to a JSON Schema file on disk (`schemaPath`). Closes the
  infer-then-validate loop: use `rego_infer_input_schema` to derive the schema
  from an existing policy, then validate a new or modified policy against it
  without leaving the MCP session. Supports `strict` mode and all standard
  path-validation and subprocess error handling.

## [0.1.10] - 2026-05-22

### Added

- **Conftest integration (4 new tools, 47 total)** -- adds `conftest_test`,
  `conftest_verify`, `conftest_pull`, and `conftest_push`, wrapping the
  [conftest](https://www.conftest.dev/) CLI for policy testing of Kubernetes,
  Terraform, Helm, Dockerfile, and other configuration formats. Conftest is
  optional; all existing tools continue to work without it installed.

- **`conftest_test`** -- runs `conftest test` against one or more configuration
  files and returns structured JSON pass/fail/warn results per namespace. Supports
  inline configuration (written to a secure temp file, path redacted from output)
  and inline Rego policy (written to a secure temp dir), multiple data directories,
  namespace targeting, `--all-namespaces`, `--combine`, and `--fail-on-warn`.

- **`conftest_verify`** -- runs `conftest verify` to execute `_test.rego` unit
  tests inside a policy directory, verifying that the policies themselves are
  correct. Returns structured JSON output.

- **`conftest_pull`** -- pulls a policy bundle from a remote OCI or Git registry
  into a local directory (`oci://registry/repo:tag` form).

- **`conftest_push`** -- pushes a local policy bundle to a remote OCI registry,
  using host-environment credentials (docker login / ORAS).

- **`CONFTEST_NOT_FOUND` error code** -- returned by all four conftest tools when
  the binary is absent, with a structured install hint. Consistent with the
  existing `OPA_BINARY_NOT_FOUND` and `REGAL_NOT_FOUND` pattern.

- **`CONFTEST_BINARY` environment variable** -- configures the path to the conftest
  binary. Defaults to `conftest` on PATH.

### Security

- Temp files for inline config and inline policy are now created via `mkdtemp`
  (atomically, with `O_CREAT|O_EXCL` semantics at the OS level) rather than
  constructing a path from `os.tmpdir()` and a UUID. This eliminates the TOCTOU
  race window flagged by CodeQL CWE-377.

### Internal

- `src/lib/conftest-cli.ts`: `ConftestCli` class with `withTempAssets()` temp
  file lifecycle management and `sanitizeOutput()` for redacting internal paths
  from conftest JSON output. Path redaction uses `JSON.stringify` encoding to
  correctly handle backslashes in Windows paths embedded in JSON output.
- Exit-code semantics: 0 and 1 both produce valid JSON (pass/fail respectively);
  exit 2+ is a command error surfaced as `UNKNOWN_ERROR`.
- Tests: 57 tool-layer unit tests, 46 CLI unit tests, 12 real-binary integration
  tests (auto-skipped when conftest is not on PATH).

## [0.1.9] - 2026-05-21

### Added

- **AbortSignal cancellation** -- all 43 tool handlers now wire the MCP SDK's
  `extra.signal` into every subprocess spawn and OPA HTTP request. When a client
  sends `notifications/cancelled`, in-flight work is actually terminated:
  subprocess receives SIGTERM followed by SIGKILL escalation after 2 seconds;
  HTTP fetches are aborted via `AbortSignal.any()` combining the existing
  per-request timeout with the external client signal.

- **`CANCELLED` error code** -- added to `ToolErrorCode`. Returned to the caller
  when a tool is interrupted mid-flight by client cancellation, rather than
  surfacing a misleading `TIMEOUT` or `OPA_BINARY_NOT_FOUND` code.

- **`OpaCancelledError`** -- new error class in `OpaClient`. Thrown when a
  fetch aborts because the client signal fired (not a network failure), so
  `mapOpaClientError` can map it precisely to `CANCELLED`.

- **Tool annotations, instructions, and path sanitization (MCP spec 2025-11-25)**
  -- all 43 tools now declare `readOnlyHint`, `destructiveHint`, `idempotentHint`,
  and `openWorldHint` in their `annotations` block per the MCP spec. Server
  registers `instructions` at startup describing the tool set. All file path
  arguments validated through a hardened `validatePath` helper that normalises
  Windows drive-letter casing and resolves symlinks before allow-list comparison,
  closing a bypass that existed when a symlink target escaped the allowed root.

### Changed

- **`@modelcontextprotocol/sdk` pinned to `^1.29.0`** -- the minimum version that
  exposes `annotations` on `RegisteredTool` and passes `extra.signal` to handlers.

### Internal

- `subprocess.ts`: `SpawnResult` gains `aborted: boolean`; `SpawnOptions` gains
  `signal?: AbortSignal`. Early-return path if signal is pre-aborted; abort
  listener shares the SIGTERM->SIGKILL escalation helper with the timeout path.
- `tool-helpers.ts`: `mapSubprocessFailure` checks `result.aborted` before
  `exitCode === null` so cancellation takes priority over binary-not-found.
- Tests: all mock `SpawnResult` objects updated to include `aborted: false`;
  `callTool` helper passes `{ signal }` as second argument; two new deterministic
  abort path tests in `subprocess.test.ts`.

## [0.1.8] - 2026-05-21

### Added

- **`opa_delete_data`** -- removes a document from OPA's data store at the given
  path (`DELETE /v1/data/{path}`). Accepts the same dotted or slash path forms as
  `opa_get_data`, `opa_put_data`, and `opa_patch_data`. A missing path returns the
  new `DATA_NOT_FOUND` error code; percent-encoded traversal attempts are rejected
  by the shared `parseOpaDataPath` guard with `INVALID_INPUT` before any request is
  issued. Root-path deletion is intentionally excluded -- the path must be at least
  one segment deep.

- **`DATA_NOT_FOUND` error code** -- added to `ToolErrorCode`. Returned when a
  `DELETE /v1/data/{path}` (or any future data-path operation) receives a 404 from
  OPA. More specific than `UNKNOWN_ERROR` and symmetrical with the existing
  `POLICY_NOT_FOUND` code.

- **`opa_bundle_verify`** -- verifies the signature of a signed OPA bundle using
  `opa eval --bundle --verification-key`. Returns `{ bundle, verified: true }` on
  success. Accepts optional `verificationKeyId`, `signingAlg`, and `scope`. Both
  `bundle` and `verificationKey` paths are validated against the allow-list before
  any subprocess call.

- **`rego_migrate_v1`** -- migrates Rego v0 source to v1 syntax using a two-phase
  approach: `opa fmt --rego-v1` rewrites reserved keywords and adds
  `import rego.v1`; `opa check --v1-compatible` then validates the result. Returns
  `{ original, migrated, changed, valid, errors }`. If `fmt` fails the tool returns
  `INVALID_REGO`; if `check` finds remaining semantic issues `valid` is `false` but
  `ok` is still `true` so the caller can inspect both the diff and any remaining
  issues.

- **`opa_exec`** -- batch-evaluates a single decision against multiple input files
  using `opa exec --format=json`. Returns `{ results, count, successCount, errorCount }`
  where each result entry carries the input path and either the decision value or an
  error message. Accepts `bundle` or `dataPaths` as the policy source (mutually
  exclusive). All three path types (input, bundle, data) are validated against the
  allow-list.

### Tests

- 10 new unit tests for `opa_delete_data` covering: correct URL construction for
  dotted, slash, and `data.`-prefixed paths; `{ path, deleted: true }` response
  shape; bodyless request with no `Content-Type` header; bearer token forwarding;
  404 mapped to `DATA_NOT_FOUND` with status in details; connection failure mapped to
  `OPA_UNREACHABLE`; 401 mapped to `OPA_AUTH_FAILED`; 5xx mapped to `UNKNOWN_ERROR`;
  and two traversal-rejection cases (`%2e%2e` and double `%2e%2e/%2e%2e`).

- 9 new unit tests for `opa_bundle_verify` covering: correct argv construction;
  optional key-id, alg, and scope flags; `verified: true` response; invalid bundle
  mapped to `INVALID_BUNDLE`; binary missing mapped to `OPA_BINARY_NOT_FOUND`;
  timeout mapped to `SUBPROCESS_TIMEOUT`; path-not-found and path-not-allowed.

- 10 new unit tests for `rego_migrate_v1` covering: two-phase mock call sequence;
  correct `--rego-v1` and `--v1-compatible` flags; `changed` flag; errors array;
  `ok: true` with `valid: false` when check finds issues; short-circuit to
  `INVALID_REGO` when fmt fails.

- 12 new unit tests for `opa_exec` covering: correct argv and flags; mutually
  exclusive `bundle`+`dataPaths` guard; count/successCount/errorCount derivation;
  mixed success/error results; binary missing; timeout; path validation for all
  three path types.

- Tool count assertions updated to 43 across `server.test.ts`,
  `tests/integration/protocol.test.ts`, and `tests/integration/distribution.test.ts`.

### CI

- Added Smithery publish step to release workflow so the Smithery listing is
  updated automatically on every release.

- Updated Node.js Docker base image from `node:20-alpine` to `node:26-alpine`.

- Updated `actions/setup-node` from v4 to v6 in CI and release workflows.

## [0.1.7] - 2026-05-21

### Fixed

- **`rego_explain_decision` always returned empty `rulesFired` and zero
  summary counts.** OPA's `--explain=full` trace uses capitalized field
  names (`Op`, `Message`, `Node`) but the `summarizeTrace` helper was
  reading lowercase `op`, `message`, `node`. No events ever matched, so
  `enterEvents`, `exitEvents`, `failEvents`, `rulesFired`, and
  `rulesEvaluated` were always zero or empty regardless of what the trace
  contained. Fixed by reading the correct capitalized fields. Rule names
  are now extracted from `Node.head.name`, which is where OPA actually
  puts them, rather than from a regex match on a message string that is
  empty in real OPA output. Unit test mocks updated to use the real OPA
  trace format.

- **Eval tools returned wrong decisions when `input` was passed as a JSON
  string.** LLMs frequently serialize the input document as a string
  (`'{"user":"alice"}'`) rather than passing it as a native object. The
  eval tools then called `JSON.stringify` on that string, double-encoding
  it. OPA received `'"{\\"user\\":\\"alice\\"}"'` as the input document,
  parsed it as a plain string, `input.user` was undefined, and decisions
  that should have been `true` came back `false`. The shared eval handler
  now detects a string `input`, attempts `JSON.parse`, and passes the
  parsed object forward. Non-JSON strings are forwarded as-is.

### Security

- **Percent-encoded path traversal in OPA REST data tools.** `opa_get_data`,
  `opa_put_data`, `opa_patch_data`, and `opa_query_decision` constructed
  OPA REST API paths from user-supplied strings. Literal dots (`..`) in the
  input are converted to slashes by the `dataPath` function and are not a
  traversal risk. However, percent-encoded dots (`%2e%2e`) bypass that
  replacement -- `new URL()` normalizes `%2e%2e` as a real `..` segment,
  allowing requests to escape `/v1/data/` and reach arbitrary OPA endpoints.
  Worst-case impact: `GET %2e%2e/v1/config` reaches OPA's config endpoint
  (which can expose bundle credentials and plugin settings); `PUT` to a
  traversed path could overwrite the entire OPA data document.

  Fixed by normalizing the candidate path through `URL` parsing and
  verifying the resulting pathname still starts with `/v1/data/`. Both
  `%2e` (lowercase) and `%2E` (uppercase) variants are caught. The
  duplicate `dataPath()` functions in `data.ts` and `decisions.ts` are
  replaced by a single `parseOpaDataPath()` in `_shared.ts` that returns
  a structured `ok/error` result.

### Tests

- `rego_explain_decision` mock traces updated to match real OPA capitalized
  field names (`Op`, `Node`, `Message`). Test description for the
  "no recognizable rule message" case updated to reflect that the actual
  condition is a query-level event where `Node` is an array of terms rather
  than a rule object with `head.name`.

- Two new `rego_eval` tests: string `input` that is valid JSON is parsed and
  forwarded as an object; string `input` that is not JSON is forwarded as-is.

- `parseOpaDataPath` unit tests covering: dotted form, slash form, `data.`
  prefix stripping, root path, `%2e%2e` rejected, `%2E%2E` rejected, and
  double traversal rejected.

- Tool-level traversal rejection tests added for `opa_get_data`,
  `opa_put_data`, `opa_patch_data`, and `opa_query_decision` -- each
  verifies that a `%2e%2e` path returns `INVALID_INPUT` with no fetch
  issued.

## [0.1.6] - 2026-05-21

### Added

- **`--help` / `-h` flag.** Prints a formatted usage reference and exits.
  Output includes the boxed header with version and Orygn attribution,
  a two-column environment-variable table with descriptions and defaults,
  the accepted flags, and two usage examples. Colors are applied via ANSI
  codes when stdout is a TTY and suppressed otherwise, so CI logs and
  pipe targets never receive raw escape sequences.

- **`--version` / `-v` flag.** Prints `opa-mcp vX.Y.Z` and exits.

- **Startup banner.** When the server starts normally (not invoked with a
  flag), a single summary line is written to stderr showing the resolved
  `opa` binary, `regal` binary, configured allowed paths, and log file
  path. Uses the same TTY-aware color logic as `--help`. Because the banner
  goes to stderr it does not interfere with the MCP stdio protocol on
  stdout.

### Fixed

- **`SERVER_VERSION` was stale.** `src/constants.ts` held `0.1.3` while
  `package.json` was at `0.1.5`. Any tool or caller reading
  `SERVER_VERSION` directly -- including `mcp_server_info` -- was
  reporting the wrong version. Corrected to `0.1.5`.

- **Configuration error output was unreadable.** A bad environment variable
  (for example `OPA_MCP_TIMEOUT_MS=notanumber`) previously dumped raw Zod
  `format()` JSON with internal `_errors` keys that mean nothing to an
  operator. The error now reads:
  ```
  opa-mcp: invalid configuration
    OPA_MCP_TIMEOUT_MS: Expected number, received nan
  Run 'opa-mcp --help' for configuration options.
  ```
  Each invalid field is mapped to its environment variable name and printed
  on its own line with the Zod validation message.

- **Unknown CLI flags were silently ignored.** Passing an unrecognized flag
  such as `--hlep` caused the server to start normally with no feedback.
  Unknown flags now print `opa-mcp: unknown flag: <flag>` to stderr and
  exit with code 1.

### Security

- **Symlink traversal in `validatePath()`.** `path.resolve()` is purely
  syntactic and does not follow symlinks. A symlink placed inside an
  allowed root that pointed to a file outside it (for example
  `/allowed/link -> /etc/shadow`) would pass the allow-list check, and OPA
  or regal would then read the real target. Fixed by calling
  `realpathSync()` on any path that already exists and re-checking the
  canonical location against the resolved roots. The returned `resolved`
  value remains the syntactic path for cross-platform consistency; the
  realpath check is purely for validation. Symlink resolution is also
  applied to the allowed roots themselves, which may be symlinks on some
  systems (for example `/var -> /private/var` on macOS).

- **`configFile` passed to regal without allow-list validation.**
  `rego_lint`, `rego_security_audit`, and `rego_fix` all accept an
  optional `configFile` path and forwarded it directly to the regal
  subprocess without checking it against `OPA_MCP_ALLOWED_PATHS`. An
  attacker supplying an arbitrary path could read any file on disk that
  regal would accept as a config. All three tools now run `validatePaths()`
  with `mustExist: true` before the subprocess call.

- **`capabilities` and `schemaDir` passed to `opa check` without
  validation.** `rego_check` forwarded both parameters to `opa check`
  without checking them against the allow-list. Fixed with the same
  `validatePaths()` call pattern used by the other tools.

- **`opa_bundle_build` discarded resolved paths.** `signingKey`,
  `claimsFile`, and `capabilities` were validated by `validatePaths()` but
  the resolved canonical paths were thrown away and the original unresolved
  strings were passed to `opa build`. On a system where the input path
  contained symlinks the binary would receive a path that had not been
  security-checked. Fixed by capturing and using `v.resolved[0]` for each
  parameter.

### Tests

- Three symlink traversal tests added to `tests/unit/lib/security.test.ts`
  covering: symlink inside the allowed root pointing to a file outside is
  blocked; symlink to a directory outside is blocked; symlink pointing to a
  file inside the allowed root is allowed and `result.resolved` returns the
  link path rather than the realpath target. All three are skipped on
  Windows, which requires elevated privileges for symlink creation.

- `configFile` path validation tests added to `rego_lint`, `rego_fix`, and
  `rego_security_audit`: rejects a path outside allowed roots
  (`PATH_NOT_ALLOWED`) and rejects a nonexistent path inside allowed roots
  (`PATH_NOT_FOUND`).

- `capabilities` and `schemaDir` path validation tests added to
  `rego_check`.

- `opa_bundle_build` tests added for `claimsFile` and `capabilities`
  outside the allow-list, plus a test that verifies the resolved (canonical)
  paths appear in the `opa build` argv rather than the original strings.

- Updated the existing `rego_lint` "forwards every flag" test, which was
  passing `/abs/.regal.yaml` as `configFile`. That path is outside any
  allowed root and now correctly fails validation. The fixture was changed
  to a real path inside the test fixture tree.

### CI

- Added `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` to both `ci.yml` and
  `release.yml`. GitHub Actions composite actions default to Node 20 unless
  this variable is set; without it the CI matrix ran tests on Node 24 but
  the Actions runner infrastructure itself still used Node 20. All runner
  infrastructure now consistently uses Node 24.

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

[Unreleased]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.12...HEAD
[0.1.12]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.2
[0.1.1]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.1
[0.1.0]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.0
