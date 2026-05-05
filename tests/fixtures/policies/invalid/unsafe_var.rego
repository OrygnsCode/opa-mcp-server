# references an unsafe variable `x` that is never bound — should produce a compile error
package broken.unsafe_var

import rego.v1

allow if {
	input.user == x
}
