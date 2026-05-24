# OPA MCP Server

**Model Context Protocol (MCP) server for Open Policy Agent (OPA) and the Rego policy language.**

Wraps the OPA CLI, the OPA REST API, and the Regal linter behind 47 schema-validated tools so
any MCP-compatible client (Claude Desktop, Claude Code, Cursor, VS Code, Zed, Windsurf) can
author, evaluate, and debug Rego policies through a structured tool surface instead of free-form
CLI text.

- **Product page:** https://orygn.tech/products/opa-mcp
- **Source:** https://github.com/OrygnsCode/opa-mcp-server
- **npm:** https://www.npmjs.com/package/@orygn/opa-mcp
- **Releases (incl. signed .mcpb bundle):** https://github.com/OrygnsCode/opa-mcp-server/releases

---

## Why use this image

This image is multi-arch (`linux/amd64`, `linux/arm64`), runs as a non-root user, and bundles
pinned versions of `opa` and `regal` inside the container. No host install of OPA or Regal is
required.

That is the main reason to use this image over `npm install -g @orygn/opa-mcp` -- you get a
reproducible, self-contained runtime with no version-skew risk.

> **Note on conftest:** The `conftest_*` tools (policy testing for Kubernetes, Terraform, Helm,
> Dockerfile, and other configuration formats) require the `conftest` binary. It is **not**
> bundled in this image. To use those tools, either mount a `conftest` binary into the container
> or extend this image and install it.

---

## Quick start

```bash
docker pull orygn/opa-mcp:latest

docker run --rm -i \
  -v /path/to/your/policies:/policies:ro \
  -e OPA_MCP_ALLOWED_PATHS=/policies \
  orygn/opa-mcp
```

The container speaks MCP over stdio. Wire it into your client by pointing it at
`docker run --rm -i ... orygn/opa-mcp` as the launch command.

---

## Tags

| Tag                  | Meaning                                 |
| -------------------- | --------------------------------------- |
| `latest`             | Latest stable release.                  |
| `0.1.10`, `0.1`, `0` | SemVer aliases for the current release. |

Versioned tags follow Semantic Versioning. The public surface for SemVer purposes is the set of
registered tools, prompts, and resources, their input/output schemas, and the recognized
environment variables.

---

## Configuration

All configuration is via environment variables. Every variable is optional.

| Variable                     | Default                            | Purpose                                                                                                                                 |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `OPA_URL`                    | `http://host.docker.internal:8181` | Base URL of an OPA REST endpoint, used by `opa_*` tools.                                                                                |
| `OPA_TOKEN`                  | (unset)                            | Bearer token for OPA, if required. Treated as a secret.                                                                                 |
| `OPA_MCP_ALLOWED_PATHS`      | (unset)                            | Comma-separated list of directories the server is allowed to read policies from. When unset, file-based tools refuse to read from disk. |
| `OPA_MCP_LOG_LEVEL`          | `info`                             | One of `debug`, `info`, `warn`, `error`.                                                                                                |
| `OPA_MCP_MAX_RESPONSE_BYTES` | `100000`                           | Cap on a single tool response.                                                                                                          |
| `OPA_MCP_TIMEOUT_MS`         | `30000`                            | Hard timeout for any spawned subprocess.                                                                                                |
| `CONFTEST_BINARY`            | `conftest`                         | Path to the conftest binary. Only relevant if you extend this image to include conftest.                                                |

`OPA_BINARY` and `REGAL_BINARY` are not used in this image -- both binaries ship at known paths
inside the container.

---

## What's inside

**47 tools across six categories:**

- **Authoring** -- `rego_format`, `rego_lint`, `rego_check`, `rego_parse`, `rego_deps`,
  `rego_inspect`, `rego_capabilities`
- **Evaluation** -- `rego_eval`, `rego_test`, `rego_bench`, `rego_profile`, `rego_coverage_gaps`,
  `rego_compile`
- **Bundles** -- `rego_bundle_build`, `rego_bundle_sign`, `rego_bundle_verify`,
  `rego_bundle_inspect`
- **OPA REST** -- `opa_list_policies`, `opa_get_policy`, `opa_put_policy`, `opa_delete_policy`,
  `opa_get_data`, `opa_put_data`, `opa_patch_data`, `opa_delete_data`, `opa_query_decision`,
  `opa_compile_query`, `opa_health`, `opa_status`, `opa_config`
- **Helpers** -- `rego_explain_decision`, `rego_describe_policy`, `rego_generate_test_skeleton`,
  `rego_suggest_fix`, `rego_fix`, `rego_format_write`, `rego_security_audit`,
  `rego_coverage_gaps`, `rego_infer_input_schema`, `rego_policy_diff`, `mcp_server_info`
- **Conftest** -- `conftest_test`, `conftest_verify`, `conftest_pull`, `conftest_push`
  _(requires conftest binary -- not bundled; see note above)_

**Three MCP prompts** and **three resources** (built-in function catalog, Rego style guide,
curated pattern library).

**Stable error codes** (`INVALID_REGO`, `OPA_UNREACHABLE`, `PATH_NOT_ALLOWED`, `TIMEOUT`,
`CANCELLED`, etc.) and a structured `{ ok, data | error }` envelope on every response.

---

## Security

- Subprocesses run with `shell: false` and a hard timeout.
- File tools refuse paths outside `OPA_MCP_ALLOWED_PATHS`.
- `OPA_TOKEN` is never echoed in tool responses or log output.
- Image is built reproducibly from the committed Dockerfile.

---

## License

MIT © [Orygn LLC](https://orygn.tech)

`@orygn/opa-mcp` is an independent project. It is not affiliated with, endorsed by, or sponsored
by the Open Policy Agent project, the Cloud Native Computing Foundation, Styra, or Anthropic.
"Open Policy Agent" and "Rego" are trademarks of their respective owners.
"Model Context Protocol" is a trademark of Anthropic, PBC.
