# OPA MCP

Gives Claude tools for writing, testing and debugging Open Policy Agent (OPA)
Rego policies, run against the real OPA binary instead of guessed. Claude can
evaluate a policy on sample inputs, explain why a rule matched nothing or
fell back to its default, probe a policy for inputs that should be denied but
get through, and turn those inputs into tests. It also lints with Regal,
checks Kubernetes, Terraform and Dockerfile configs with Conftest, and talks
to a running OPA server.

This plugin runs the open-source [opa-mcp](https://github.com/OrygnsCode/opa-mcp-server)
server. It is an independent project, not part of the OPA project or the CNCF.

## Install

In Claude Code:

```
/plugin install opa-mcp --marketplace OrygnsCode/opa-mcp-server
```

In Claude Desktop, for Cowork: open **Plugins**, select **Add > Add
marketplace**, enter `OrygnsCode/opa-mcp-server`, then install OPA MCP from it.

## Use it

Ask Claude about a policy, for example "why does this deny rule never fire?"
or "probe policy.rego for inputs that should be denied".

In Claude Code, file tools read and write inside the folders the session has
open. Claude Desktop does not share a Cowork task's folders with the server,
so there file tools stay off unless `OPA_MCP_ALLOWED_PATHS` is set (see
Settings), and Claude passes the policy text instead, which works anywhere.

## Requirements

- Node.js 22 or later on your `PATH`. The plugin starts the pinned
  `@orygn/opa-mcp` release with `npx`. The first start downloads it, about
  40 MB with OPA; later starts use npm's cache. If Claude Code reports the
  server failed on that first start, reconnect it from `/mcp`.
- OPA comes with that package for Windows x64, macOS and Linux (x64 and
  arm64). An `opa` already on your `PATH` is used first.
- Optional: [Regal](https://www.openpolicyagent.org/projects/regal) for
  `rego_lint`, `rego_security_audit` and `rego_fix`, and
  [Conftest](https://www.conftest.dev/) for the `conftest_*` tools.

## Settings

The plugin has no settings screen: Claude Desktop does not start a plugin
server that uses one. The server reads environment variables instead, from
the environment Claude starts in, or for Claude Code from the `env` block of
`~/.claude/settings.json`:

```json
{
  "env": {
    "OPA_URL": "http://localhost:8181",
    "OPA_MCP_TELEMETRY": "off"
  }
}
```

- `OPA_URL` and `OPA_TOKEN`: only for the `opa_*` tools that talk to a
  running OPA server.
- `OPA_MCP_ALLOWED_PATHS`: folders the file tools may use, when the app does
  not share its own.
- `REGAL_BINARY` and `CONFTEST_BINARY`: full paths, if those are not on
  `PATH`.
- `GITHUB_TOKEN`: read only by `rego_playground_share`, which posts a policy
  as a gist when you ask it to.
- `OPA_MCP_TELEMETRY=off` or `DO_NOT_TRACK=1`: turns usage stats off.

[The main README](https://github.com/OrygnsCode/opa-mcp-server#configuration)
lists the rest.

## Updates

The plugin pins one opa-mcp release. In Claude Code, run
`claude plugin update opa-mcp@orygn`, or turn on auto-update for the `orygn`
marketplace under `/plugin`, **Marketplaces**. In Claude Desktop, select
**Check for updates** on the marketplace.

## What it sends, and where

- **Usage stats**: once a day, after the first tool call, an anonymous report
  to `telemetry.orygn.tech`: which tools were called, the error codes they
  returned, where an unexpected error was thrown in opa-mcp's own code, and
  the versions in use. No policies, inputs, file paths or ID.
  [The privacy page](https://github.com/OrygnsCode/opa-mcp-server/blob/main/docs/privacy.md)
  lists every field.
- **Your OPA server**, at `OPA_URL`, when you use an `opa_*` tool.
- **GitHub** (`api.github.com`), only when you ask `rego_playground_share` to
  share a policy and `GITHUB_TOKEN` is set.

Policies run locally through the `opa`, `regal` and `conftest` binaries. The
server passes them only a short list of environment variables, so a policy
cannot read your tokens through `opa.runtime()`.

## License

MIT. Source, issues and the full tool list:
https://github.com/OrygnsCode/opa-mcp-server
