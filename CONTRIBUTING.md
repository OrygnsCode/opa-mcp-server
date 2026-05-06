# Contributing

Thanks for your interest in `@orygn/opa-mcp`. This document covers how the
project is laid out, the workflow we expect for changes, and the conventions
that keep the codebase consistent.

If you only want to report a bug or request a feature, the
[issue templates](https://github.com/OrygnsCode/opa-mcp-server/issues/new/choose)
are the fastest path. For security problems, please follow
[SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Prerequisites

- Node.js **20** or later (the CI matrix runs on 20 and 22).
- A recent `npm` (ships with Node 20+).
- For integration tests: nothing extra — the test runner downloads pinned
  `opa` and `regal` binaries into a cache directory.

## Getting started

```bash
git clone https://github.com/OrygnsCode/opa-mcp-server.git
cd opa-mcp-server
npm install
npm run build
```

To iterate on the server locally:

```bash
npm run dev
```

`tsx watch` rebuilds on every change. The server speaks MCP over stdio, so
the easiest way to drive it during development is to point a real client at
the watched build — see [`examples/`](./examples) for client configs.

## Repository layout

```
src/
  server.ts                 # MCP server entry point (registers everything)
  config.ts                 # Env-var parsing (zod-validated)
  types.ts                  # Shared types: ToolErrorCode, ToolEnvelope
  lib/
    logger.ts               # File-only logger (stdout is reserved)
    errors.ts               # ok() / err() / fromException() helpers
    output.ts               # MCP response formatter with size cap
    security.ts             # Path allow-list enforcement
    subprocess.ts           # Safe subprocess runner (no shell, hard timeout)
    opa-cli.ts              # Wrapper around the `opa` binary
    regal-cli.ts            # Wrapper around the `regal` binary
    opa-client.ts           # HTTP client for the OPA REST API
  tools/
    authoring/              # rego_format, rego_parse, rego_check, ...
    evaluation/             # rego_eval, opa_query, ...
    bundles/                # opa_bundle_build, opa_bundle_inspect, ...
    server-management/      # opa_status, opa_health, ...
    helpers/                # rego_explain_deny, ...
  prompts/                  # MCP prompts (workflow templates)
  resources/                # MCP resources (read-only references)
tests/
  unit/                     # Vitest unit tests, mock subprocesses + HTTP
  integration/              # End-to-end tests against real opa / regal
  fixtures/                 # Sample policies and inputs
```

## The development loop

Before opening a pull request, run the same checks CI runs:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Or run them all in one shot:

```bash
npm run prepublishOnly
```

Integration tests are slower and gated separately:

```bash
npm run test:integration
```

## Adding a new tool

The five tool categories under `src/tools/` mirror the public taxonomy:

- **`authoring/`** — operates on Rego source code (parse, format, lint).
- **`evaluation/`** — runs a policy against an input.
- **`bundles/`** — builds, signs, and inspects bundles.
- **`server-management/`** — talks to a running OPA over its REST API.
- **`helpers/`** — agent-friendly aggregations on top of the others.

To add a tool:

1. Create a new file in the right category, e.g.
   `src/tools/authoring/rego-format.ts`.
2. Define the input schema with `zod`. Keep field names `snake_case` to match
   the rest of the public surface.
3. Implement the handler. Return `ok(data)` or `err(code, message)` from
   `src/lib/errors.ts` — never throw across the MCP boundary.
4. Register the tool in the category's `index.ts`.
5. Add unit tests under `tests/unit/tools/<category>/` and, where it makes
   sense, an integration test that exercises the real binary.
6. Document the tool's input schema, error codes, and an example invocation
   in the README's tool reference section.

## Naming conventions

- **Tools that wrap the OPA _binary_** are prefixed `rego_` (e.g.
  `rego_eval`, `rego_format`).
- **Tools that talk to an OPA _server_** are prefixed `opa_` (e.g.
  `opa_query`, `opa_status`).
- **Bundle operations** are prefixed `opa_bundle_` (e.g.
  `opa_bundle_build`).
- Input fields are `snake_case`. Type names and exported symbols are
  `PascalCase` / `camelCase` per standard TypeScript conventions.

## Logging discipline

**Never write to stdout.** The MCP protocol owns that channel — anything else
on stdout corrupts the JSON-RPC stream and breaks the client connection.

Use the file logger from `src/lib/logger.ts`:

```ts
import { logger } from '../lib/logger.js';

logger.info('about to run opa', { args });
```

`stderr` is acceptable for genuinely fatal startup failures, but prefer the
file logger.

## Commit messages

We do not enforce conventional-commits, but we do prefer:

- A short, imperative subject line (≤ 72 characters).
- A blank line.
- A body that explains _why_ the change is needed, not _what_ the diff
  already shows.

Reference issues with `Fixes #123` or `Refs #123` so they auto-close on merge
where appropriate.

## Pull requests

- Keep PRs focused. One logical change per PR.
- Make sure the checklist in the
  [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) is honest.
- If a change is user-visible, update `README.md` and add an entry under
  `[Unreleased]` in `CHANGELOG.md`.
- All checks must pass before review.

## Releases

Releases are tag-driven. Pushing a `v*.*.*` tag triggers
`.github/workflows/release.yml`, which:

1. Re-runs lint, typecheck, build, and tests.
2. Publishes `@orygn/opa-mcp` to npm with provenance.
3. Builds and pushes a multi-arch Docker image to
   `orygn/opa-mcp`.
4. Builds the `opa-mcp.mcpb` bundle and attaches it to the GitHub release.

Maintainers cut releases — see the launch playbook for the exact procedure.

## Questions

Open a [discussion](https://github.com/OrygnsCode/opa-mcp-server/discussions)
or an issue. We are happy to help.
