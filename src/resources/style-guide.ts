/**
 * Curated Rego style guide. Adapted from the Styra reference plus the
 * OPA team's own conventions, condensed for LLM consumption.
 */
export const STYLE_GUIDE = `# Rego style guide

A condensed reference for writing idiomatic, maintainable Rego. Adapted
from the Styra style guide and the OPA project's conventions.

## Always import \`rego.v1\`

Every \`.rego\` file should start with the v1 import. It enables the
modern syntax (\`if\`, \`contains\`, \`every\`) and disables the older
implicit-membership operator that's a frequent source of bugs.

\`\`\`rego
package authz

import rego.v1
\`\`\`

OPA 1.0 (released January 2025) treats this as the default, but
including it explicitly makes intent clear and keeps the file portable
to older OPA installations.

## Package layout mirrors directory layout

Match \`package foo.bar\` with the file path \`foo/bar/main.rego\` (or
\`foo/bar/<anything>.rego\`). Regal flags mismatches as
\`directory-package-mismatch\`.

For a multi-file package, group by responsibility:

\`\`\`
authz/
  main.rego          # principal decision (allow / deny)
  rbac.rego          # role-based access checks
  abac.rego          # attribute-based access checks
  helpers.rego       # shared helpers, no decisions
  main_test.rego     # tests for principal decisions
  rbac_test.rego     # tests for rbac
\`\`\`

Tests live in \`*_test.rego\` siblings of the source they test, in the
same package or a \`<package>_test\` package.

## Naming

- Rule names: \`snake_case\`.
- Boolean rules: read like predicates — \`allow\`, \`is_admin\`,
  \`should_log\`. Avoid \`is_not_blocked\` (double negative).
- Set/object rules: read like nouns — \`grants\`, \`roles\`, \`reasons\`.
- Helper rules: \`_\` prefix is *not* a convention; just give them names
  that explain what they return.

Names that conflict with reserved words (\`type\`, \`time\`, \`input\`) won't
parse. Names matching builtins (\`http\`, \`json\`) shadow them.

## Default deny

Every principal decision should have a default fallback so the policy
returns a value even when no rule matches.

\`\`\`rego
default allow := false

allow if {
    input.user.role == "admin"
}
\`\`\`

The same applies to set-valued reasons:

\`\`\`rego
deny contains reason if {
    not allow
    reason := "not authorized"
}
\`\`\`

## Comprehensions vs \`every\`

When you need a value derived from a collection, use a comprehension:

\`\`\`rego
admin_users := {u | some u in input.users; u.role == "admin"}
\`\`\`

When you need to assert that a property holds for every element, use
\`every\` (introduced in OPA 0.41):

\`\`\`rego
allow if {
    every claim in input.token.claims {
        claim.verified == true
    }
}
\`\`\`

\`every\` is clearer than the older \`not <comprehension>\` idiom and
short-circuits on the first failure.

## Annotations

Public rules deserve a metadata block so consumers know what they do.

\`\`\`rego
# METADATA
# title: Authorization decision for HTTP requests
# description: |
#   Returns true when the requesting principal has a role with a
#   permission entry for the requested action on the requested
#   resource. Anonymous requests always deny.
# entrypoint: true
allow if {
    some role in input.principal.roles
    permission_grants[role][input.action]
}
\`\`\`

Annotations show up in \`opa inspect\`, the registry, and editor
hovers. They are also extracted by \`rego_describe_policy\`.

## Schema annotations

For policies that are sensitive to input shape, attach a JSON Schema:

\`\`\`rego
# METADATA
# schemas:
#   - input: schema.input
allow if {
    input.user.id != ""
}
\`\`\`

Combined with \`opa check --schema\`, this turns input-shape mismatches
into compile errors instead of runtime undefineds.

## Anti-patterns

- **\`http.send\` in the decision path.** Each call adds round-trip
  latency. If you must, scope it to a small, cacheable read.
- **Deep \`with\` chains.** \`x with input as ... with data as ...\` more
  than two layers deep is a smell — the test is doing too much. Split.
- **\`print\` and \`trace\`.** Useful in development; remove before
  shipping. Regal flags both as \`print-or-trace-call\`.
- **Mixing \`if\` and the legacy implicit form in the same file.** Pick
  one. With \`rego.v1\` imported you cannot use the implicit form.

## Tests

\`opa test\` runs every rule whose name starts with \`test_\`. A test
either evaluates to true (pass) or fails to evaluate (fail). The
common shape:

\`\`\`rego
package authz_test

import rego.v1
import data.authz

test_admin_can_delete if {
    authz.allow with input as {
        "user": {"role": "admin"},
        "action": "delete",
    }
}

test_viewer_cannot_delete if {
    not authz.allow with input as {
        "user": {"role": "viewer"},
        "action": "delete",
    }
}
\`\`\`

Run with \`opa test -v ./...\` for verbose output. Add \`--coverage\` to
verify which lines were exercised.

## References

- Official Rego style guide: https://docs.styra.com/regal/rego-style-guide
- OPA documentation: https://www.openpolicyagent.org/docs/latest/
- Regal linter rules: https://docs.styra.com/regal/rules
`;
