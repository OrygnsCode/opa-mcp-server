# Security Policy

We take security seriously. This document describes the supported versions,
how to report a vulnerability, and the threat model the project assumes.

## Supported versions

`@orygn/opa-mcp` is in early release. Until `1.0.0` ships, only the latest
minor release is supported with security fixes.

| Version        | Status                         |
| -------------- | ------------------------------ |
| `0.x` (latest) | Supported                      |
| Older `0.x`    | Not supported — please upgrade |

After `1.0.0`, the most recent two minor versions will receive security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting form:

> <https://github.com/OrygnsCode/opa-mcp-server/security/advisories/new>

If you cannot use GitHub Security Advisories, email
**security@orygn.tech** with:

- A description of the issue and the impact you observed.
- Steps to reproduce, ideally a minimal proof of concept.
- The version of `@orygn/opa-mcp` you tested against
  (`opa-mcp --version` or the npm / Docker tag).
- Your platform, Node.js version, and OPA version, if relevant.

You should expect:

- An acknowledgement within **3 business days**.
- A triage decision (accepted, needs more info, or out of scope) within
  **7 business days**.
- A fix and coordinated disclosure timeline appropriate to severity.
  Critical issues are typically resolved within 30 days.

We follow [coordinated disclosure](https://www.cisa.gov/coordinated-vulnerability-disclosure-process).
Please give us reasonable time to ship a fix before publishing details.
We are happy to credit reporters in the advisory.

## Threat model

This server is designed to run **locally**, started by an MCP client on the
user's own machine, communicating over stdio. It is not designed to be exposed
on the network.

### In scope

- Path traversal or sandbox escape via tool inputs.
- Command injection via tool inputs that reach a subprocess.
- Leakage of `OPA_TOKEN` or other secrets in tool responses, logs, or error
  messages.
- Denial of service via unbounded subprocess execution, unbounded HTTP
  responses, or unbounded recursion.
- Vulnerabilities in our handling of OPA bundle signatures or verification.
- Supply-chain integrity of our published artifacts (npm, Docker, MCPB).

### Out of scope

- Vulnerabilities in OPA itself — please report those upstream at
  <https://github.com/open-policy-agent/opa/security>.
- Vulnerabilities in Regal — report at
  <https://github.com/StyraInc/regal/security>.
- Vulnerabilities in the MCP SDK or transports — report at
  <https://github.com/modelcontextprotocol>.
- Issues that require an attacker to already have full write access to the
  user's machine, the policy directory, or the OPA server.
- Running the server as `root` against untrusted input (do not do this).

## Mitigations the server applies

- File-based tools refuse to read paths outside `OPA_MCP_ALLOWED_PATHS`.
- All subprocesses are spawned with `shell: false` and a hard timeout
  (default 30 seconds), with `SIGTERM` then `SIGKILL` escalation.
- Tool responses are size-capped (`OPA_MCP_MAX_RESPONSE_BYTES`); larger
  payloads are truncated rather than streamed back unbounded.
- Stdout is reserved for the MCP protocol; logs go to a file.
- `OPA_TOKEN` is never echoed in tool responses or log entries.
- Releases are published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements);
  the Docker image is built reproducibly via GitHub Actions.

## Hardening recommendations for operators

- Set `OPA_MCP_ALLOWED_PATHS` explicitly. Do not point it at your home
  directory.
- Run the server as a non-root user. The Docker image already does.
- If you set `OPA_TOKEN`, store it in your client's secret storage rather
  than in plaintext config files.
- Keep the package and the underlying `opa` / `regal` binaries up to date.

Thank you for helping keep `@orygn/opa-mcp` and its users safe.
