/**
 * Integration tests for rego_verify -- exercises the full pipeline
 * against the real OPA binary and real Z3 WASM.
 *
 * Each test calls the MCP tool through the same callTool helper used
 * by all other integration tests so the full envelope serialization
 * path is covered.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../src/config.js';
import { registerRegoVerify } from '../../src/tools/helpers/verify.js';
import type { VerifyResult } from '../../src/lib/rego-verify-engine.js';
import { callTool } from '../unit/tools/_helpers.js';

const makeServer = () => new McpServer({ name: 'test-server', version: '0.0.0' });

const config: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: process.env['OPA_BINARY'] ?? 'opa',
  regalBinary: process.env['REGAL_BINARY'] ?? 'regal',
  conftestBinary: process.env['CONFTEST_BINARY'] ?? 'conftest',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-opa-mcp-verify-it.log'),
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeVerifyServer() {
  const server = makeServer();
  registerRegoVerify(server, config);
  return server;
}

async function verify(
  source: string,
  rule: string,
  kind: string,
): Promise<VerifyResult | undefined> {
  const server = makeVerifyServer();
  const envelope = await callTool<VerifyResult>(server, 'rego_verify', { source, rule, kind });
  if (!envelope.ok) {
    throw new Error(`Tool error: ${JSON.stringify(envelope.error)}`);
  }
  return envelope.data;
}

// ─── Policies ────────────────────────────────────────────────────────────────

const roleAdminPolicy = `
package authz
allow {
  input.user.role == "admin"
}
`;

const tautologyPolicy = `
package authz
allow {
  1 == 1
}
`;

const twoClausePolicy = `
package authz
allow {
  input.user.role == "admin"
}
allow {
  input.user.role == "editor"
  input.action == "read"
}
`;

const intPolicy = `
package authz
allow {
  input.user.age >= 18
  input.user.age <= 120
}
`;

const nafPolicy = `
package authz
allow {
  not input.blocked
}
`;

const regexPolicy = `
package authz
allow {
  regex.match("^admin.*", input.user.name)
}
`;

const startsWithPolicy = `
package authz
allow {
  startswith(input.path, "/api/v2/")
}
`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('rego_verify - always_true', () => {
  it('finds counterexample when rule is not always true', async () => {
    const result = await verify(roleAdminPolicy, 'allow', 'always_true');
    expect(result?.verdict).toBe('counterexample');
    expect(result?.counterexample).toBeDefined();
    // Counterexample must have user.role (the path that matters)
    expect((result?.counterexample as Record<string, unknown>)?.['user']).toBeDefined();
  });

  it('proves always_true for tautology (1 == 1)', async () => {
    const result = await verify(tautologyPolicy, 'allow', 'always_true');
    expect(result?.verdict).toBe('proven');
    expect(result?.counterexample).toBeUndefined();
  });

  it('finds counterexample for two-clause rule (not all inputs covered)', async () => {
    const result = await verify(twoClausePolicy, 'allow', 'always_true');
    expect(result?.verdict).toBe('counterexample');
  });
});

describe('rego_verify - satisfiable', () => {
  it('finds a satisfying witness for role==admin rule', async () => {
    const result = await verify(roleAdminPolicy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    // Should return a witness (the counterexample field holds the witness)
    expect(result?.counterexample).toBeDefined();
    const ce = result?.counterexample as Record<string, unknown>;
    const user = ce['user'] as Record<string, unknown>;
    expect(user?.['role']).toBe('admin');
  });

  it('finds a witness for integer range rule', async () => {
    const result = await verify(intPolicy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    const user = ce['user'] as Record<string, unknown>;
    const age = user?.['age'] as number;
    expect(typeof age).toBe('number');
    expect(age).toBeGreaterThanOrEqual(18);
    expect(age).toBeLessThanOrEqual(120);
  });

  it('finds a witness for startswith rule', async () => {
    const result = await verify(startsWithPolicy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    const path = ce['path'] as string;
    expect(typeof path).toBe('string');
    // Z3 should return a path starting with /api/v2/
    expect(path.startsWith('/api/v2/')).toBe(true);
  });

  it('returns unsatisfiable verdict for a rule that can never fire (contradictory conditions)', async () => {
    // input.role must equal both "admin" AND "editor" simultaneously -- impossible
    const policy = `
package authz
allow {
  input.role == "admin"
  input.role == "editor"
}
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('unsatisfiable');
    expect(result?.counterexample).toBeUndefined();
  });

  it('returns unsatisfiable verdict for impossible integer constraint', async () => {
    // age must be both >= 100 AND <= 50 simultaneously -- impossible
    const policy = `
package authz
allow {
  input.age >= 100
  input.age <= 50
}
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('unsatisfiable');
  });
});

describe('rego_verify - never_true', () => {
  it('finds counterexample when rule CAN fire', async () => {
    const result = await verify(roleAdminPolicy, 'allow', 'never_true');
    expect(result?.verdict).toBe('counterexample');
    // Should show the input that makes allow=true (admin)
    const ce = result?.counterexample as Record<string, unknown>;
    const user = ce['user'] as Record<string, unknown>;
    expect(user?.['role']).toBe('admin');
  });
});

describe('rego_verify - NAF (inconclusive)', () => {
  it('returns inconclusive for negation-as-failure', async () => {
    const result = await verify(nafPolicy, 'allow', 'always_true');
    expect(result?.verdict).toBe('inconclusive');
  });
});

describe('rego_verify - unsupported construct attribution', () => {
  it('verifying a clean allow rule in a module with a NAF deny rule does not report NAF as unsupported', async () => {
    // deny uses NAF, allow does not. Verifying allow should not attribute deny's NAF to allow.
    const policy = `
package authz
allow {
  input.user.role == "admin"
}
deny {
  not input.user.active
}
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    // unsupportedConstructs for the allow rule should be empty -- NAF is from deny, not allow
    expect(result?.unsupportedConstructs).toHaveLength(0);
  });

  it('verifying a rule WITH NAF does report NAF as unsupported', async () => {
    const policy = `
package authz
allow {
  input.user.role == "admin"
}
allow {
  not input.blocked
}
`;
    const result = await verify(policy, 'allow', 'always_true');
    // Second allow clause has NAF -> inconclusive, and NAF IS reported
    expect(result?.verdict).toBe('inconclusive');
    expect(result?.unsupportedConstructs.some((u) => u.constructType === 'naf')).toBe(true);
  });

  it('two completely separate rules - unsupported from rule B never bleeds into rule A results', async () => {
    const policy = `
package authz
allow {
  input.role == "admin"
}
other_rule {
  not input.blocked
  input.role == "guest"
}
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    // allow has no unsupported constructs of its own
    expect(result?.unsupportedConstructs).toHaveLength(0);
  });
});

describe('rego_verify - regex.match', () => {
  it('can verify regex-based rules (simple prefix pattern)', async () => {
    const result = await verify(regexPolicy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    const user = ce['user'] as Record<string, unknown>;
    expect(typeof user?.['name']).toBe('string');
    expect((user?.['name'] as string).startsWith('admin')).toBe(true);
  });

  it('returns inconclusive for complex character-class pattern ([a-z]+)', async () => {
    const policy = `
package authz
allow { regex.match("[a-z]+", input.user.name) }
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('inconclusive');
    expect(result?.unsupportedConstructs.some((u) => u.constructType === 'complex_regex')).toBe(
      true,
    );
  });

  it('returns inconclusive for digit-quantifier pattern (\\d+)', async () => {
    const policy = `
package authz
allow { regex.match("\\\\d+", input.code) }
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('inconclusive');
    expect(result?.unsupportedConstructs.some((u) => u.constructType === 'complex_regex')).toBe(
      true,
    );
  });

  it('returns inconclusive for alternation pattern (admin|guest)', async () => {
    const policy = `
package authz
allow { regex.match("admin|guest", input.role) }
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('inconclusive');
    expect(result?.unsupportedConstructs.some((u) => u.constructType === 'complex_regex')).toBe(
      true,
    );
  });

  it('always_true: regex.match(".*", input.x) is tautological - proven', async () => {
    const policy = `
package authz
allow { regex.match(".*", input.x) }
`;
    const result = await verify(policy, 'allow', 'always_true');
    expect(result?.verdict).toBe('proven');
  });

  it('always_true: regex.match("^.*$", input.x) is tautological - proven', async () => {
    const policy = `
package authz
allow { regex.match("^.*$", input.x) }
`;
    const result = await verify(policy, 'allow', 'always_true');
    expect(result?.verdict).toBe('proven');
  });

  it('always_true: regex.match("^.*", input.x) is tautological - proven', async () => {
    const policy = `
package authz
allow { regex.match("^.*", input.x) }
`;
    const result = await verify(policy, 'allow', 'always_true');
    expect(result?.verdict).toBe('proven');
  });

  it('always_true: regex.match(".*$", input.x) is tautological - proven', async () => {
    const policy = `
package authz
allow { regex.match(".*$", input.x) }
`;
    const result = await verify(policy, 'allow', 'always_true');
    expect(result?.verdict).toBe('proven');
  });

  it('always_true: regex.match("^admin.*", input.x) is NOT tautological - counterexample', async () => {
    const policy = `
package authz
allow { regex.match("^admin.*", input.x) }
`;
    const result = await verify(policy, 'allow', 'always_true');
    // "foo" does not start with "admin" -- counterexample exists
    expect(result?.verdict).toBe('counterexample');
  });
});

describe('rego_verify - default-only rule', () => {
  it('always_true: default=false → counterexample (rule is never true)', async () => {
    const policy = `
package authz
default allow = false
`;
    const result = await verify(policy, 'allow', 'always_true');
    expect(result?.verdict).toBe('counterexample');
  });

  it('always_true: default=true → proven (rule is always true)', async () => {
    const policy = `
package authz
default allow = true
`;
    const result = await verify(policy, 'allow', 'always_true');
    expect(result?.verdict).toBe('proven');
  });

  it('never_true: default=false → proven (rule is never true)', async () => {
    const policy = `
package authz
default allow = false
`;
    const result = await verify(policy, 'allow', 'never_true');
    expect(result?.verdict).toBe('proven');
  });

  it('never_true: default=true → counterexample (rule fires on every input)', async () => {
    const policy = `
package authz
default allow = true
`;
    const result = await verify(policy, 'allow', 'never_true');
    expect(result?.verdict).toBe('counterexample');
  });

  it('satisfiable: default=false → unsatisfiable (no input makes it true)', async () => {
    const policy = `
package authz
default allow = false
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('unsatisfiable');
  });

  it('satisfiable: default=true → proven with empty witness', async () => {
    const policy = `
package authz
default allow = true
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    expect(result?.counterexample).toBeDefined();
  });
});

describe('rego_verify - missing rule', () => {
  it('returns inconclusive for a rule name that does not exist', async () => {
    const result = await verify(roleAdminPolicy, 'nonexistent', 'always_true');
    expect(result?.verdict).toBe('inconclusive');
  });
});

describe('rego_verify - error handling', () => {
  it('returns INVALID_REGO for malformed Rego source', async () => {
    const server = makeVerifyServer();
    const envelope = await callTool<VerifyResult>(server, 'rego_verify', {
      source: 'this is not valid rego !!!',
      rule: 'allow',
      kind: 'always_true',
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('INVALID_REGO');
  });

  it('returns INVALID_INPUT for an unknown property kind', async () => {
    const server = makeVerifyServer();
    const envelope = await callTool<VerifyResult>(server, 'rego_verify', {
      source: roleAdminPolicy,
      rule: 'allow',
      kind: 'nonsense_kind',
    });
    // Zod schema validation happens before property parser, so either INVALID_INPUT or envelope error
    expect(envelope.ok).toBe(false);
  });

  it('returns INVALID_INPUT for empty rule name', async () => {
    const server = makeVerifyServer();
    const envelope = await callTool<VerifyResult>(server, 'rego_verify', {
      source: roleAdminPolicy,
      rule: '',
      kind: 'always_true',
    });
    expect(envelope.ok).toBe(false);
  });
});

describe('rego_verify - local variable assignment', () => {
  it('handles x := input.role; x == "admin" (string assign)', async () => {
    const policy = `
package authz
allow {
  x := input.role
  x == "admin"
}
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    expect(ce?.['role']).toBe('admin');
  });

  it('handles age := input.user.age; age >= 21 (int assign propagates sort)', async () => {
    const policy = `
package authz
allow {
  age := input.user.age
  age >= 21
  age <= 100
}
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    const user = ce['user'] as Record<string, unknown>;
    const age = user?.['age'] as number;
    expect(typeof age).toBe('number');
    expect(age).toBeGreaterThanOrEqual(21);
    expect(age).toBeLessThanOrEqual(100);
  });

  it('handles two-level chain: y := input.user.age; x := y; x >= 21 (transitive sort propagation)', async () => {
    const policy = `
package authz
allow {
  y := input.user.age
  x := y
  x >= 21
  x <= 100
}
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    const user = ce['user'] as Record<string, unknown>;
    const age = user?.['age'] as number;
    expect(typeof age).toBe('number');
    expect(age).toBeGreaterThanOrEqual(21);
    expect(age).toBeLessThanOrEqual(100);
  });
});

describe('rego_verify - multi-expression helper rule inlining', () => {
  it('satisfiable: two-condition helper - witness satisfies both conditions', async () => {
    const policy = `
package authz
is_admin {
  input.user.role == "admin"
  input.user.active == true
}
allow { is_admin }
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    const user = ce['user'] as Record<string, unknown>;
    expect(user?.['role']).toBe('admin');
    expect(user?.['active']).toBe(true);
  });

  it('satisfiable: three-condition helper - witness satisfies all three', async () => {
    const policy = `
package authz
is_eligible {
  input.age >= 18
  input.age <= 65
  input.active == true
}
allow { is_eligible }
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    const age = ce['age'] as number;
    expect(typeof age).toBe('number');
    expect(age).toBeGreaterThanOrEqual(18);
    expect(age).toBeLessThanOrEqual(65);
    expect(ce['active']).toBe(true);
  });

  it('satisfiable: multi-expr helper plus extra condition in allow - all must hold', async () => {
    const policy = `
package authz
is_admin {
  input.role == "admin"
  input.active == true
}
allow {
  is_admin
  input.region == "us"
}
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    expect(ce['role']).toBe('admin');
    expect(ce['active']).toBe(true);
    expect(ce['region']).toBe('us');
  });

  it('always_true: multi-expr helper finds counterexample correctly', async () => {
    const policy = `
package authz
is_admin {
  input.user.role == "admin"
  input.user.active == true
}
allow { is_admin }
`;
    const result = await verify(policy, 'allow', 'always_true');
    // Not always true -- counterexample where role != "admin" or active != true
    expect(result?.verdict).toBe('counterexample');
    expect(result?.counterexample).toBeDefined();
  });

  it('satisfiable: nested helper inlining with multi-expr at each level', async () => {
    const policy = `
package authz
is_active {
  input.active == true
  input.enabled == true
}
is_admin_active {
  is_active
  input.role == "admin"
}
allow { is_admin_active }
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    expect(ce['active']).toBe(true);
    expect(ce['enabled']).toBe(true);
    expect(ce['role']).toBe('admin');
  });

  it('satisfiable: string built-in inside multi-expr helper', async () => {
    const policy = `
package authz
is_api_admin {
  startswith(input.path, "/api/")
  input.role == "admin"
}
allow { is_api_admin }
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    expect(typeof ce['path']).toBe('string');
    expect((ce['path'] as string).startsWith('/api/')).toBe(true);
    expect(ce['role']).toBe('admin');
  });

  it('satisfiable: int range in multi-expr helper returns valid witness', async () => {
    const policy = `
package authz
is_valid_age {
  input.user.age >= 21
  input.user.age <= 99
}
allow { is_valid_age }
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    const ce = result?.counterexample as Record<string, unknown>;
    const user = ce['user'] as Record<string, unknown>;
    const age = user?.['age'] as number;
    expect(typeof age).toBe('number');
    expect(age).toBeGreaterThanOrEqual(21);
    expect(age).toBeLessThanOrEqual(99);
  });

  it('inconclusive: NAF inside multi-expr helper makes clause unsupported', async () => {
    const policy = `
package authz
is_unblocked_admin {
  not input.blocked
  input.role == "admin"
}
allow { is_unblocked_admin }
`;
    const result = await verify(policy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('inconclusive');
  });
});

describe('rego_verify - multi-clause OR correctness', () => {
  it('proves always_true for a rule that covers all inputs via two clauses', async () => {
    // allow is true when role==admin OR when NOT role==admin (covers everything)
    // This can't be written easily in Rego without NAF, but we can test the OR encoder
    // directly with a policy that encodes both branches
    const exhaustivePolicy = `
package authz
allow {
  input.flag == true
}
allow {
  input.flag == false
}
`;
    const result = await verify(exhaustivePolicy, 'allow', 'always_true');
    expect(result?.verdict).toBe('proven');
  });
});

describe('rego_verify - cross-call Z3 sort isolation', () => {
  it('same input path inferred as string in call 1 and int in call 2 - both succeed', async () => {
    // input.value == "hello" → inferred as string
    const stringPolicy = `
package authz
allow { input.value == "hello" }
`;
    // input.value >= 10 → inferred as int
    const intPolicy = `
package authz
allow { input.value >= 10 }
`;
    // Run both sequentially - without namespacing, the second call would crash with a Z3 sort conflict
    const r1 = await verify(stringPolicy, 'allow', 'satisfiable');
    const r2 = await verify(intPolicy, 'allow', 'satisfiable');
    expect(r1?.verdict).toBe('proven');
    expect(r2?.verdict).toBe('proven');
    // Witness from call 1 should be a string
    const ce1 = r1?.counterexample as Record<string, unknown>;
    expect(typeof ce1['value']).toBe('string');
    // Witness from call 2 should be a number >= 10
    const ce2 = r2?.counterexample as Record<string, unknown>;
    expect(typeof ce2['value']).toBe('number');
    expect(ce2['value'] as number).toBeGreaterThanOrEqual(10);
  });

  it('same input path inferred as bool in call 1 and string in call 2 - both succeed', async () => {
    const boolPolicy = `
package authz
allow { input.flag == true }
`;
    const strPolicy = `
package authz
allow { input.flag == "yes" }
`;
    const r1 = await verify(boolPolicy, 'allow', 'satisfiable');
    const r2 = await verify(strPolicy, 'allow', 'satisfiable');
    expect(r1?.verdict).toBe('proven');
    expect(r2?.verdict).toBe('proven');
  });

  it('three sequential calls with conflicting sorts on input.x all return correct results', async () => {
    const p1 = `package authz\nallow { input.x == "str" }`;
    const p2 = `package authz\nallow { input.x >= 0 }`;
    const p3 = `package authz\nallow { input.x == true }`;

    const [r1, r2, r3] = await Promise.all([
      verify(p1, 'allow', 'satisfiable'),
      verify(p2, 'allow', 'satisfiable'),
      verify(p3, 'allow', 'satisfiable'),
    ]);

    expect(r1?.verdict).toBe('proven');
    expect(r2?.verdict).toBe('proven');
    expect(r3?.verdict).toBe('proven');
  });
});
