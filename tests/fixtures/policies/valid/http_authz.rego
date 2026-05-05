# HTTP authorization policy. Allows GET to anyone, restricts mutations to
# authenticated users on resources they own.
package http.authz

import rego.v1

default allow := false

allow if input.method == "GET"

allow if {
	input.method in {"POST", "PUT", "PATCH", "DELETE"}
	input.user != null
	input.user.id == input.resource.owner_id
}

reason := "anonymous mutation" if {
	not allow
	input.method != "GET"
	input.user == null
}

reason := sprintf(
	"user %q is not the owner of resource %q",
	[input.user.id, input.resource.id],
) if {
	not allow
	input.method != "GET"
	input.user != null
	input.user.id != input.resource.owner_id
}
