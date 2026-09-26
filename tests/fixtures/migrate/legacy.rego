package legacy.admission

default allow = false

approved_registries = ["registry.example.com", "ghcr.io"]

# array membership, written before `in` existed
contains(arr, elem) {
	arr[_] = elem
}

deny[msg] {
	image := input.images[_]
	not contains(approved_registries, split(image, "/")[0])
	msg = sprintf("untrusted registry: %v", [image])
}

deny[msg] {
	image := input.images[_]
	re_match(`:latest$`, image)
	msg = sprintf("latest tag: %v", [image])
}

# a container without runAsNonRoot drops out of the comprehension
all_non_root {
	all([c.runAsNonRoot | c := input.containers[_]])
}

any_privileged {
	any([c.privileged | c := input.containers[_]])
}

extra_ports = set_diff(cast_set(input.ports), {80, 443})

internal {
	net.cidr_overlap("10.0.0.0/8", input.ip)
}

self_reference {
	data.legacy.admission.contains(["a"], "a")
}

busy {
	in := count(input.containers)
	in > 1
}

label = l {
	l := "café"; re_match(`^caf`, l)
}

allow {
	count(deny) == 0
}
