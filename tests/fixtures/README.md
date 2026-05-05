# Test fixtures

Sample policies, inputs, and expected outputs used by both unit and
integration tests. Treat everything in this directory as fixed test data —
do not edit a fixture without updating every test that depends on it.

## Layout

```
fixtures/
  policies/
    valid/        Compiles cleanly, used as the happy path
    invalid/      Intentional parse / type errors, used to exercise error codes
    bundles/      Input directories for opa_bundle_build tests
  inputs/         JSON inputs paired with policies for evaluation tests
  expected/       Snapshot outputs for end-to-end tool tests
```

## Conventions

- Policies live in files named after their `package` declaration so a reader
  can find a policy from a stack trace or eval result without guessing.
- Inputs use the same basename as the policy they pair with, with a `.json`
  extension.
- Anything in `invalid/` must include a comment on the first line describing
  the specific error it provokes (e.g. `# missing closing brace`).
