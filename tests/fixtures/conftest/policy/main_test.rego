package main_test

import data.main
import rego.v1

# Test: root-user container is denied.
test_deny_root_user if {
	failures := main.deny with input as {
		"spec": {"containers": [{"name": "app", "image": "nginx:1.25.3", "securityContext": {"runAsUser": 0}}]},
	}
	count(failures) == 1
}

# Test: non-root user passes (no deny).
test_allow_nonroot_user if {
	failures := main.deny with input as {
		"spec": {"containers": [{"name": "app", "image": "nginx:1.25.3", "securityContext": {"runAsUser": 1000}}]},
	}
	count(failures) == 0
}

# Test: latest tag is denied.
test_deny_latest_tag if {
	failures := main.deny with input as {
		"spec": {"containers": [{"name": "app", "image": "nginx:latest", "securityContext": {"runAsUser": 1000}}]},
	}
	count(failures) == 1
}

# Test: pinned tag passes.
test_allow_pinned_tag if {
	failures := main.deny with input as {
		"spec": {"containers": [{"name": "app", "image": "nginx:1.25.3", "securityContext": {"runAsUser": 1000}}]},
	}
	count(failures) == 0
}

# Test: missing resource limits produces a warning.
test_warn_no_limits if {
	warnings := main.warn with input as {
		"spec": {"containers": [{"name": "app", "image": "nginx:1.25.3", "securityContext": {"runAsUser": 1000}}]},
	}
	count(warnings) == 1
}
