# Test fixtures

Sample policies, inputs, and expected outputs used by both unit and
integration tests. Treat everything in this directory as fixed test data -
do not edit a fixture without updating every test that depends on it.

## Layout

```
fixtures/
  policies/
    valid/        Compiles cleanly, used as the happy path
    invalid/      Intentional parse / type errors, used to exercise error codes
  inputs/         JSON inputs paired with policies for evaluation tests
  conftest/       Policies and configs for the conftest_* tests
  migrate/        Rego v0 policies for rego_migrate_v1, each with the AST
                  `opa parse --v0-compatible --json-include locations,-comments`
                  printed for it under OPA 1.21 (file paths removed)
```

## Conventions

- Policies live in files named after their `package` declaration so a reader
  can find a policy from a stack trace or eval result without guessing.
- Inputs use the same basename as the policy they pair with, with a `.json`
  extension.
- Anything in `invalid/` must include a comment on the first line describing
  the specific error it provokes (e.g. `# missing closing brace`).
