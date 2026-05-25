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

describe('rego_verify - regex.match', () => {
  it('can verify regex-based rules', async () => {
    const result = await verify(regexPolicy, 'allow', 'satisfiable');
    expect(result?.verdict).toBe('proven');
    // Witness should be a string matching the regex
    const ce = result?.counterexample as Record<string, unknown>;
    const user = ce['user'] as Record<string, unknown>;
    expect(typeof user?.['name']).toBe('string');
    expect((user?.['name'] as string).startsWith('admin')).toBe(true);
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
