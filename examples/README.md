# Client configuration examples

Drop-in MCP client configurations for `@orygn/opa-mcp`. Pick the file that
matches your client, copy the relevant entry into your client's config, and
edit the environment variables to match your environment.

> ⚠ **Before you save:** the example configs set `OPA_BINARY` and
> `REGAL_BINARY` to placeholder paths, `/usr/local/bin/opa` and
> `/usr/local/bin/regal`. With the npm package, `opa` is bundled for the
> five platforms it is built for, so `OPA_BINARY` can be removed or left
> pointing at your own copy; the MCPB bundle has no bundled `opa`, so there
> it must be a real path. `regal` and `conftest` are never bundled, and many
> MCP clients (notably Claude Desktop on Windows and macOS) launch with a
> reduced `PATH` that does not include user-local bin directories, so
> `REGAL_BINARY` and `CONFTEST_BINARY` should be absolute paths. Find them
> with:
>
> ```bash
> which opa && which regal                                    # macOS / Linux
> ```
>
> ```powershell
> Get-Command opa, regal | Select-Object Source              # Windows
> ```
>
> Substitute those into the `env` block. A wrong path shows up as
> `REGAL_NOT_FOUND` or `CONFTEST_NOT_FOUND` on the first call that needs the
> binary, and as `OPA_BINARY_NOT_FOUND` where no bundled `opa` exists.

| File                                           | Client                        | Config location                                                                                                                    |
| ---------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`claude-desktop.json`](./claude-desktop.json) | Claude Desktop                | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows: `%APPDATA%\Claude\claude_desktop_config.json` |
| [`claude-code.json`](./claude-code.json)       | Claude Code (CLI)             | Project: `.mcp.json` &nbsp;·&nbsp; User: `~/.claude.json`                                                                          |
| [`cursor.json`](./cursor.json)                 | Cursor                        | Project: `.cursor/mcp.json` &nbsp;·&nbsp; User: `~/.cursor/mcp.json`                                                               |
| [`vscode.json`](./vscode.json)                 | VS Code (GitHub Copilot Chat) | Project: `.vscode/mcp.json` &nbsp;·&nbsp; User: settings.json under `"mcp.servers"`                                                |
| [`windsurf.json`](./windsurf.json)             | Windsurf                      | `~/.codeium/windsurf/mcp_config.json`                                                                                              |
| [`zed.json`](./zed.json)                       | Zed                           | `~/.config/zed/settings.json` (under `"context_servers"`)                                                                          |
| [`docker.json`](./docker.json)                 | Any client, Docker transport  | Substitute `command`/`args` in your client's existing config                                                                       |

## Claude Code extras

Two additional files are provided for Claude Code users working in a policy
repo day-to-day:

| File                                               | Purpose                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [`CLAUDE.md`](./CLAUDE.md)                         | Standing instructions template. Copy to your repo root or `.claude/CLAUDE.md`. Claude Code loads it every session.       |
| [`claude-code-hook.json`](./claude-code-hook.json) | PostToolUse hook config. Merge the `hooks` block into `.claude/settings.json` to run `opa check` on every `.rego` write. |

### Using CLAUDE.md

Copy the file to your policy repo root (or `.claude/CLAUDE.md`) and fill in
the `## Conventions` section at the bottom with your project-specific package
naming, input schema location, test runner command, and any other invariants
you want Claude to know about.

### Using the hook

1. Copy `.claude/settings.json` if it does not already exist in your repo, or
   open the existing one.
2. Merge the `"hooks"` key from `claude-code-hook.json` into it.
3. Ensure `opa` is on `PATH` (or replace `'opa'` in the command string with
   the absolute path).

After that, every time Claude Code writes a `.rego` file the hook runs
`opa check` and reports any syntax errors directly in the session -- no
manual tool call required.

If you do not see your client here, the server itself is just stdio - any
MCP-compliant client can run it via:

```
command:  npx
args:     ["-y", "@orygn/opa-mcp"]
```

## Environment variables

All examples use the same environment variables. The most important are:

- **`OPA_URL`** - base URL of your OPA REST endpoint (default
  `http://localhost:8181`). Required by the `opa_*` tools.
- **`OPA_TOKEN`** - bearer token for OPA, if your instance requires auth.
  **Never commit this to source control.** Use your client's secret-storage
  feature where available.
- **`OPA_BINARY`** - absolute path to the `opa` CLI. When unset the server
  tries `opa` on `PATH`, then the copy bundled with the npm package on the
  five platforms it is built for. Required with the MCPB bundle and on other
  platforms.
- **`REGAL_BINARY`** - absolute path to the `regal` linter, used by
  `rego_lint`, `rego_security_audit` and `rego_fix`. Clients that launch
  with a reduced `PATH` need the absolute path.
- **`CONFTEST_BINARY`** - absolute path to `conftest`, used by the
  `conftest_*` tools. Same `PATH` caveat.
- **`OPA_MCP_ALLOWED_PATHS`** - comma- or semicolon-separated list of
  directories the server is allowed to read policies from. **Required for
  any tool that reads policy files from disk.** When unset, file-based
  tools refuse to run.

The full list - including logging, response-size, and timeout settings - is
in the [main README](../README.md#configuration).

## Two install paths

The example configs all use **`npx -y @orygn/opa-mcp`**, which downloads and
runs the latest published version on demand. This is the simplest path: no
global install, always up to date.

If you would rather pin a version or use a globally installed binary,
substitute:

```
command:  opa-mcp
args:     []
```

…after running `npm install -g @orygn/opa-mcp`, or substitute the Docker
form in [`docker.json`](./docker.json).

## A note on path values

Paths in `OPA_MCP_ALLOWED_PATHS` and the `*_BINARY` variables must be
absolute. JSON does not allow comments, so the placeholder values in these
files (`/path/to/your/policies`, `/usr/local/bin/opa`, etc.) **must be
edited** before the config will work - the server will reject relative
paths and missing binaries with a clear error.
