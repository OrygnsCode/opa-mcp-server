# OPA MCP Server

[![CI](https://github.com/OrygnsCode/opa-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/OrygnsCode/opa-mcp-server/actions/workflows/ci.yml)
[![CodeQL](https://github.com/OrygnsCode/opa-mcp-server/actions/workflows/codeql.yml/badge.svg)](https://github.com/OrygnsCode/opa-mcp-server/actions/workflows/codeql.yml)
[![npm version](https://img.shields.io/npm/v/@orygn/opa-mcp.svg)](https://www.npmjs.com/package/@orygn/opa-mcp)
[![Docker pulls](https://img.shields.io/docker/pulls/orygn/opa-mcp.svg)](https://hub.docker.com/r/orygn/opa-mcp)
[![OPA Ecosystem](https://img.shields.io/badge/OPA-ecosystem-blue.svg)](https://www.openpolicyagent.org/ecosystem/entry/opa-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@orygn/opa-mcp.svg)](./package.json)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server
that turns any MCP-compatible client (Claude Desktop, Claude Code, Cursor,
VS Code, Windsurf, Zed, and others) into a first-class
[Open Policy Agent](https://www.openpolicyagent.org/) and Rego authoring
environment.

```
+--------------------+  MCP / stdio  +-----------------+  spawn / HTTP  +------------------+
|  Claude · Cursor · | ------------> |  @orygn/opa-mcp | -------------> |  opa · regal ·   |
|   VS Code · ...    | <------------ |                 | <------------- |  OPA REST API    |
+--------------------+   35 tools    +-----------------+                +------------------+
```

> **Status:** v0.1.4. Tool surface, error codes, and
> environment variables follow [SemVer](https://semver.org/) from
> v0.1.0 forward.

---

## Table of contents

- [What you can do with it](#what-you-can-do-with-it)
- [Why this MCP](#why-this-mcp)
- [Install](#install)
- [Configuration](#configuration)
- [Tool reference](#tool-reference)
- [Prompts](#prompts)
- [Resources](#resources)
- [Cookbook](#cookbook)
- [Architecture](#architecture)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Versioning & support](#versioning--support)
- [License](#license)

## What you can do with it

Once an MCP client is connected, an agent can:

- **Author Rego.** Generate, format, and refactor policies. The server
  runs the real `opa fmt` and `opa parse` so output is byte-identical to
  what you'd get on the command line, and `regal` (optional) surfaces
  idiomatic suggestions.
- **Evaluate against data.** Run a query against a policy and an input
  document. Optional `--explain`, `--profile`, and `--coverage` flags
  surface execution traces, hot rules, and per-line coverage.
- **Debug a deny.** `rego_explain_decision` walks the agent through every
  rule that fired (and every one that didn't), so it can answer "why was
  this rejected" without you reading the trace by hand.
- **Manage policies on a running OPA.** List, get, put, delete policies on
  an OPA server through its REST API. Works against a local
  `opa run --server` or a production deployment with bearer-token auth.
- **Build & sign bundles.** Package a directory of policies into a
  deployable bundle, optionally signing it. Output is a regular `.tar.gz`
  the agent can hand to your delivery system.
- **Lint.** `rego_lint` runs Regal across a directory or a single file
  and returns categorized findings (style, bugs, performance, idioms).

A walk-through of a typical session lives in [Cookbook](#cookbook).

## Why this MCP

OPA already has a perfectly good CLI and REST API. So why an MCP wrapper?

- **Schema-shaped tool surface.** An agent calling `rego_eval` gets a
  validated input schema, a structured output envelope, and stable error
  codes, instead of parsing free-form CLI text and inventing its own
  failure taxonomy. That alone makes Rego usable to an agent the way a
  language server makes a language usable to an IDE.
- **Higher-level helpers.** `rego_explain_decision`,
  `rego_generate_test_skeleton`, `rego_describe_policy`, and
  `rego_suggest_fix` compose the lower-level primitives into the tasks
  agents are actually asked to do. They don't exist in the OPA CLI.
- **Curated knowledge.** The bundled MCP **resources** expose the OPA
  built-in function catalog, the official Rego style guide (formatted for
  LLMs), and a curated pattern library covering RBAC, ABAC, Kubernetes
  admission, IaC gates, API authz, and rate limiting, so the agent has
  authoritative context without needing to scrape it.
- **Safety boundaries the agent can rely on.** Path allow-list,
  subprocess timeouts, response-size caps, and an explicit
  `HTTP_SEND_BLOCKED` error for the dangerous OPA built-ins. Defaults are
  conservative; running the server doesn't quietly grant the agent more
  reach than the operator intended.

If you've ever watched an agent fight `opa eval`'s argument order, you'll
recognize the gap this fills.

## Install

The server runs locally over stdio. Pick the install path that matches
your client.

### Claude Desktop

Edit `claude_desktop_config.json` directly (or copy from
[`examples/claude-desktop.json`](./examples/claude-desktop.json)):

```json
{
  "mcpServers": {
    "opa": {
      "command": "npx",
      "args": ["-y", "@orygn/opa-mcp"],
      "env": {
        "OPA_BINARY": "/usr/local/bin/opa",
        "REGAL_BINARY": "/usr/local/bin/regal",
        "OPA_URL": "http://localhost:8181",
        "OPA_MCP_ALLOWED_PATHS": "/path/to/your/policies"
      }
    }
  }
}
```

> Replace the `/usr/local/bin/...` paths with your real ones. See the
> [first-time install gotcha](#-first-time-install-gotcha-read-this-if-you-used-npx-or-the-global-install)
> below. Windows users substitute `C:\\path\\to\\opa.exe`.

Or download `opa-mcp.mcpb` from the
[latest release](https://github.com/OrygnsCode/opa-mcp-server/releases/latest)
and double-click it.

Alternatively, use the Smithery one-liner:

```bash
npx -y @smithery/cli install @orygn/opa-mcp --client claude
```

### Claude Code (CLI)

Register the server for the current project with `claude mcp add`:

```bash
claude mcp add \
  --env OPA_BINARY=/usr/local/bin/opa \
  --env REGAL_BINARY=/usr/local/bin/regal \
  --env OPA_MCP_ALLOWED_PATHS=/path/to/your/policies \
  opa -- npx -y @orygn/opa-mcp
```

This writes the config into `.mcp.json` at your project root and is
picked up automatically on every `claude` session in that directory.
Add `--scope user` to register it globally instead.

> Replace the paths with your real absolute paths (same caveat as
> Claude Desktop above). On Windows use `C:\path\to\opa.exe` syntax.

**Persistent context and auto-checks for policy repos.**
If you work in an OPA policy repo regularly, two extra files remove
repetitive setup from every session:

- [`examples/CLAUDE.md`](./examples/CLAUDE.md) -- copy to your repo
  root or `.claude/CLAUDE.md`. Claude Code loads it every session,
  so the agent always knows which tools to use and what conventions apply.
- [`examples/claude-code-hook.json`](./examples/claude-code-hook.json) --
  merge the `hooks` block into `.claude/settings.json`. Runs `opa check`
  automatically after any `.rego` file is written, so syntax errors
  surface immediately without a manual tool call.

### Cursor

Drop [`examples/cursor.json`](./examples/cursor.json) into either
`.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json` (user-scoped).

### VS Code (GitHub Copilot Chat)

Drop [`examples/vscode.json`](./examples/vscode.json) into
`.vscode/mcp.json`, or paste the `servers` block into your user
`settings.json` under `mcp.servers`.

### Windsurf, Zed, and others

See [`examples/`](./examples) for a full set of drop-in configs.

### Manual install (any MCP client)

```bash
npm install -g @orygn/opa-mcp
opa-mcp --version
```

then point your client at the `opa-mcp` binary.

### Docker

```bash
docker pull orygn/opa-mcp:latest
docker run --rm -i \
  -v /path/to/your/policies:/policies:ro \
  -e OPA_MCP_ALLOWED_PATHS=/policies \
  orygn/opa-mcp
```

The image is multi-arch (`linux/amd64`, `linux/arm64`), bundles pinned
versions of `opa` and `regal`, and runs as a non-root user. No host
install of OPA or Regal is required.

### ⚠ First-time install gotcha (read this if you used `npx` or the global install)

If your client's `PATH` doesn't include the directory where `opa` lives
(this happens with Claude Desktop on Windows and macOS by default), the
server boots fine but every tool call returns `OPA_BINARY_NOT_FOUND`.

**Fix:** add `OPA_BINARY` and `REGAL_BINARY` env entries to your client
config with the absolute path to each binary. The example configs under
[`examples/`](./examples) ship with placeholder paths you replace.
Find the real paths with:

```bash
which opa && which regal                                    # macOS / Linux
```

```powershell
Get-Command opa, regal | Select-Object Source              # Windows
```

This does not affect the **Docker** or **MCPB** install paths; those
ship `opa` and `regal` inside the bundle and bypass `PATH` entirely.
See [Troubleshooting](#troubleshooting) for full detail.

## Configuration

The server reads its configuration from environment variables. Every
variable is optional; defaults are sensible for a local OPA on
`http://localhost:8181`.

| Variable                     | Default                      | Purpose                                                                                                                                                   |
| ---------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPA_URL`                    | `http://localhost:8181`      | Base URL of an OPA REST endpoint, used by `opa_*` tools.                                                                                                  |
| `OPA_TOKEN`                  | _(unset)_                    | Bearer token for OPA, if your instance requires auth. Treated as a secret. Never echoed in logs or tool responses.                                        |
| `OPA_BINARY`                 | `opa` (on `PATH`)            | Path to the `opa` CLI, used by `rego_*` tools.                                                                                                            |
| `REGAL_BINARY`               | `regal` (on `PATH`)          | Path to the `regal` linter. Only required by `rego_lint`.                                                                                                 |
| `OPA_MCP_ALLOWED_PATHS`      | _(unset)_                    | Comma- or semicolon-separated list of directories the server is allowed to read policies from. **When unset, file-based tools refuse to read from disk.** |
| `OPA_MCP_LOG_FILE`           | `<tmpdir>/orygn-opa-mcp.log` | Path the server appends logs to. The server never writes to stdout; that channel is reserved for the MCP protocol.                                        |
| `OPA_MCP_LOG_LEVEL`          | `info`                       | One of `debug`, `info`, `warn`, `error`.                                                                                                                  |
| `OPA_MCP_MAX_RESPONSE_BYTES` | `100000`                     | Hard cap on a single tool response. Larger payloads are truncated with a `__truncated: true` marker.                                                      |
| `OPA_MCP_TIMEOUT_MS`         | `30000`                      | Hard timeout for any spawned subprocess (`opa`, `regal`). After this, the child gets `SIGTERM` and then `SIGKILL`.                                        |
| `OPA_MCP_HTTP_TIMEOUT_MS`    | `15000`                      | Timeout for HTTP requests to the OPA REST API.                                                                                                            |

Paths in `OPA_MCP_ALLOWED_PATHS` and the `*_BINARY` variables must be
absolute. Relative paths and missing binaries are rejected with structured
errors.

## Tool reference

Every tool returns a JSON envelope:

```json
{ "ok": true, "data": { ... }, "warnings": [ ... ] }
{ "ok": false, "error": { "code": "INVALID_REGO", "message": "...", "hint": "...", "details": { ... } } }
```

Stable error codes: `INVALID_INPUT`, `INVALID_REGO`, `INVALID_BUNDLE`,
`EVAL_ERROR`, `OPA_BINARY_NOT_FOUND`, `REGAL_NOT_FOUND`,
`REGAL_VERSION_TOO_OLD`, `OPA_UNREACHABLE`, `OPA_AUTH_FAILED`,
`POLICY_NOT_FOUND`, `PATH_NOT_ALLOWED`, `PATH_NOT_FOUND`,
`DEPENDENCY_CONFLICT`, `NO_TESTS_FOUND`, `HTTP_SEND_BLOCKED`, `TIMEOUT`,
`UNKNOWN_ERROR`.

### Category A: Authoring & static analysis

Operate on Rego source code without needing a running OPA server. Wrap
`opa fmt`, `opa parse`, `opa check`, `opa inspect`, `opa capabilities`,
`opa deps`, and `regal`.

| Tool                | What it does                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `rego_format`       | Format Rego source. Wraps `opa fmt`. Idempotent.                                                                                  |
| `rego_check`        | Type-check and validate Rego. Wraps `opa check`.                                                                                  |
| `rego_lint`         | Run Regal across a file or directory. Returns findings grouped by category. **Requires `regal` on `PATH` or `REGAL_BINARY` set.** |
| `rego_parse_ast`    | Parse Rego to AST JSON. Wraps `opa parse`.                                                                                        |
| `rego_inspect`      | Inspect a bundle or directory: packages, rules, annotations. Wraps `opa inspect`.                                                 |
| `rego_capabilities` | Return the capabilities (built-ins, future keywords) understood by the bundled OPA.                                               |
| `rego_deps`         | Static dependency analysis: rule-level data references and cross-package calls.                                                   |

#### Featured: `rego_format`

```jsonc
// Input
{
  "source": "package x\nallow{input.user==\"admin\"}"
}

// Output (ok)
{
  "ok": true,
  "data": {
    "formatted": "package x\n\nallow if input.user == \"admin\"\n",
    "changed": true
  }
}
```

#### Featured: `rego_check`

```jsonc
// Input
{
  "source": "package x\nallow if y",
  "strict": true
}

// Output (error path; the JSON diagnostics arrive on stderr from opa)
{
  "ok": true,
  "data": {
    "valid": false,
    "errors": [
      {
        "code": "rego_unsafe_var_error",
        "message": "var y is unsafe",
        "location": { "row": 2, "col": 11 }
      }
    ]
  }
}
```

### Category B: Evaluation & testing

Run a query against a policy and input. Wrap `opa eval`, `opa test`, and
`opa bench`.

| Tool                      | What it does                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `rego_eval`               | Evaluate a query against a policy and input. The bread-and-butter tool.              |
| `rego_eval_with_explain`  | Evaluate with `--explain=full` and return a structured trace.                        |
| `rego_eval_with_profile`  | Evaluate with `--profile` and return per-rule timing and evaluation counts.          |
| `rego_eval_with_coverage` | Evaluate with `--coverage` and return per-line coverage.                             |
| `rego_test`               | Run `opa test` over a directory. Returns pass/fail per test, with optional coverage. |
| `rego_bench`              | Run `opa bench` and return statistical timing data.                                  |
| `rego_compile_query`      | Partially evaluate a query against a policy.                                         |

#### Featured: `rego_eval`

```jsonc
// Input
{
  "query": "data.rbac.allow",
  "source": "package rbac\nimport rego.v1\nallow if input.role == \"admin\"",
  "input": { "role": "admin" }
}

// Output
{
  "ok": true,
  "data": {
    "result": [{ "expressions": [{ "value": true, "text": "data.rbac.allow", "location": { "row": 1, "col": 1 } }] }]
  }
}
```

### Category C: Bundle operations

Package and sign deployable bundles. Wrap `opa build` and `opa sign`.

| Tool               | What it does                                                                          |
| ------------------ | ------------------------------------------------------------------------------------- |
| `opa_bundle_build` | Build a `.tar.gz` bundle from a policy directory. Supports `optimize` and `revision`. |
| `opa_bundle_sign`  | Sign a bundle with a private key. Returns `.signatures.json` content.                 |

### Category D: OPA server management

Talk to a running OPA server over its REST API. Require `OPA_URL` to
point at a reachable server.

| Tool                 | What it does                                           |
| -------------------- | ------------------------------------------------------ |
| `opa_list_policies`  | List policies registered on the server.                |
| `opa_get_policy`     | Get a single policy by ID.                             |
| `opa_put_policy`     | Upload or replace a policy.                            |
| `opa_delete_policy`  | Delete a policy by ID.                                 |
| `opa_get_data`       | Read a path from the data hierarchy.                   |
| `opa_put_data`       | Write to a path in the data hierarchy.                 |
| `opa_patch_data`     | Apply a JSON Patch to the data hierarchy.              |
| `opa_query_decision` | POST to a `/v1/data/...` decision endpoint with input. |
| `opa_compile_query`  | Partially evaluate a query against the running server. |
| `opa_health`         | Liveness / readiness check.                            |
| `opa_status`         | Bundle / decision-log status.                          |
| `opa_config`         | Server configuration (without secrets).                |

### Category E: Higher-level helpers

The differentiation surface. These compose lower-level primitives into
the tasks agents are actually asked to do.

| Tool                          | What it does                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rego_explain_decision`       | Walk through every rule that fired (and didn't) for a given query. Wraps `rego_eval_with_explain` and produces a step-by-step natural-language trace. |
| `rego_generate_test_skeleton` | Given a policy, generate a `_test.rego` skeleton covering each rule.                                                                                  |
| `rego_describe_policy`        | Summarize what a policy does, its inputs, decisions, and assumptions.                                                                                 |
| `rego_suggest_fix`            | For a failed `rego_check` or `rego_lint`, propose minimal patches.                                                                                    |
| `rego_coverage_gaps`          | Run `opa test --coverage` and return per-file uncovered line ranges, sorted worst first. Use `threshold` to focus on files below a target percentage. |
| `rego_security_audit`         | Run regal lint restricted to `security` and `bugs` categories across a directory. Returns severity-grouped findings with remediation guidance.        |

### Category F: Meta

| Tool              | What it does                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp_server_info` | Return server name, version, resolved `opa`/`regal` versions, transport type, and Node.js version in one call. Useful for verifying which server instance the agent is connected to. |

## Prompts

Three [MCP prompts](https://modelcontextprotocol.io/specification/server/prompts)
ship with the server. Clients surface them as slash commands or workflow
templates.

| Prompt                        | Purpose                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `policy_authoring_assistant`  | Walks the agent through writing a new policy: ask about the decision surface, draft, review, format, lint, test. |
| `policy_review_checklist`     | Review checklist for an existing policy: completeness, edge cases, performance, security pitfalls.               |
| `decision_debugging_workflow` | Diagnostic flow when a decision is unexpected: gather input, run with explain, isolate the rule, propose a fix.  |

## Resources

Three [MCP resources](https://modelcontextprotocol.io/specification/server/resources)
expose curated reference data the agent can read at any time.

| Resource URI        | What's there                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opa://builtins`    | Categorized OPA built-in function reference, derived at read time from `opa capabilities --current`. Security-sensitive functions (`http.send`, `crypto.x509.*`, `opa.runtime`) are flagged. |
| `opa://style-guide` | Condensed Rego style guide, formatted for LLM consumption.                                                                                                                                   |
| `opa://patterns`    | Curated common-pattern library: RBAC, ABAC, Kubernetes admission, IaC gates, API authz, rate limiting. Each pattern includes when-to-use, full Rego, a test, and common pitfalls.            |

## Cookbook

A few session shapes that the tool set was designed for.

### "Help me write a policy"

```
You: I need an authz policy: editors can read/write, viewers can only read,
     admins can do anything.

Agent: I'll draft it. (calls rego_format on a draft, then rego_check, then
       rego_lint)

Agent: Here's the policy. I've also generated a test file with cases for
       each role. (calls rego_generate_test_skeleton, then rego_test)

Agent: All 9 tests pass. Want me to save it to <path>?
```

### "Why was this denied?"

```
You: This API call is being denied and I don't know why.
     [pastes input.json]

Agent: (calls rego_explain_decision against your local policy with that input)

Agent: The deny comes from rule `forbid_anonymous_writes` at line 17.
       Specifically, `input.user` is null and the request method is "POST".
       The rule fires, which causes the default deny. To allow this, you'd
       need either an authenticated user or a policy exception for this
       endpoint.
```

### "Push this policy to staging OPA"

```
You: Push policies/rbac.rego to the staging OPA server, but first lint and
     test it.

Agent: (rego_lint → 2 style warnings, no errors)
       (rego_test on policies/ → all pass)
       (opa_put_policy with id="rbac" against $OPA_URL)
       (opa_get_policy to verify)

Agent: Done. Policy `rbac` is live on staging at $OPA_URL.
```

## Architecture

```
┌──────────────────────────────────── @orygn/opa-mcp ───────────────────────────────────┐
│                                                                                       │
│   src/server.ts ──── McpServer (stdio) ─── tool / prompt / resource registries        │
│                          │                                                            │
│                          ├── tools/authoring/         ─┐                              │
│                          ├── tools/evaluation/        ─┤                              │
│                          ├── tools/bundles/           ─┼─── lib/opa-cli.ts ──┐        │
│                          ├── tools/server-management/ ─┤                     │        │
│                          ├── tools/helpers/           ─┤                     │        │
│                          ├── tools/meta/              ─┘                     │        │
│                          │                                                   ▼        │
│                          │                              lib/subprocess.ts ──┴── opa   │
│                          │                              lib/regal-cli.ts   ───── regal│
│                          │                              lib/opa-client.ts  ───── HTTP │
│                          │                                                            │
│                          └── lib/output.ts (envelope + truncation)                    │
│                              lib/security.ts (path allow-list)                        │
│                              lib/errors.ts (structured failures)                      │
│                              lib/logger.ts (file-only, never stdout)                  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Three things worth knowing if you're going to operate this:

1. **stdout is the protocol channel.** The server logs to a file via
   `lib/logger.ts` and never writes to stdout. If you see stray stdout
   bytes, the client disconnects; the MCP transport layer is strict.
2. **No tool throws.** Every tool catches its own exceptions and returns
   a structured `{ ok: false, error: ... }` envelope. The agent sees a
   stable error vocabulary, not a stack trace.
3. **Subprocesses are tightly bounded.** `lib/subprocess.ts` runs `opa`
   and `regal` with `shell: false`, a hard timeout, and `SIGTERM`-then-
   `SIGKILL` escalation. There is no path through the server where an
   agent can construct a shell command.

## Security

This server is designed to run **locally**, started by an MCP client on
the user's own machine, communicating over stdio. It is not designed to
be exposed on the network.

- File-based tools refuse to read anything outside `OPA_MCP_ALLOWED_PATHS`.
  When that variable is unset, file tools return `PATH_NOT_ALLOWED`.
- Subprocesses run with `shell: false` and a hard timeout.
- `OPA_TOKEN` is never echoed in tool responses or log entries.
- Releases are published with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements);
  the Docker image is built reproducibly from the committed `Dockerfile`.

To report a vulnerability, follow [SECURITY.md](./SECURITY.md). **Please
do not open a public issue for security problems.**

## Troubleshooting

Common issues, fast fixes.

**`OPA_BINARY_NOT_FOUND` even though `opa` is installed.** _(most common
first-day issue, read this first)_

MCP clients (notably **Claude Desktop on Windows and macOS**) launch the
server with a deliberately reduced `PATH` that omits user-local bin
directories, even ones that work fine in your interactive shell. The
binary is on your machine; the spawned MCP server just can't see it.

Find the absolute path to `opa`:

```bash
# macOS / Linux
which opa
# → /usr/local/bin/opa  (or /opt/homebrew/bin/opa, or ~/.local/bin/opa)
```

```powershell
# Windows
Get-Command opa | Select-Object -ExpandProperty Source
# → C:\Users\you\bin\opa.exe  (or wherever)
```

Then set `OPA_BINARY` to that absolute path in your client's MCP `env`
block. Same for `REGAL_BINARY` if you use the `rego_lint` tool. The
[`examples/`](./examples) configs already include both env vars; just
edit the placeholder paths.

This issue does **not** affect the Docker or MCPB install paths. Those
bundle `opa` and `regal` and bypass `PATH` entirely.

**The server starts, then the client says "disconnected."**

The most likely cause is something in the process writing to stdout
besides MCP frames. If you've added a custom tool, check that no library
it calls prints to stdout. The fixed-position safety net is
`lib/logger.ts`. Use it, not `console.log`.

**`PATH_NOT_ALLOWED` on a file under my project.**

`OPA_MCP_ALLOWED_PATHS` is empty by default. Set it to the absolute
path(s) you want the server to read from, comma-separated.

**`OPA_UNREACHABLE` when calling `opa_*` tools.**

`OPA_URL` (default `http://localhost:8181`) must point at a running OPA
server (`opa run --server ...`). Check with `curl $OPA_URL/health`.

**Regal "version too old."**

We track the current Regal release. If `REGAL_VERSION_TOO_OLD` fires,
upgrade Regal: `brew upgrade regal` or download from the
[Regal releases](https://github.com/StyraInc/regal/releases) page.

**`directory-package-mismatch` violation when linting inline source.**

Since v0.1.1, the server auto-disables this rule for inline-source calls.
If you see it, you are running an older version -- upgrade to v0.1.1 or
later. To get canonical signal on this rule, lint via `paths` against the
real on-disk file instead of passing `source` directly.

**Where are the logs?**

Default location is `<OS-tmpdir>/orygn-opa-mcp.log`. That's typically
`/tmp/orygn-opa-mcp.log` on Linux/macOS or `%TEMP%\orygn-opa-mcp.log`
on Windows. Set `OPA_MCP_LOG_FILE` to override, and
`OPA_MCP_LOG_LEVEL=debug` to widen the firehose.

## Development

```bash
git clone https://github.com/OrygnsCode/opa-mcp-server.git
cd opa-mcp-server
npm install
npm run dev
```

Common commands:

```bash
npm run lint              # ESLint
npm run typecheck         # tsc --noEmit
npm test                  # unit tests (Vitest)
npm run test:coverage     # unit + coverage report
npm run test:integration  # against real opa + regal binaries
npm run build             # compile to dist/
```

CI runs lint, typecheck, build, and unit tests on every push and PR
across Ubuntu, macOS, and Windows on Node 20, 22, and 24. Integration
tests run on Linux against pinned `opa` and `regal` releases.

For the full contributor workflow (adding tools, naming conventions,
logging discipline, release process), see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Versioning & support

This project follows [Semantic Versioning](https://semver.org/). The public
surface for SemVer purposes is the set of registered tools, prompts, and
resources, their input/output schemas, the recognized environment
variables, and the CLI entry point.

Breaking changes will be:

- announced in [CHANGELOG.md](./CHANGELOG.md) under a new major version,
- preceded by at least one minor release with a deprecation warning,
- accompanied by a migration note in the release announcement.

Pinned versions of the upstream toolchain (`opa` and `regal`) are treated
as part of the build, not as a dependency the operator manages. The
Dockerfile, MCPB bundle, and CI all use the same pin; bumps go through
Dependabot or a manual PR.

## License

[MIT](./LICENSE) © Orygn LLC

`@orygn/opa-mcp` is an independent project. It is not affiliated with,
endorsed by, or sponsored by the Open Policy Agent project, the Cloud
Native Computing Foundation, Styra, or Anthropic. "Open Policy Agent"
and "Rego" are trademarks of their respective owners. "Model Context
Protocol" is a trademark of Anthropic, PBC.

Listed in the [OPA Ecosystem](https://www.openpolicyagent.org/ecosystem/entry/opa-mcp).
