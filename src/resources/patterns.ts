/**
 * Curated Rego pattern library. Each pattern includes:
 *   - When to use it
 *   - A working example
 *   - A test
 *   - Common pitfalls
 */
export const PATTERNS = `# Rego pattern library

Common Rego patterns with working examples, tests, and pitfalls. Each
pattern is self-contained — copy, adapt, and ship.

---

## 1. Role-based access control (RBAC)

**When to use:** the simplest authorization model. Every user has one
or more roles; each role grants a set of actions on a set of
resources. Sufficient for ~80% of internal applications.

\`\`\`rego
package rbac

import rego.v1

default allow := false

# Permissions table — extend as roles evolve.
permissions := {
    "admin": {"read", "write", "delete", "manage_users"},
    "editor": {"read", "write"},
    "viewer": {"read"},
}

allow if {
    some role in input.user.roles
    input.action in permissions[role]
}

# Why was it denied? — useful for audit logs.
deny_reasons contains reason if {
    not allow
    input.user
    reason := sprintf(
        "user %q has roles %v, none grant %q",
        [input.user.id, input.user.roles, input.action],
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
    "anonymous request" in (rbac.deny_reasons with input as {"action": "read"})
}
\`\`\`

**Pitfalls:**
- The \`permissions\` table grows unbounded. Move to data files
  (\`data.permissions\`) once you have more than ~20 roles.
- Roles overlap with groups in real auth systems; map at the boundary
  rather than carrying both.

---

## 2. Attribute-based access control (ABAC)

**When to use:** when "who" alone isn't enough — decisions also depend
on resource attributes (ownership, tenant, sensitivity) and context
(time of day, source IP).

\`\`\`rego
package abac

import rego.v1

default allow := false

# A user can read any resource they own.
allow if {
    input.action == "read"
    input.resource.owner_id == input.user.id
}

# A user can read shared resources at their organization.
allow if {
    input.action == "read"
    input.resource.shared
    input.resource.org_id == input.user.org_id
}

# Admins can do anything within their organization.
allow if {
    "admin" in input.user.roles
    input.resource.org_id == input.user.org_id
}

# Don't show "secret" resources to anyone outside the owner's
# organization, even admins.
allow := false if {
    input.resource.classification == "secret"
    input.resource.org_id != input.user.org_id
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
- Multiple \`allow\` rules combine with logical OR. Use explicit
  \`allow := false if ...\` to *override* an allow.
- Don't compute attributes inside the policy; compute them at the
  boundary and pass via \`input\`.

---

## 3. Kubernetes admission control

**When to use:** validate or mutate Kubernetes resources at admission
time. Run as a Gatekeeper, OPA-as-a-webhook, or Kyverno-equivalent
policy layer.

\`\`\`rego
package k8s.admission

import rego.v1

# Reject pods without resource limits.
deny contains msg if {
    input.request.kind.kind == "Pod"
    container := input.request.object.spec.containers[_]
    not container.resources.limits.memory
    msg := sprintf(
        "Pod %q container %q is missing resources.limits.memory",
        [input.request.object.metadata.name, container.name],
    )
}

# Reject privileged containers in production.
deny contains msg if {
    input.request.kind.kind == "Pod"
    input.request.namespace != "kube-system"
    container := input.request.object.spec.containers[_]
    container.securityContext.privileged == true
    msg := sprintf(
        "privileged containers are not allowed: %q in %q",
        [container.name, input.request.object.metadata.name],
    )
}
\`\`\`

**Pitfalls:**
- Use \`input.request.object\` for the resource being admitted; the
  envelope shape comes from Kubernetes, not your control.
- For mutations, return a JSON Patch via the \`patch\` field. Test
  patches with the actual admission webhook in dry-run mode before
  enforcing.
- Iteration order is undefined; never rely on \`containers[0]\` to mean
  anything specific.

---

## 4. Infrastructure-as-Code gates (Terraform)

**When to use:** validate Terraform plans before apply. Catch overly
permissive IAM, public S3 buckets, missing encryption.

\`\`\`rego
package terraform

import rego.v1

# Reject S3 buckets without server-side encryption.
deny contains msg if {
    resource := input.resource_changes[_]
    resource.type == "aws_s3_bucket"
    after := resource.change.after
    not after.server_side_encryption_configuration
    msg := sprintf(
        "S3 bucket %q has no server-side encryption configured",
        [resource.address],
    )
}

# Reject IAM policies with action "*" on resource "*".
deny contains msg if {
    resource := input.resource_changes[_]
    resource.type == "aws_iam_policy"
    policy := json.unmarshal(resource.change.after.policy)
    statement := policy.Statement[_]
    statement.Effect == "Allow"
    "*" in statement.Action
    statement.Resource == "*"
    msg := sprintf("IAM policy %q grants Allow * on *", [resource.address])
}
\`\`\`

**Pitfalls:**
- Terraform plan JSON is verbose and version-specific. Pin the
  \`terraform plan -json\` schema you target.
- \`resource_changes[_].change.after\` may be \`null\` for destroys —
  guard against it.
- For wide-radius changes, use \`opa exec --decision\` against a plan
  file in CI, not the live API.

---

## 5. API authorization (HTTP request gating)

**When to use:** at the API gateway / reverse proxy layer, validate
each request against the caller's identity and the requested
endpoint.

\`\`\`rego
package api.authz

import rego.v1

default allow := false

# Public endpoints — no auth required.
public_endpoints := {
    {"method": "GET", "path": ["health"]},
    {"method": "GET", "path": ["version"]},
}

allow if some _ in public_endpoints; matches_endpoint(_)

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

count := count(current_window)

allow if count < limit

deny_reason := sprintf(
    "rate limit exceeded: %d requests in last %d seconds (limit %d)",
    [count, window_seconds, limit],
) if not allow
\`\`\`

**Pitfalls:**
- \`data.requests\` grows unbounded unless the writer prunes outside the
  window. Schedule prune on every write.
- This pattern is *advisory* — under load, two concurrent decisions
  can both see \`count == limit - 1\` and both allow. For strict
  limits, use a Lua/Redis token bucket at the gateway and have OPA
  validate the token, not count requests.

---

## Where these patterns came from

Each is distilled from production policy code. The full Rego files,
tests, and policy data fixtures live in this server's GitHub
repository under \`tests/fixtures/policies/\`.

For more patterns, see:

- OPA Playground: https://play.openpolicyagent.org/
- Awesome OPA: https://github.com/anderseknert/awesome-opa
- Styra DAS pattern library: https://docs.styra.com/das/policies
`;
