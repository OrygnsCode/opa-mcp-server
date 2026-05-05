# Simple role-based access control policy.
# Used as the happy-path fixture for evaluation, formatting, and parsing tests.
package rbac

import rego.v1

default allow := false

allow if {
	some role in input.user.roles
	role_grants_action[role][input.action]
}

role_grants_action := {
	"admin": {"read", "write", "delete"},
	"editor": {"read", "write"},
	"viewer": {"read"},
}

deny_reasons contains reason if {
	not allow
	reason := sprintf(
		"user %q with roles %v cannot perform %q",
		[input.user.id, input.user.roles, input.action],
	)
}
