# Integration tests

Integration tests run tools against a **real OPA binary** and (where applicable) a
real running OPA server. They are slower than unit tests and require local setup.

## Prerequisites

- `opa` on PATH or `OPA_BINARY` set
- For server-management tests: a local OPA running with `opa run --server`
- For lint tests: `regal` on PATH or `REGAL_BINARY` set

## Running

```bash
npm run test:integration
```

CI runs these in a Docker-ised environment with a pinned OPA version — see
`.github/workflows/ci.yml`.
