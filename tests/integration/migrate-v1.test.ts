/**
 * `rego_migrate_v1` against the real OPA binary.
 *
 * `opa fmt --v0-v1` refuses a v0 module that names a rule `contains` or calls a
 * built-in v1 removed, and those are what a real legacy policy holds. The
 * tool rewrites both before formatting; what matters is that the result then
 * loads as v1 and decides every input exactly as the original did, which only
 * a real binary can show.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerAuthoringTools } from '../../src/tools/authoring/index.js';
import type { RegoMigrateV1Output } from '../../src/tools/authoring/migrate-v1.js';
import { callTool, fixturePath, makeServer } from '../unit/tools/_helpers.js';

const config: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: process.env['OPA_BINARY'] ?? 'opa',
  regalBinary: 'regal',
  conftestBinary: 'conftest',
  subprocessTimeoutMs: 60_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-migrate-v1-test.log'),
  logLevel: 'error',
  maxResponseBytes: 1_000_000,
  maxSubprocessBytes: 32 * 1024 * 1024,
};

const migrate = (input: Record<string, unknown>) => {
  const server = makeServer();
  registerAuthoringTools(server, config);
  return callTool<RegoMigrateV1Output>(server, 'rego_migrate_v1', input);
};

const legacy = readFileSync(fixturePath('migrate', 'legacy.rego'), 'utf8');

// Each input exercises one of the rewrites.
const INPUTS = [
  // Everything approved: allow.
  {
    images: ['registry.example.com/api:1.2'],
    containers: [{ runAsNonRoot: true }],
    ports: [80],
    ip: '10.1.2.3',
  },
  // Untrusted registry and a latest tag.
  { images: ['docker.io/nginx:latest'], containers: [], ports: [80, 8080], ip: '192.168.0.1' },
  // A container without runAsNonRoot drops out of all()'s comprehension, so
  // the rule still holds; `every` would not keep that.
  {
    images: ['ghcr.io/x/y:2'],
    containers: [{ runAsNonRoot: true }, { name: 'sidecar' }],
    ports: [443, 9000],
  },
  // One privileged container out of three, and a set of ports.
  {
    images: [],
    containers: [{ privileged: false }, { privileged: true }, { runAsNonRoot: false }],
    ports: [22],
  },
  // Not an array: cast_set is undefined and so is set_diff.
  { images: [], containers: [], ports: 'none' },
];

describe('rego_migrate_v1', () => {
  it('migrates a legacy policy that opa fmt alone refuses, and it decides every input the same', async () => {
    const env = await migrate({ source: legacy, inputs: INPUTS });

    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    const out = env.data!;
    expect(out.valid, JSON.stringify(out.errors)).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.migrated).toContain('contains_(arr, elem) if {');
    expect(out.migrated).toContain('deny contains msg if {');
    expect(out.migrated).toContain('regex.match(`:latest$`, image)');
    expect(out.migrated).toContain('net.cidr_contains("10.0.0.0/8", input.ip)');
    expect(out.migrated).toMatch(/^all_true\(xs\) := r if \{/m);
    // The helpers' comments name the built-in they replace; the code must not call it.
    const code = out.migrated
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\b(re_match|all|any|cast_set|set_diff|net\.cidr_overlap)\(/);

    expect(out.equivalence, JSON.stringify(out.equivalence?.differences)).toEqual({
      compared: INPUTS.length,
      identical: true,
      differences: [],
    });
  });

  it('agrees when both versions raise the same runtime error for an input', async () => {
    // Two values for one complete rule: a conflict error on the second input.
    const source =
      'package conflict\n\nv = input.a {\n\tinput.a\n}\n\nv = input.b {\n\tinput.b\n}\n';
    const env = await migrate({ source, inputs: [{ a: 1 }, { a: 1, b: 2 }, { b: 3 }] });

    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.equivalence).toEqual({ compared: 3, identical: true, differences: [] });
  });

  it('handles rules named like Object properties', async () => {
    const source = [
      'package protos',
      '',
      'constructor(x) {',
      '\tre_match("^a", x)',
      '}',
      '',
      'toString = y {',
      '\ty := input.s',
      '\tconstructor(y)',
      '}',
      '',
    ].join('\n');
    const env = await migrate({ source, inputs: [{ s: 'abc' }, { s: 'xyz' }] });

    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.migrated).toContain('regex.match("^a", x)');
    expect(env.data?.equivalence).toEqual({ compared: 2, identical: true, differences: [] });
  });

  it('returns Rego v1 unchanged', async () => {
    const source = 'package ok\n\nallow if input.user == "admin"\n';
    const env = await migrate({ source });
    expect(env.ok).toBe(true);
    expect(env.data?.changed).toBe(false);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.notes[0]).toMatch(/already Rego v1/);
  });

  it('names the line of a syntax error in a source that is neither version', async () => {
    const env = await migrate({ source: 'package bad\n\nallow {\n\tinput.x ==\n}\n' });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_REGO');
    expect(env.error?.message).toMatch(
      /^The source parses as neither Rego v0 nor Rego v1: .+\(line \d+\)\.$/,
    );
  });
});
