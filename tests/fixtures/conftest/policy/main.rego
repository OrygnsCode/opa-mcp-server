package main

import rego.v1

# Deny containers that run as root (uid 0).
deny contains msg if {
	some container in input.spec.containers
	container.securityContext.runAsUser == 0
	msg := sprintf("container '%s' must not run as root (runAsUser: 0)", [container.name])
}

# Deny images that use the 'latest' tag.
deny contains msg if {
	some container in input.spec.containers
	endswith(container.image, ":latest")
	msg := sprintf("container '%s' uses image tag 'latest' -- pin to a specific digest or version tag", [container.name])
}

# Warn when no resource limits are set (not a hard failure, but a best practice).
warn contains msg if {
	some container in input.spec.containers
	not container.resources.limits
	msg := sprintf("container '%s' has no resource limits set", [container.name])
}
