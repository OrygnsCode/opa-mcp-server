/**
 * Curated Rego style guide, condensed from the Rego style guide in the
 * OPA documentation for LLM consumption.
 */
export const STYLE_GUIDE = `# Rego style guide

A condensed reference for writing idiomatic, maintainable Rego. Adapted
from the Rego style guide in the OPA documentation.

## Write Rego v1

OPA 1.0 (released 2024-12-20) made v1 the default: \`if\` before every
rule body, \`contains\` for multi-value rules, and the \`in\`, \`every\`
and \`some ... in\` keywords without an import. \`import rego.v1\` is
accepted and changes nothing on OPA 1.x; it is only needed to write v1
syntax for OPA 0.59 to 0.69.

Two places are not v1 by default: a Gatekeeper ConstraintTemplate's
\`rego:\` field is Rego v0, and so are policies written for OPA before
1.0. Convert those with \`opa fmt --v0-v1\` (or \`rego_migrate_v1\`).

## Write rules that fail closed

- Decide what a missing, \`null\` or wrong-typed field must do before
  writing the rule. A deny rule that reads a missing field is undefined,
  and an undefined deny means allowed. Give the field its fail-closed
  default with \`object.get\`, or require the safe value positively.
- Require the safe value instead of testing for the dangerous one:
  \`privileged != false\`, not \`privileged == true\`; \`is_admin == true\`,
  not a bare \`input.user.is_admin\`, which holds for \`"false"\` and \`0\`.
- Negate a rule, or a function of an already-bound value
  (\`not trusted(c)\`), never an expression on a raw input field:
  \`not startswith(input.x, "y")\` is true when \`input.x\` is a number
  or null, so the rule matches input it never checked.

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
- Boolean rules: read like predicates -- \`allow\`, \`is_admin\`,
  \`should_log\`. Avoid \`is_not_blocked\` (double negative).
- Set/object rules: read like nouns -- \`grants\`, \`roles\`, \`reasons\`.
- Helper rules intended for use inside the package only: optionally
  prefix them with \`_\` (\`_is_developer\`). The style guide calls this a
  common convention, and Regal's language server uses it.

A rule cannot be named \`input\`. A rule or variable named after a
builtin (\`count\`, \`contains\`) hides it in that scope; Regal flags both
(\`rule-shadows-builtin\`, \`var-shadows-builtin\`).

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
\`every\` (introduced in OPA 0.38):

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
  than two layers deep is a smell -- the test is doing too much. Split.
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

Run with \`opa test -v --fail-on-empty .\`; without \`--fail-on-empty\` a
directory with no tests passes. Add \`--coverage\` to see which lines
were exercised. Coverage shows what no test reaches, not that the policy
denies what it should: tests that only cover the happy path reach 100%
on a policy that lets missing fields through.

## References

- Rego style guide: https://www.openpolicyagent.org/docs/style-guide
- OPA documentation: https://www.openpolicyagent.org/docs/
- Regal linter rules: https://www.openpolicyagent.org/projects/regal/rules
`;
