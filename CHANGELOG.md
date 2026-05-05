# Changelog

All notable changes to `@orygn/opa-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The public surface — for the purposes of SemVer — is:

- the set of registered MCP tools, prompts, and resources
- the input and output schemas of those tools
- the set of recognized environment variables
- the CLI entry point (`opa-mcp`) and its supported flags

Internal helpers (`src/lib/**`), type names not re-exported, and log formats are
not part of the public surface and may change in minor releases.

## [Unreleased]

### Added

- Initial repository scaffold: TypeScript build, ESLint flat config, Prettier,
  Vitest, multi-arch Dockerfile, MCPB manifest, Smithery descriptor, and MCP
  registry metadata.
- CI workflows for lint, typecheck, build, unit tests (Ubuntu / macOS / Windows
  on Node 20 and 22), coverage upload, and integration tests against pinned OPA
  and Regal binaries.
- Release workflow producing an npm package with provenance, a multi-arch Docker
  image, and an MCPB bundle attached to the GitHub release.
- CodeQL workflow and Dependabot configuration for npm, GitHub Actions, and
  Docker base images.

[Unreleased]: https://github.com/OrygnsCode/opa-mcp-server/compare/HEAD
