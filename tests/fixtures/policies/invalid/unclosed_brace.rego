# missing closing brace — should produce a parse error
package broken.unclosed_brace

import rego.v1

allow if {
	input.user == "admin"
