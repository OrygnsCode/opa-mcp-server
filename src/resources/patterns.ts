/**
 * Curated Rego pattern library. Each pattern includes:
 *   - When to use it
 *   - A working example
 *   - A test
 *   - Common pitfalls
 */
export const PATTERNS = `# Rego pattern library

Common Rego patterns with working examples, tests, and pitfalls. Each
pattern is self-contained -- copy, adapt, and ship.

---

## 1. Role-based access control (RBAC)

**When to use:** the simplest authorization model. Every user has one
or more roles; each role grants a set of actions on a set of
resources. Sufficient for ~80% of internal applications.

\`\`\`rego
package rbac

import rego.v1

default allow := false

# Permissions table -- extend as roles evolve.
permissions := {
    "admin": {"read", "write", "delete", "manage_users"},
    "editor": {"read", "write"},
    "viewer": {"read"},
}

allow if {
    some role in input.user.roles
    input.action in permissions[role]
}

# Why was it denied? -- useful for audit logs.
deny_reasons contains reason if {
    not allow
    user := input.user
    # object.get: sprintf with an undefined argument drops the whole rule.
    reason := sprintf(
        "user %q has roles %v, none grant %q",
        [object.get(user, "id", "<no id>"), object.get(user, "roles", []), object.get(input, "action", "<no action>")],
    )
}

deny_reasons contains "anonymous request" if {
    not allow
    not input.user
}
\`\`\`

**Test:**

\`\`\`rego
package rbac_test

import rego.v1
import data.rbac

test_admin_can_delete if {
    rbac.allow with input as {
        "user": {"id": "alice", "roles": ["admin"]},
        "action": "delete",
    }
}

test_viewer_cannot_delete if {
    not rbac.allow with input as {
        "user": {"id": "bob", "roles": ["viewer"]},
        "action": "delete",
    }
}

test_anonymous_denied if {
    not rbac.allow with input as {"action": "read"}
    reasons := rbac.deny_reasons with input as {"action": "read"}
    "anonymous request" in reasons
}
\`\`\`

**Pitfalls:**
- The \`permissions\` table grows unbounded. Move to data files
  (\`data.permissions\`) once you have more than ~20 roles.
- Roles overlap with groups in real auth systems; map at the boundary
  rather than carrying both.

---

## 2. Attribute-based access control (ABAC)

**When to use:** when "who" alone isn't enough -- decisions also depend
on resource attributes (ownership, tenant, sensitivity) and context
(time of day, source IP).

\`\`\`rego
package abac

import rego.v1

default allow := false

# Don't show "secret" resources to anyone outside the owner's
# organization, even admins.
#
# Written as a guard the permissive rules consult. A second rule
# assigning \`allow := false\` is a conflict in Rego, not an override:
# both rules produce a value for the same document and evaluation
# fails with eval_conflict_error. Deny wins by being a precondition,
# not by being written last.
hidden_from_other_org if {
    input.resource.classification == "secret"
    input.resource.org_id != input.user.org_id
}

# A user can read any resource they own.
allow if {
    input.action == "read"
    input.resource.owner_id == input.user.id
    not hidden_from_other_org
}

# A user can read shared resources at their organization.
allow if {
    input.action == "read"
    input.resource.shared == true
    input.resource.org_id == input.user.org_id
    not hidden_from_other_org
}

# Admins can do anything within their organization.
allow if {
    "admin" in input.user.roles
    input.resource.org_id == input.user.org_id
    not hidden_from_other_org
}
\`\`\`

**Test:**

\`\`\`rego
package abac_test

import rego.v1
import data.abac

test_owner_reads_own if {
    abac.allow with input as {
        "action": "read",
        "user": {"id": "u1", "org_id": "o1"},
        "resource": {"owner_id": "u1", "org_id": "o1"},
    }
}

test_admin_blocked_from_secret_in_other_org if {
    not abac.allow with input as {
        "action": "read",
        "user": {"id": "u1", "org_id": "o1", "roles": ["admin"]},
        "resource": {
            "owner_id": "u2",
            "org_id": "o2",
            "classification": "secret",
        },
    }
}
\`\`\`

**Pitfalls:**
- Multiple \`allow\` rules combine with logical OR. A later rule
  cannot override an earlier one by assigning a different value:
  two rules producing different values for the same document is an
  \`eval_conflict_error\` and evaluation fails. Express a denial as a
  condition the permissive rules must pass, as \`hidden_from_other_org\`
  does above.
- A bare reference such as \`input.resource.shared\` holds for every
  value except \`false\`, including \`"false"\`, \`0\` and \`null\`. Compare
  booleans with \`== true\`.
- Don't compute attributes inside the policy; compute them at the
  boundary and pass via \`input\`.

---

## 3. Kubernetes admission control

**When to use:** validate resources at admission time with OPA itself as
the validating webhook, which receives the AdmissionReview in
\`input.request\`. Gatekeeper templates differ: see the pitfalls.

\`\`\`rego
package k8s.admission

import rego.v1

# Every container of the pod: init and ephemeral containers run too.
containers contains c if {
    input.request.kind.kind == "Pod"
    some field in ["containers", "initContainers", "ephemeralContainers"]
    some c in object.get(input.request.object.spec, field, [])
}

# A message reads its values with defaults: sprintf with an undefined
# argument drops the whole deny.
pod_name := object.get(input.request.object, ["metadata", "name"], "<unnamed>")

container_name(c) := object.get(c, "name", "<unnamed>")

# Reject containers without a memory limit.
deny contains msg if {
    some c in containers
    not c.resources.limits.memory
    msg := sprintf(
        "pod %q container %q is missing resources.limits.memory",
        [pod_name, container_name(c)],
    )
}

# Reject privileged containers outside kube-system. Anything but an explicit
# false counts as privileged, and a request without a namespace is checked.
deny contains msg if {
    object.get(input.request, "namespace", "") != "kube-system"
    some c in containers
    object.get(c, ["securityContext", "privileged"], false) != false
    msg := sprintf(
        "privileged containers are not allowed: %q in %q",
        [container_name(c), pod_name],
    )
}
\`\`\`

**Pitfalls:**
- Check \`initContainers\` and \`ephemeralContainers\` as well as
  \`containers\`. Ephemeral containers arrive through the
  \`pods/ephemeralcontainers\` subresource, so register the webhook for
  it.
- Pods created by Deployments and other controllers are admitted as
  Pods, so a Pod check stops them when the pods are created. Check the
  controllers' \`spec.template.spec\` too to reject them at apply time,
  and in CI, where the controller manifest is all there is.
- A comparison against an optional field, such as
  \`input.request.namespace != "kube-system"\`, is undefined when the
  field is missing, and the whole deny goes silent. Give the field a
  default with \`object.get\`.
- Gatekeeper templates read \`input.review.object\` and
  \`input.parameters\`, define \`violation[{"msg": msg}]\`, and are
  Rego v0 unless the template opts in to v1.

---

## 4. Infrastructure-as-Code gates (Terraform)

**When to use:** validate Terraform plans before apply. Catch overly
permissive IAM, public S3 buckets, missing encryption. Evaluate the
JSON plan (\`terraform show -json plan.out\`), which holds the final
values after variables and modules are resolved.

\`\`\`rego
package terraform

import rego.v1

# Resources that will exist after apply: created, updated or replaced.
# resource_changes is flat, so it includes resources inside modules. A
# delete has no \`after\` and is left out.
changes contains rc if {
    some rc in input.resource_changes
    some action in rc.change.actions
    action in {"create", "update"}
}

# Reject S3 bucket ACLs that make the bucket public. Since version 4 of
# the AWS provider the ACL is usually its own aws_s3_bucket_acl resource.
deny contains msg if {
    some rc in changes
    rc.type in {"aws_s3_bucket", "aws_s3_bucket_acl"}
    rc.change.after.acl in {"public-read", "public-read-write", "authenticated-read"}
    msg := sprintf("%s: ACL %q makes the bucket public", [rc.address, rc.change.after.acl])
}

# Reject IAM policies with action "*" on resource "*".
#
# AWS accepts either a bare string or an array for Statement, Action
# and Resource, so each is widened to a set before the wildcard test.
# Testing the array form alone lets the most common admin policy of
# all, {"Action": "*", "Resource": "*"}, through untouched.
to_set(v) := {v} if is_string(v)

to_set(v) := {x | some x in v} if is_array(v)

statements(policy) := to_set(policy.Statement) if is_array(policy.Statement)

statements(policy) := {policy.Statement} if is_object(policy.Statement)

deny contains msg if {
    some rc in changes
    rc.type == "aws_iam_policy"
    policy := json.unmarshal(rc.change.after.policy)
    some statement in statements(policy)
    statement.Effect == "Allow"
    "*" in to_set(statement.Action)
    "*" in to_set(statement.Resource)
    msg := sprintf("IAM policy %q grants Allow * on *", [rc.address])
}

# A value Terraform computes during apply is not in the plan, so the
# rules above cannot see it. Fail rather than pass it unchecked.
deny contains msg if {
    some rc in changes
    some attribute in ["acl", "policy"]
    rc.change.after_unknown[attribute] == true
    msg := sprintf("%s: %s is only known after apply and cannot be checked", [rc.address, attribute])
}
\`\`\`

**Pitfalls:**
- \`planned_values.root_module.resources\` holds only root-module
  resources; module resources are nested under \`child_modules\`.
  \`resource_changes\` is flat and holds them all.
- \`change.actions\` is \`["create"]\`, \`["update"]\`, \`["delete"]\`,
  \`["no-op"]\`, \`["read"]\`, or for a replacement \`["delete",
  "create"]\` or \`["create", "delete"]\`. Testing for a create or an
  update in it covers all of them.
- IAM policy documents are string-or-array in several places. Match
  both, or a policy that grants everything slips through. A statement
  with \`NotAction\` grants every action except those listed.
- In CI, run \`opa exec --fail --decision\` on a rule that is defined
  only when nothing is denied (\`ok if count(deny) == 0\`).
  \`--fail-defined\` and \`--fail-non-empty\` on \`deny\` pass a
  misspelled decision name.

---

## 5. API authorization (HTTP request gating)

**When to use:** at the API gateway / reverse proxy layer, validate
each request against the caller's identity and the requested
endpoint.

\`\`\`rego
package api.authz

import rego.v1

default allow := false

# Public endpoints -- no auth required.
public_endpoints := {
    {"method": "GET", "path": ["health"]},
    {"method": "GET", "path": ["version"]},
}

allow if {
    some endpoint in public_endpoints
    matches_endpoint(endpoint)
}

# Authenticated reads on resources the user has access to.
allow if {
    input.method == "GET"
    input.user
    user_can_read(input.user, input.path)
}

# Authenticated writes only with specific scopes.
allow if {
    input.method in {"POST", "PUT", "PATCH", "DELETE"}
    input.user
    "write" in input.user.scopes
    user_can_write(input.user, input.path)
}

matches_endpoint(spec) if {
    spec.method == input.method
    spec.path == input.path
}

user_can_read(user, path) if {
    path[0] == "users"
    user.id == path[1]
}

user_can_write(user, path) if {
    path[0] == "users"
    user.id == path[1]
}
\`\`\`

**Pitfalls:**
- \`input.path\` is typically an array (\`["users", "alice"]\`), not a
  string. Build it consistently at the gateway.
- Path-prefix matching is easy; full pattern matching is not. For
  parameterized routes, decode at the gateway and pass structured
  fields.
- Matching a raw path string by prefix lets \`/public/../admin\`,
  \`/public/%2e%2e/admin\` and \`//admin\` through. Decode once, split
  into segments, and reject empty, \`.\` and \`..\` segments and any that
  still contain \`%\`.

---

## 6. Rate limiting (with sliding window data)

**When to use:** allow N requests per principal per window. Lightweight
limit enforcement; for high throughput, push to a dedicated rate
limiter.

\`\`\`rego
package rate

import rego.v1

# Configuration: 100 requests per principal per 60-second window.
limit := 100
window_seconds := 60

# input.now is a unix timestamp in nanoseconds.
# data.requests[principal] is an array of nanosecond timestamps.

current_window := requests if {
    requests := [t | some t in data.requests[input.principal]; t > input.now - window_seconds * 1000000000]
}

# Do not name this rule \`count\`: it would shadow the built-in of the same
# name, and the call below would resolve to the rule instead.
request_count := count(current_window)

allow if request_count < limit

deny_reason := sprintf(
    "rate limit exceeded: %d requests in last %d seconds (limit %d)",
    [request_count, window_seconds, limit],
) if not allow
\`\`\`

**Pitfalls:**
- \`data.requests\` grows unbounded unless the writer prunes outside the
  window. Schedule prune on every write.
- This pattern is *advisory* -- under load, two concurrent decisions
  can both see \`count == limit - 1\` and both allow. For strict
  limits, use a Lua/Redis token bucket at the gateway and have OPA
  validate the token, not count requests.

---

## Where these patterns came from

Each is distilled from production policy code, and this server's
integration tests evaluate every pattern against OPA.

For more patterns, see:

- OPA Playground: https://play.openpolicyagent.org/
- Awesome OPA: https://github.com/anderseknert/awesome-opa
`;
