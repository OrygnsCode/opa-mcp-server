# Privacy

opa-mcp runs on your machine (or in a container you run). Policies, inputs,
data, file paths and everything the tools return stay between it, the `opa`,
`regal` and `conftest` binaries, and the OPA server you point it at. What the
tools return goes to your AI app, and from there to whichever AI service the
app uses, under that service's terms.

One thing goes elsewhere: a small usage report, once a day. It is described
in full below and can be turned off.

## Usage stats

Once a day, opa-mcp sends an anonymous report of which tools were used, which
error codes they returned, and the versions in use, so we can see what breaks
and what to improve. There is nothing in it from your policies, inputs, data,
files or OPA server, and no ID for your install.

### When it is sent

- At most once a day per install. An install is the `usage-stats` folder in
  `~/.orygn/opa-mcp`, so several AI apps using opa-mcp on one machine send
  one report between them.
- Only after a tool is called that day. Starting the server, or listing its
  tools, sends nothing.
- A day's counts are sent with the report of the next day opa-mcp is used,
  and are deleted from your machine once sent. Counts more than a week old
  are deleted unsent.

### What a report holds

Every value is a number band, a version, or one of a fixed list.

| Field                      | Values                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version                    | The opa-mcp version, like `0.11.0`.                                                                                                                                                |
| Platform                   | Operating system (`windows`, `macos`, `linux`, `other`), architecture (`x64`, `arm64`, `other`) and the Node.js major version, like `22`.                                          |
| AI app                     | One of a fixed list, such as Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Cline, Codex, Zed, the MCP Inspector, or `other`.                                             |
| Install                    | npx, a global npm install, a project dependency, pnpm or bun's one-off runners, the Docker image, the Claude Desktop extension, or `other`.                                        |
| Context                    | `default`, or `container` when it runs in one.                                                                                                                                     |
| Binaries                   | How `opa` was found (`OPA_BINARY`, `PATH`, the copy bundled with the npm package, or not found) and the minor version of `opa`, `regal` and `conftest`, like `1.22`, or `missing`. |
| File access                | Whether file tools use `OPA_MCP_ALLOWED_PATHS`, the folders your AI app shares, or neither.                                                                                        |
| Settings                   | The names of the documented settings you changed from their defaults, like `OPA_URL` or `OPA_MCP_TIMEOUT_MS`. Never their values.                                                  |
| Install age                | Days since the install first reported: `0`, `1-7`, `8-30`, `31-90` or `90+`.                                                                                                       |
| First of week, month, ever | Whether today is the install's first active day of the week, of the month, and ever. This is how weekly and monthly use is counted without an ID.                                  |
| Report number              | A random number, new each day, so a report sent twice is counted once.                                                                                                             |

And for each of the last days it was used, up to seven:

| Field             | Values                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tools             | Each tool called that day, with how often: `1-9`, `10-99` or `100+`.                                                                                                                                                                 |
| Failures          | For each tool, the error codes it returned (like `EVAL_ERROR` or `OPA_BINARY_NOT_FOUND`, the same codes the tools return to your AI app), in the same bands. Also arguments a tool refused, and calls to a tool that does not exist. |
| Unexpected errors | Where in opa-mcp's own code an unexpected error was thrown: the error's type and a file and line, like `TypeError@lib/opa-cli.js:212`. Never the error's message, which can hold a path or a value.                                  |
| AI apps           | Which apps from the fixed list called a tool that day.                                                                                                                                                                               |

To see exactly what your install would send, set `OPA_MCP_TELEMETRY=log`: the
report is written to the server's log (and stderr) once a day instead of
being sent.

### Where it goes

Reports go to `HOSTNAME_TO_CONFIRM`, a Cloudflare Worker run by Orygn. Its
code is in this repository, in [`workers/usage/`](../workers/usage). It
accepts only the values listed above and stores anything else as `other` or
drops it.

- Your IP address is not stored. Cloudflare's country code for the request is
  kept with the counts.
- Daily counts are kept. Individual reports are deleted after seven days, and
  report numbers after three.
- The stats are private to Orygn.

### Turning it off

Any one of these does it:

- `OPA_MCP_TELEMETRY=off` in the `env` section of your AI app's config for
  opa-mcp.
- `DO_NOT_TRACK=1` in the environment.
- `OPA_MCP_NO_TELEMETRY=1`, the setting earlier versions used, still works.
- In the Claude Desktop extension, untick **Usage stats** in its settings.

It is also off on its own in CI, and in a copy run from a clone of this
repository unless you set `OPA_MCP_TELEMETRY=on`. `mcp_server_info` says
whether it is on.

### Earlier versions

Versions before 0.11.0 sent a ping each time the server started, with the
version, the platform, and a random install ID kept in
`~/.orygn/opa-mcp/install-id`. From 0.11.0 there is no install ID, and that
file is deleted the first time the server starts.
