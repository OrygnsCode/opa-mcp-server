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

### Security

- `rego_playground_share` created public Gists, listed on the account and
  searchable, while the README described them as secret. Anyone who shared a
  policy with it should assume the policy was public from the moment it was
  posted. Gists are now secret unless `public: true` is passed: reachable by
  their link, listed nowhere. The change is not retroactive: GitHub cannot make
  an existing Gist secret, so a Gist created earlier that should not have been
  public has to be deleted at github.com/gists and shared again.

### Fixed

- Windows: a Rego module on a different drive from the server's working
  directory was reported missing. The 0.5.0 drive-letter fix respelled data
  documents relative to a working directory on their drive but left modules
  absolute, since a module mounts at its own `package` whatever path it
  arrives by. OPA still opens the module by the remainder after the colon, a
  root-relative path it resolves against the drive the child is running on, so
  a module on any other drive failed with a file-not-found. Every load path now
  takes part in choosing the working directory; only data documents are
  respelled.
- Windows: `rego_check` with inline source and `rego_inspect` reported a
  module missing when the server's temp directory was on a different drive
  from its working directory, and `conftest_test` and `conftest_verify` failed
  the same way through `--policy`. OPA and conftest open an absolute path by
  the part after its first colon, resolved on the drive the process runs on;
  each command now runs from the path's own drive. The configs under test are
  read by conftest itself and may sit on any drive; a policy and a data
  directory spread across two drives are refused with a message saying so.
- The subprocess timeout is now hard on Linux and macOS. The SIGKILL escalation
  fired on a flag Node sets when a signal is sent rather than when the child
  ends, so a child that ignored SIGTERM hung the tool call for good, and a
  wrapper script that left a grandchild holding the pipes kept the result from
  ever settling. A child killed from outside the server is reported as
  `SUBPROCESS_KILLED` naming the signal, not as a missing binary. On SIGINT or
  SIGTERM the server now signals the children it started before exiting.
- `rego_eval`: a string input that happened to parse as JSON, such as `"42"`
  or `"true"`, was retyped to a number or boolean before evaluation. Strings
  are now passed as strings; only an object or array that arrived serialised
  as a string is still repaired, as every other tool does.
- `rego_eval`, `rego_eval_with_explain`, `rego_eval_with_profile`,
  `rego_eval_with_coverage`, `rego_compile_query`, `rego_explain_decision`: a
  string input that happened to parse as JSON, such as `"42"`, `"true"` or a
  quoted string, was retyped or unwrapped before evaluation. Strings now reach
  the policy as strings; only an object or array that arrived serialized as a
  string is still repaired, the way `rego_bench` and the server-management
  tools already did.
- `rego_fix`: a real run reported zero fixes and no changed files after
  changing them, because only the dry-run wording of regal's summary was read.
  Both forms are read now.
- `opa_*` server tools: a request that OPA did not answer within
  `OPA_MCP_HTTP_TIMEOUT_MS` was reported as `OPA_UNREACHABLE`, with a hint to
  start a server that was already running. It is now `TIMEOUT`, naming the
  limit, and the timer covers the response body as well as the headers.
- `conftest_test`, `conftest_verify`: a denial reported under `failOnWarn`
  came back as a tool error rather than as a failed check, because conftest
  exits 2 for it. Any exit code with results on stdout is now an outcome, and
  only output without results is treated as a command error.
- `conftest_test`: a denial reported under `failOnWarn` came back as a tool
  error rather than as a failed check, because conftest exits 2 for it. Any
  exit code with results on stdout is now an outcome, and only output without
  results is treated as a command error, whose message now carries conftest's
  own text; `conftest_verify` shares that last part.
- `rego_playground_share` created public Gists, listed on the account and
  searchable, while the README described them as secret. Anyone who shared a
  policy with it should assume the policy was public from the moment it was
  posted. Gists are now secret unless `public: true` is passed: reachable by
  their link, listed nowhere.
- `rego_verify`: a policy that exhausted the Z3 WASM heap took the whole
  server down, since the abort surfaced outside every try/catch. The solver is
  now bounded at 768 MB, under a 1 GiB ceiling on Z3's allocations, so an
  oversized problem comes back inconclusive. Should the heap still abort
  during a solve, that call and any queued behind it fail with a reason,
  verification stays disabled until the server restarts, and the server
  stays up.

## [0.5.0] - 2026-09-04

### Security

- `opa_config` described its output as sanitized with secrets excluded. OPA
  drops the `credentials` block from `GET /v1/config` but returns
  `services.*.headers` verbatim, and a header is the ordinary place to put an
  API key or a bearer token for a bundle service, so a live credential was
  handed to whatever agent called the tool. `opa_status` returns the same
  document and had the same exposure. Header values are now replaced with a
  marker and the header names kept, so the document still says what the server
  is configured to send.
- `rego_verify` returned `proven` and `unsatisfiable` for claims that are false,
  on ordinary policy shapes, and reported no unsupported constructs while doing
  it, so nothing distinguished a real proof from a wrong one. A `proven` verdict
  was not usable as evidence that a policy cannot be bypassed. Every released
  version is affected. Five causes, each enough on its own: clauses whose head
  shape the encoder does not support were dropped rather than reported, and a
  rule with every clause dropped encoded to an empty body, which is vacuously
  true; head values were discarded, so `allow := false if { ... }` was encoded as
  though the head were true; `default` was not encoded at all, so
  `default allow := true` with a non-matching body answered `never_true`; input
  references were modelled as always present, so a body reading `input.x` was
  treated as defined when `x` is absent; and locals were scoped by clause index
  alone, so a helper and its caller sharing a variable name collapsed into one
  symbol. Encoding now fails closed: a clause holding anything the encoder cannot
  represent makes the verdict `inconclusive` rather than silently shrinking the
  formula. That costs coverage, and about one generated policy in sixteen now
  answers `inconclusive` where it previously gave a confident wrong answer.
  Numbers encode as reals rather than integers, so `input.n > 0` with
  `input.n < 1` is satisfiable at 0.5 instead of being falsely refuted.
  Verification also ran without a mutex on the shared solver context.
- `conftest_test` joined the `inlineConfigParser` value into the temp file name
  for inline config without checking it, so a value carrying `../` segments
  placed the inline config, whose content the caller also chooses, at any path
  the server could write. Parser names are now a closed set (conftest 0.69's
  nineteen), enforced in the schema and again in the handler, and the parser is
  passed to conftest explicitly rather than through the file name.
- Path validation followed links only for paths that already existed, so a
  write destination that did not exist yet, such as an `opa_bundle_build` output
  or a `conftest_pull` policy directory, was accepted on its spelling alone. A
  junction or symbolic link inside an allowed root that pointed outside it made
  such a write land outside the roots. A path is now judged by the real location
  of its nearest existing ancestor with the missing segments re-attached, a
  dangling link is refused, and roots and paths are compared in canonical form,
  which also ends false rejections for a root spelled through a link (macOS
  `/var`), a Windows short name, or a different letter case.
- `conftest_pull` and `conftest_push` skipped the allow-list entirely when
  `policy` was omitted. Both tools document that the policy directory must sit
  inside `OPA_MCP_ALLOWED_PATHS`, but the omitted case fell through to the
  conftest default, resolved against the working directory of the server:
  `conftest_pull` wrote policy files there, outside any allowed root. The
  default is now resolved and checked like an explicit path, and refused with
  `PATH_NOT_ALLOWED` when it falls outside.
- `opa_bundle_sign` wrote `.signatures.json` into the server's working directory,
  outside `OPA_MCP_ALLOWED_PATHS`, and reported `signed: true` while the bundle it
  was asked to sign stayed unsigned. `opa sign` puts the file wherever
  `--output-file-path` says, that flag defaults to the process cwd, and it was
  not being passed. A directory bundle is now signed in place and an archive
  beside itself (or in `outputDir`), both validated like every other path the
  server writes, and success is reported only after the file is observed on
  disk. A `.signatures.json` already present as a symbolic link is refused
  rather than written through. The response carries the path written, the
  algorithm, and the number of files covered.

### Fixed

Results that were wrong without saying so:

- The five OPA data tools read a key containing a dot as two path segments and
  returned a different document than the one asked for, with nothing to signal
  the substitution. `opa_get_data` on `hosts/example.com` fetched
  `/v1/data/hosts/example/com`; the same substitution applied to
  `opa_put_data`, `opa_patch_data`, `opa_delete_data` and `opa_query_decision`,
  so a write or a delete could land on the wrong document. A path containing a
  slash now treats slash as its only separator, and a path without one is read
  as dotted. Segments are percent-encoded: a key holding `?` or `#` truncated
  the request URL at that character and read the parent document, and keys
  holding a space, a percent sign or non-ASCII characters were unreachable.
- `opa_patch_data` documented an empty path for patching the root of the data
  hierarchy, but the schema required at least one character and the path it
  built for the root is one OPA answers with a redirect. Omitting both `path`
  and `segments` now patches the root.
- `opa_exec` did not evaluate the rule it was asked for. Its `decision`
  description told callers to pass a fully-qualified Rego reference such as
  `data.authz.allow`, but `opa exec --decision` names a decision by
  slash-separated path with no `data.` prefix. Any other spelling is accepted by
  the flag and resolves to nothing, so every input file came back with
  `opa_undefined_error`, which under a `deny`-style policy reads as a clean
  pass. Both spellings are now converted to the path OPA expects, and a
  reference with nothing left to name is rejected as `INVALID_INPUT`.
- `rego_test` and `rego_test_multiroot` counted a test OPA could not evaluate as
  a passing test. OPA marks such a record with an `error` object and does not set
  `fail`, so deriving the pass count as `total - failed - skipped` absorbed it,
  and a suite whose tests all raised (a rule conflict, for instance) was reported
  as fully passing with zero failures. Both tools now report `errored`
  separately, and the multiroot aggregate carries `totalErrored`.
- Windows: a data document passed by absolute path was loaded under its drive
  letter instead of where the policy expected it. OPA reads every load path as
  an optional `prefix:path` pair and splits on the first colon, so
  `C:\policies\data.json` mounted at `data.C` and a rule reading `data.tier`
  found nothing, while the tool reported success. `opa test` on a suite whose
  tests read data reported those tests as failing. Load paths are now passed
  relative to a directory the `opa` process runs in, which is the only spelling
  OPA reads correctly. Rego modules are unaffected either way, because a module
  mounts at its own `package` rather than at its path, which is why policies
  worked and only their data did not. Nothing changes on macOS or Linux, whose
  absolute paths carry no drive letter. Load paths spanning two drives are now
  reported as an error, since OPA cannot load documents from two drives in one
  invocation.
- The ABAC example in the `opa://patterns` resource failed to evaluate on the
  case it exists to handle. It expressed "hide secret resources from other
  organizations" as a second rule assigning `allow := false`, which in Rego is a
  conflict rather than an override: a user reading their own secret resource
  from another organization got `eval_conflict_error` instead of a denial. The
  denial is now a condition the permissive rules consult. The pitfalls list,
  which recommended the broken form, says why it does not work.
- The Terraform example in the `opa://patterns` resource did not reject a
  full-admin IAM policy. It tested `"*" in statement.Action`, which requires
  `Action` to be a collection, and AWS accepts a bare string there, in
  `Resource`, and for `Statement` itself. Of the four ways to spell
  `Allow * on *`, the rule caught one; the most common form,
  `{"Action": "*", "Resource": "*"}`, was allowed. Each position is now widened
  to a set before the wildcard test. Scoped policies and `Deny` statements are
  still allowed, so the rule has not become indiscriminate.
- `rego_test` with `coverage` or `threshold` reported `One or more tests
  failed` for a suite where none did. A suite holding a `todo_` test exits
  non-zero under `--coverage` with an empty stderr, and the coverage report is
  on stdout as asked for. The report was discarded and the run called a
  failure. A non-zero exit with a parseable report and no failure lines is now
  the coverage result it is, and a report OPA did produce is kept in the error
  details when tests really did fail.
- `rego_coverage_gaps` reported `testsPassed`, `testsFailed` and
  `testsSkipped` as zero on every call. OPA emits no per-test records in
  coverage mode, so the three counts could never be anything else, and three
  zeros read as "no tests ran" rather than "not reported". They are now
  omitted unless OPA supplied records.
- `opa_health` reported a reachable server as `OPA_UNREACHABLE`. A server that
  answers `/health?bundles=true` with `one or more bundles are not activated`
  is running; the caller was told no server was found and to go start one, and
  OPA's own reason was buried in a stringified error. Such a response is now a
  result, `healthy: false` with `reason`. A 401 maps to `OPA_AUTH_FAILED`, and
  `OPA_UNREACHABLE` is left for a server that could not be reached.

Tools that did not work as documented:

- `opa_bundle_verify` passed `--verification-key` to `opa eval`, which has no
  such flag, so verification always failed with "unknown flag" and was reported
  as `INVALID_BUNDLE`, signed or not. Verification now runs through
  `opa build --verification-key` into a discarded temp file, which is the path
  OPA provides. Failures carry `details.reason`: `signature_invalid`,
  `scope_mismatch`, `file_modified`, `file_added`, `file_missing`,
  `file_unparseable`, `unsigned`, `signatures_malformed`, `not_a_bundle`,
  `bundle_load_error`, or `unknown` when OPA's message is not recognised. A key
  or algorithm OPA cannot use is reported as `INVALID_INPUT` by both tools.
- Directory bundles are signed and verified by name from the parent directory,
  the way `opa sign --bundle <name>` records them, so a signed directory stays
  valid wherever it is placed under that name and a directory signed with the
  OPA CLI verifies. A symbolic link or junction given as the bundle is resolved
  first; OPA does not descend a linked root and would sign an empty file list.
- `opa_bundle_build` passed `--signing-key` and `--verification-key` without
  `--bundle`, which `opa build` refuses, so neither option worked unless
  `bundle: true` was also set. Either option now implies bundle mode.
- `opa_bundle_sign` returned an empty `stderr` on failure because `opa sign`
  prints its errors on stdout. `details` now carries both streams.
- `conftest_test` and `conftest_verify` threw `UNKNOWN_ERROR` on every clean run.
  conftest omits every empty array from its JSON, so a passing file arrives with
  no `failures` key and the summary code dereferenced it. Results now always
  carry their arrays, `conftest_verify` reports `NO_TESTS_FOUND` for a policy
  directory with no test rules (conftest prints `null` there), and both
  summaries count files by name, since conftest emits one entry per namespace
  or per test rule. `summary.successes` and `summary.failures` are added to
  `conftest_test`. `exceptions` are messages, not strings, matching conftest.
- `conftest_pull` did not write to the directory it was given. Conftest resolves
  `--policy` against the working directory rather than honouring an absolute
  path, and the tool resolves the caller's path against the allow-list before
  handing it over, so the path was always absolute. On Windows the pull failed
  outright, reporting a path of the form `.\C:\...`. `conftest_push` had the
  same handling and read from the same path on whichever drive it happened to
  start on. Both now run from the parent directory and name the target
  relatively.
- `rego_test` with `count` above 1 reported the suite as having no tests. OPA
  prints one pretty-printed JSON array per repetition, back to back, which is
  neither a single JSON value nor one record per line, so nothing parsed and the
  tool returned `NO_TESTS_FOUND` for a suite that had just run. The repetitions
  are now read and collapsed to one record per test carrying its worst outcome,
  so a test that fails intermittently is reported as failing.
- `rego_test` did not populate `parameterizedGroups`. OPA reports a
  `test_x[case]` rule as a single record carrying the per-case outcomes in
  `sub_results`, not as one record per case, so looking for a bracketed test
  name found nothing on any OPA 1.x run. A rule whose cases mostly passed was
  reported as one failing test with no indication of which case failed. The
  cases are now grouped under the rule name, and the bracketed form older
  versions emitted is still read.
- `rego_bench` failed with `UNKNOWN_ERROR` for any `count` above 1. OPA prints
  one JSON document per repetition, back to back, which is not a single JSON
  value, so nothing parsed. Every repetition is now returned in `runs`, and the
  top-level figures come from the fastest of them per iteration.
- `rego_bench` reported a failed benchmark with an empty error. `opa bench
  --format=json` writes its diagnostics to stdout as an `errors` array and
  leaves stderr empty, and the tool reported only stderr, so a query with a
  syntax error came back as `EVAL_ERROR` with nothing in it. The diagnostics
  are now included.
- `opa_list_policies` returned nothing but a truncation notice on a server
  holding more than a couple of dozen policies. OPA answers the policy
  endpoints with each policy's parsed AST alongside its source, and the AST is
  far larger than the text it came from, so the response passed
  `OPA_MCP_MAX_RESPONSE_BYTES` and the payload was replaced with advice to
  narrow the scope. The tool took no arguments, so there was no scope to
  narrow. It now returns the policy IDs and a count, with `includeSource` and
  `includeAst` to ask for more.
- `opa_get_policy` returned the AST alongside the source, which nothing had
  asked for: a 477-byte policy came back as a 19 KB response. The AST is now
  behind `includeAst`.
- The server did nothing when it was reached through a symbolic link. Its
  entry-point check compared `import.meta.url` with `process.argv[1]` as
  strings, and Node resolves symlinks for a module's own URL while leaving
  `argv[1]` as it was invoked, so the two differed and neither the CLI flags nor
  the transport ran: the process started and exited in silence. npm's `bin`
  entry is a symlink on macOS and Linux. The comparison is now between real
  paths, so how the file was reached no longer matters.
- `rego_explain_undefined` had nothing to say about a policy written with
  `default allow := false`. A default gives the query a value, so it is never
  undefined and the tool returned that value and stopped, skipping the
  per-clause analysis it exists for. A query whose value came from a default
  and from nothing else is now analysed, and `queryResult` reports `default`.
- Clauses of a multi-clause rule were not told apart in the trace. OPA leaves
  `Node.location` unset on trace events, so the row comparison meant to
  distinguish them always fell through to matching on the rule name, and every
  clause looked present in the trace as soon as one was. Those clauses were
  never evaluated standalone: each came back with every condition
  `unevaluable` and no blocking condition. The event's own location is now
  used.
- `rego_lint`, `rego_fix` and `rego_security_audit` ignored the linted project's
  own `.regal/config.yaml`, and applied any configuration sitting above the
  server's working directory to every call instead. Regal discovers its
  configuration by walking up from its own working directory rather than from
  the files it is given, and it was spawned without one, so it inherited the
  server's, which for a stdio server is wherever the client launched it. Rules a
  project had turned off were reported anyway, and inline source, which belongs
  to no project, picked up whatever happened to be above the server. Regal now
  runs in the directory of what it is linting, and inline source runs in its own
  temp directory. An explicit `configFile` still takes precedence.

Configuration and environment:

- An empty or blank environment variable was treated as a real value.
  `OPA_BINARY=""`, which is what a shell leaves behind when it expands an
  unset variable, is not the literal default `opa`, so binary resolution
  skipped the bundled build and every `rego_*` call tried to spawn nothing.
  Blank now means unset for every variable the server reads, and values are
  trimmed.
- `OPA_MCP_TIMEOUT_MS` and `OPA_MCP_HTTP_TIMEOUT_MS` accepted values Node
  cannot represent. A timer of 2147483648 ms or more is clamped to 1 ms with
  only a process warning, so a large value set to mean "effectively no
  timeout" timed out every subprocess and every HTTP call immediately. Values
  above 2147483647 are now refused at startup with a message saying why.
- An `install-id` file that existed but held no id was a permanent trap. The
  read found no id, the exclusive create failed because the file was there, and
  the fallback read found no id again, on every run for the life of the machine.
  The file is now rewritten when it holds no usable id; a brand-new file is
  still created exclusively so two first runs cannot both claim it. A file can
  end up empty after a crash or a full disk during the first run.
- The test suites no longer emit telemetry pings.

### Added

- `opa_bundle_sign` accepts `outputDir` for archives, the directory that
  receives `.signatures.json`. A directory bundle is always signed in place,
  since OPA only reads the signature from inside the bundle.
- `opa_bundle_verify` accepts `v0Compatible` for bundles written in Rego v0,
  which otherwise fail to load after the signature has been checked.
- The five OPA data tools accept `segments`, an array of literal key segments,
  for keys that contain both a dot and a slash and so cannot be written as a
  path string. `opa_put_data`, `opa_patch_data` and `opa_delete_data` return the
  resolved `segments` alongside the `path` that was supplied.
- `opa_exec` output gains `hint`, present when every input left the decision
  undefined. That is the expected outcome when no rule matched and also what a
  decision naming nothing looks like, and the per-file results do not
  distinguish them.
- `OPA_MCP_BLOCK_ENV` withholds named variables from `opa`, `regal` and
  `conftest` even when they are on the built-in allow-list. It is applied last,
  so it also overrides `OPA_MCP_PASSTHROUGH_ENV` and anything a command passes
  explicitly. It exists so an operator behind an authenticated proxy can choose
  to lose proxy support rather than expose those credentials to evaluated
  policy.

### Changed

- `rego_test` output gains `errored`, `repetitions` (present only when more
  than one repetition ran; OPA stops repeating at the first run that fails, so
  this can be lower than the requested `count`) and `caseCounts` (present only
  when the run had a parameterized test; the top-level counts still follow OPA
  and treat such a rule as one test however many cases it holds).
  `rego_test_multiroot` gains `errored` per root and `totalErrored` overall.
- `opa_list_policies` output gains `count`.
- `rego_explain_undefined` output: `queryResult` gains `default`, and `value`
  is populated for it. On a query that is genuinely defined the tool now also
  runs `opa parse`, which is how it tells a default apart from a rule that
  matched.
- `OPA_MCP_ALLOWED_PATHS` now refuses a relative entry, as documented. A
  relative root was resolved against the server's working directory, so for a
  stdio server the same configuration permitted different directories depending
  on how the client launched it.
- `opa-mcp --help` lists `OPA_MCP_MAX_SUBPROCESS_BYTES`,
  `OPA_MCP_PASSTHROUGH_ENV` and `OPA_MCP_NO_TELEMETRY`, which were documented
  but absent from the output an invalid-configuration message points at.
- The 0.4.0 entry below, the README and the source comment all described the
  child-process allow-list as containing no secret. It carries no cloud or
  repository credential, but `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` are on
  it and a proxy URL can embed a username and password, which any evaluated
  policy can read through `opa.runtime().env`. All three now say so. No
  behaviour changed; the exposure was there in 0.4.0 as shipped and is
  unchanged by this correction.
- Documentation corrected where it did not match the tools: `opa_status`
  returns `GET /v1/config`, not bundle or decision-log status;
  `rego_describe_policy` does not report input references, so the two prompts
  that told the model to use it for that now name `rego_infer_input_schema`;
  `rego_lint` returns a flat list of violations rather than findings grouped by
  category; `rego_capabilities` reflects the resolved `opa` binary rather than
  the bundled one; `rego_explain_decision` returns a structured summary rather
  than a natural-language explanation, and the extension manifest no longer
  says the helper tools use AI; the MCPB bundle has no bundled-binary fallback;
  unit tests run on macOS only on Node 22.
- Four error codes that nothing returns are no longer listed as codes a caller
  can expect: `REGAL_VERSION_TOO_OLD`, `DEPENDENCY_CONFLICT`,
  `VERIFY_INCONCLUSIVE` and `Z3_INIT_ERROR`. They remain reserved in the type.
  The troubleshooting entry for a Regal minimum-version check that does not
  exist is removed.

## [0.4.0] - 2026-09-03

### Security

- Policies evaluated through this server no longer receive the server's environment.
  Rego exposes the environment of the `opa` process through `opa.runtime().env`, and
  child processes inherited `process.env`, so any evaluated policy could read
  `OPA_TOKEN`, the `GITHUB_TOKEN` the README asks users to set for
  `rego_playground_share`, and everything else the operator's client passed in.
  `rego_eval` accepts inline source, so `OPA_MCP_ALLOWED_PATHS` never applied and no
  filesystem access was needed; a policy arriving through a README, an issue, or a
  diff was enough. `conftest_test` was affected the same way, and is the likelier
  route to third-party policy. Children now get an explicit allow-list.
  `OPA_MCP_PASSTHROUGH_ENV` opts individual variables back in, and anything named
  there is readable by evaluated policy by design.

  The allow-list carries no cloud or repository token, but it is not free of
  credentials: `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` are on it, and a proxy
  URL can embed a username and password, so an operator behind an authenticated
  corporate proxy is still handing those to evaluated policy. They are on the list
  because dropping them breaks proxied bundle downloads and `http.send`.

  On Windows, libuv copies a fixed set of variables to every child regardless of what
  is requested. `USERNAME`, `USERDOMAIN` and `LOGONSERVER` cannot be removed, so they
  are blanked rather than left to disclose the operating-system user and domain.

### Fixed

- A subprocess that produces very large output no longer takes the server down.
  stdout and stderr were captured without a size limit, and decoding a capture past
  V8's maximum string length throws inside an async `close` handler, where no tool's
  `try`/`catch` can reach it and the process exits. A policy iterating
  `numbers.range(1, 1000)` under `--explain full` produced 518 MiB in under seven
  seconds, so the 30-second timeout never applied; `opa` buffers its result and writes
  it in one burst at exit, which means the runs that complete comfortably are the
  dangerous ones. Capture is now capped per stream, the child is stopped on overflow,
  and the tool returns the new `OUTPUT_TOO_LARGE` error code. Configurable with
  `OPA_MCP_MAX_SUBPROCESS_BYTES`, default 32 MiB.

- `rego_test_multiroot` reports `OUTPUT_TOO_LARGE` and `TIMEOUT` through the same mapper as
  every other tool. It carried its own copy of the failure ladder, and a run killed for
  producing too much output reported `OPA_BINARY_NOT_FOUND`, sending the caller after an
  install problem that did not exist. This is the same defect that was fixed for timeouts in
  0.3.0, in the one place that did not share the fix.

### Added

- `OPA_MCP_MAX_SUBPROCESS_BYTES` and `OPA_MCP_PASSTHROUGH_ENV` environment variables.
- `OUTPUT_TOO_LARGE` error code.


## [0.3.0] - 2026-08-05

### Changed

- The bundled OPA binary moves from 0.69.0 to 1.19.0. This is a breaking change for
  anyone relying on the bundle. OPA 1.0 made Rego v1 the default, so rule bodies
  require the `if` keyword and partial set rules require `contains`; policies written
  against OPA 0.x no longer parse. `rego_migrate_v1` converts them. Installs that
  supply their own binary through `OPA_BINARY` or `PATH` are unaffected, since the
  bundled copy is only a fallback. The Docker image ships the same version.

### Fixed

- `rego_test` returns `INVALID_REGO` when the policies under test fail to load. It
  previously reported a successful run with zero tests, so a caller whose policies had
  stopped compiling was told the suite was fine. Most likely to surface right after
  this upgrade, on trees that still hold v0 policies.

- A subprocess that exceeds the configured timeout returns `TIMEOUT` instead of
  `OPA_BINARY_NOT_FOUND`. A killed process reports a null exit code, and the failure
  mappers checked that before the timeout flag, so a slow command looked like a missing
  install. Affected every CLI-backed tool, and `rego_test_multiroot` separately.

- Three Rego snippets in the bundled pattern library did not compile: two failed to
  parse, and the rate-limiting example named a rule `count`, which shadowed the built-in
  it then called. All shipped snippets are now compiled against the bundled OPA in CI.

- Corrected the tool list on the Docker Hub page, which named seven tools that do not
  exist (`rego_bundle_*`, `rego_parse`, `rego_profile`, `rego_compile`) and undercounted
  the total. Added the missing `rego_playground_share` entry to the README tool tables.

## [0.2.1] - 2026-06-25

### Fixed

- Structured tool arguments that are free-form JSON values (`input`, `value`) are
  re-parsed when an MCP client sends them as a JSON string. They previously
  arrived as strings and were used verbatim, so `opa_query_decision` evaluated
  against an empty input and returned the default decision, `opa_put_data` stored
  arrays and objects as strings, `rego_policy_diff` compared both policies with no
  input (reporting different policies as equal), and `opa_compile_query` and
  `opa_patch_data` were affected the same way.
- `rego_explain_undefined` reports the correct blocking condition. It judged each
  body expression by whether `opa eval` returned a result row, but OPA returns a
  row for a false comparison as well (the row's value is `false`), so satisfied
  and unsatisfied conditions were indistinguishable. It now inspects the
  expression's value.
- `rego_verify` returns an `inconclusive` verdict with a `type_conflict` construct
  instead of failing with `UNKNOWN_ERROR` when a policy constrains one input field
  to conflicting types (for example, compared against both a number and a string).
- `opa_patch_data` maps a 404 from OPA to `DATA_NOT_FOUND` instead of the generic
  `UNKNOWN_ERROR`, matching `opa_delete_data`.
- Inline-source evaluation output no longer exposes the temporary file path OPA
  writes the source to. Trace, coverage, and profile paths from
  `rego_eval_with_explain`, `rego_eval_with_coverage`, `rego_eval_with_profile`,
  and `rego_explain_decision` are normalized to `<inline>`, matching `rego_check`.

### Changed

- `rego_describe_policy` reports `clauseCount` for each rule and sets `isDefault`
  and `hasArgs` to true when any clause for that name qualifies, instead of
  collapsing multi-clause rules into a single, order-dependent entry.
- `rego_generate_test_skeleton` stubs bind the rule result and assert a concrete
  value (`actual := ...` then `actual == true`) rather than referencing the rule
  bare. A bare reference silently passed for any defined value, including an empty
  partial-set rule.

### Security

- Tool errors no longer return raw stack traces to the client. An unexpected
  exception previously surfaced `details.stack` with absolute filesystem paths;
  the stack is now written to the server log only.

## [0.2.0] - 2026-06-13

### Added

- OPA is now bundled. The OPA binary ships as platform-specific optional
  dependencies (`@orygn/opa-mcp-<platform>-<arch>`), so `npx @orygn/opa-mcp` runs
  without installing OPA separately. npm downloads only the binary that matches
  your operating system and CPU, so the install stays small. Pinned to OPA 0.69.0.

### Changed

- The `opa` binary is now resolved in this order: an explicit `OPA_BINARY` first,
  then `opa` found on PATH, then the bundled binary. Setups that already have `opa`
  on PATH keep working exactly as before; the bundled copy is only a fallback, so
  no existing install changes behavior.

## [0.1.20] - 2026-06-03

### Added

- `opa_exec`: CI gate flags `fail`, `failDefined`, and `failNonEmpty` (at most one
  may be set), plus `timeout` (a Go duration) and `v1Compatible`. When a gate flag
  is set, a non-zero exit from `opa exec` is the gate firing rather than an error:
  the per-file results are still returned, with `failed: true` to signal the gate.
- `rego_test`: `explain` (`fails` | `full` | `notes` | `debug`) adds a
  query-explanation trace to test records, and `v1Compatible` opts in to OPA v1.0
  behaviors.
- `rego_check`: `maxErrors` (`--max-errors`, raise the early-abort error limit) and
  `bundle` (`--bundle`, load `paths` as bundle roots). `bundle` is rejected with
  inline `source`.
- `opa_bundle_build`: `bundle`, `pruneUnused`, `ignore` (name patterns),
  `v1Compatible`, and `verificationKey` / `verificationKeyId` for re-verifying a
  signed bundle during the build. `verificationKey` is validated against the
  allow-list.
- `conftest_test`: `parser` forwards conftest's global `--parser` flag so files
  whose extension does not match their format can be parsed explicitly (e.g. parse
  a `.tfstate` file as `json`).

### Fixed

- `opa_exec` with `dataPaths` no longer fails with `unknown flag: --data`. `opa exec`
  loads policy and data only through `--bundle`; each `dataPaths` entry is now passed
  as a `--bundle` root.
- `conftest_test`: the `inlineConfigParser` valid-values list now documents `edn` and
  `hocon`, matching the parsers the wrapper already supports.

## [0.1.19] - 2026-06-02

### Fixed

- `rego_verify`: complex `regex.match` patterns (character classes, quantifiers,
  alternation) no longer cause Z3 to hang indefinitely. The 10-second solver
  timeout only guards `solver.check()`, not the synchronous WASM formula
  construction; patterns like `[a-z]+` or `\d+` could spin before the clock
  started. The fix moves the guard to the walker: only the five idioms the
  encoder handles cheaply (prefix `^lit.*`, suffix `.*lit$`, exact `^lit$`,
  contains `.*lit.*`, wildcard `.*`) produce a `regex_match` IR node; anything
  else returns INCONCLUSIVE before Z3 is touched. The unused `compilePcreToZ3Re`
  function and its ~175 lines of helpers are removed.

## [0.1.18] - 2026-05-30

### Added

- On first run, a random install ID is generated and saved to `~/.orygn/opa-mcp/install-id`.
  The file includes a plain-English comment explaining what it is and how to opt out.
  The ID is sent with the anonymous startup ping so unique installs can be counted.
  Set `OPA_MCP_NO_TELEMETRY=1` to disable all telemetry.
- `mcp_server_info` now reports the conftest binary version alongside opa and regal.

### Fixed

- `opa_status` now correctly calls `/v1/config`. The `/v1/status` endpoint is only
  registered when the OPA status plugin is active; calling it on a plain
  `opa run --server` returned 404.

### Security

- Inline policy tools now write temp files into a private directory (`mkdtemp`, mode 0700)
  instead of a world-readable file in `/tmp`. Applies to both opa and regal sources.
- `conftest_pull` description now includes a clear warning that pulled policies execute
  as trusted code.

### Changed

- Removed `HTTP_SEND_BLOCKED` error code - it was declared in types and documented in
  the README but never emitted by any tool.

## [0.1.17] - 2026-05-30

### Added

- Anonymous startup telemetry ping. On server start, a single fire-and-forget
  request is sent with the server version and OS platform. No policy content,
  file paths, or identifying information is ever sent. Opt out by setting
  `OPA_MCP_NO_TELEMETRY=1`.

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

[Unreleased]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.20...v0.2.0
[0.1.20]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.19...v0.1.20
[0.1.19]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.17...v0.1.18
[0.1.17]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.16...v0.1.17
[0.1.16]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.12...v0.1.13
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
[0.1.2]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/OrygnsCode/opa-mcp-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/OrygnsCode/opa-mcp-server/releases/tag/v0.1.0
