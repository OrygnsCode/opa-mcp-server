# Client configuration examples

Drop-in MCP client configurations for `@orygn/opa-mcp`. Pick the file that
matches your client, copy the relevant entry into your client's config, and
edit the environment variables to match your environment.

> ⚠ **Before you save:** the example configs ship with placeholder
> `OPA_BINARY` and `REGAL_BINARY` paths set to `/usr/local/bin/opa` and
> `/usr/local/bin/regal`. **You almost certainly need to change these.**
> Many MCP clients (notably Claude Desktop on Windows and macOS) launch
> with a reduced `PATH` that does not include user-local bin directories,
> so the server cannot find `opa` even when it works fine in your shell.
> Find the absolute paths with:
>
> ```bash
> which opa && which regal                                    # macOS / Linux
> ```
>
> ```powershell
> Get-Command opa, regal | Select-Object Source              # Windows
> ```
>
> Substitute those into the `env` block. Skip this step and you will see
> `OPA_BINARY_NOT_FOUND` on the first tool call.

| File                                           | Client                        | Config location                                                                                                                    |
| ---------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`claude-desktop.json`](./claude-desktop.json) | Claude Desktop                | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows: `%APPDATA%\Claude\claude_desktop_config.json` |
| [`claude-code.json`](./claude-code.json)       | Claude Code (CLI)             | Project: `.mcp.json` &nbsp;·&nbsp; User: `~/.claude.json`                                                                          |
| [`cursor.json`](./cursor.json)                 | Cursor                        | Project: `.cursor/mcp.json` &nbsp;·&nbsp; User: `~/.cursor/mcp.json`                                                               |
| [`vscode.json`](./vscode.json)                 | VS Code (GitHub Copilot Chat) | Project: `.vscode/mcp.json` &nbsp;·&nbsp; User: settings.json under `"mcp.servers"`                                                |
| [`windsurf.json`](./windsurf.json)             | Windsurf                      | `~/.codeium/windsurf/mcp_config.json`                                                                                              |
| [`zed.json`](./zed.json)                       | Zed                           | `~/.config/zed/settings.json` (under `"context_servers"`)                                                                          |
| [`docker.json`](./docker.json)                 | Any client, Docker transport  | Substitute `command`/`args` in your client's existing config                                                                       |

If you do not see your client here, the server itself is just stdio — any
MCP-compliant client can run it via:

```
command:  npx
args:     ["-y", "@orygn/opa-mcp"]
```

## Environment variables

All examples use the same environment variables. The most important are:

- **`OPA_URL`** — base URL of your OPA REST endpoint (default
  `http://localhost:8181`). Required by the `opa_*` tools.
- **`OPA_TOKEN`** — bearer token for OPA, if your instance requires auth.
  **Never commit this to source control.** Use your client's secret-storage
  feature where available.
- **`OPA_BINARY`** — absolute path to the `opa` CLI. The default is
  `opa` (relying on `PATH`), but **you almost always need to set this
  explicitly** — most MCP clients launch the server with a reduced
  `PATH` that omits the directory `opa` lives in.
- **`REGAL_BINARY`** — absolute path to the `regal` linter. Same caveat
  as `OPA_BINARY`. Only used by the `rego_lint` tool, but worth setting
  alongside.
- **`OPA_MCP_ALLOWED_PATHS`** — comma- or semicolon-separated list of
  directories the server is allowed to read policies from. **Required for
  any tool that reads policy files from disk.** When unset, file-based
  tools refuse to run.

The full list — including logging, response-size, and timeout settings — is
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
edited** before the config will work — the server will reject relative
paths and missing binaries with a clear error.
