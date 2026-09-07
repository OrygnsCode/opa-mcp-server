# Integration tests

Integration tests run tools against a **real OPA binary** and (where applicable) a
real running OPA server. They are slower than unit tests and require local setup.

## Prerequisites

- `opa` on PATH or `OPA_BINARY` set; the package's bundled copy is used
  when neither is available
- For the lint and fix tests: `regal` on PATH or `REGAL_BINARY` set
- For the conftest tests: `conftest` on PATH or `CONFTEST_BINARY` set
- The server-management tests start their own `opa run --server`

## Running

```bash
npm run test:integration
```

CI runs them on Linux, and on Windows as a non-required check, with pinned
`opa`, `regal` and `conftest` releases - see `.github/workflows/ci.yml`.
