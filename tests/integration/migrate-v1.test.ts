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

// Cases an independent review found, each reproduced on OPA 1.21 before the fix.
describe('rego_migrate_v1 edge cases', () => {
  const lines = (...l: string[]) => [...l, ''].join('\n');

  it('rewrites a `with` that mocks a removed built-in, so the mock still applies', async () => {
    const source = lines(
      'package mocks',
      '',
      'r {',
      '\tre_match("^z", input.s)',
      '}',
      '',
      'r2 {',
      '\tr with re_match as mock',
      '}',
      '',
      'mock(a, b) = true',
    );
    const env = await migrate({ source, inputs: [{ s: 'abc' }, { s: 'zed' }] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.migrated).toContain('with regex.match as mock');
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  it('keeps a call through an import of the same name off the built-in, and aliases the import', async () => {
    const source = lines(
      'package imports',
      '',
      'import data.lib.re_match',
      '',
      'r {',
      '\tre_match("a", input.s)',
      '}',
    );
    const env = await migrate({ source });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.migrated).toContain('import data.lib.re_match as re_match_');
    expect(env.data?.migrated).toContain('re_match_("a", input.s)');
    expect(env.data?.migrated).not.toContain('regex.match');
  });

  it('leaves future.keywords imports alone, as a late v0 policy has them', async () => {
    const source = lines(
      'package fut',
      '',
      'import future.keywords.in',
      'import future.keywords.if',
      'import future.keywords.contains',
      '',
      'allow if {',
      '\t"a" in input.xs',
      '}',
      '',
      'deny contains msg if {',
      '\tnot allow',
      '\tmsg := "no a"',
      '}',
    );
    const env = await migrate({ source, inputs: [{ xs: ['a'] }, { xs: ['b'] }] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  it('renames a rule named through an escaped key', async () => {
    const source = lines(
      'package esc',
      '',
      'contains[x] {',
      '\tx := 1',
      '}',
      '',
      'p = data.esc["con\\u0074ains"]',
    );
    const env = await migrate({ source, inputs: [{}] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  it('aliases an import written with a bracketed keyword', async () => {
    const source = lines('package br', '', 'import input["in"]', '', 'r {', '\tin.x', '}');
    const env = await migrate({ source, inputs: [{ in: { x: 1 } }] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.migrated).toContain('as in_');
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  it('compares rules one by one when a conflict fails the whole package on both sides', async () => {
    const source = lines(
      'package conflicted',
      '',
      'v = input.a {',
      '\tinput.a',
      '}',
      '',
      'v = input.b {',
      '\tinput.b',
      '}',
      '',
      'w {',
      '\tall([input.flag])',
      '}',
    );
    const env = await migrate({ source, inputs: [{ a: 1, b: 2, flag: true }, { a: 1 }] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.equivalence).toEqual({ compared: 2, identical: true, differences: [] });
    expect(env.data?.notes.join(' ')).not.toMatch(/compared as a whole package/);
  });

  it('writes the helpers with `if` in a module that already imports rego.v1', async () => {
    // Half-migrated: the rego.v1 import forbids all(), so the original does not
    // compile anywhere, and the comparison says so rather than claiming a match.
    const source = lines('package half', '', 'import rego.v1', '', 'ok if all(input.xs)');
    const env = await migrate({ source, inputs: [{ xs: [true] }] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid, JSON.stringify(env.data?.errors)).toBe(true);
    expect(env.data?.migrated).toMatch(/^all_true\(xs\) := r if \{/m);
    const diff = env.data?.equivalence?.differences[0];
    expect(env.data?.equivalence?.identical).toBe(false);
    expect(diff?.rule).toBe('ok');
    expect(diff?.original).toEqual({
      error: expect.stringMatching(/deprecated built-in/) as unknown,
    });
    expect(diff?.migrated).toEqual({ value: true, type: 'boolean' });
  });

  it('keeps going past the copies OPA makes for a chained body', async () => {
    const source = lines(
      'package chained',
      '',
      'f(in) = 1 {',
      '\tin > 1',
      '} {',
      '\tin < -1',
      '}',
      '',
      'r {',
      '\tf(input.n) == 1',
      '\tre_match("^a", input.s)',
      '}',
    );
    const env = await migrate({
      source,
      inputs: [
        { n: 5, s: 'abc' },
        { n: -5, s: 'abc' },
        { n: 0, s: 'abc' },
        { n: 5, s: 'x' },
      ],
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.migrated).toContain('regex.match');
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  it('keeps a backtick-quoted key a string when the rule it names is renamed', async () => {
    const source = lines('package r', '', 'in = 1', '', 'p = data.r[`in`]');
    const env = await migrate({ source, inputs: [{}] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid, JSON.stringify(env.data?.errors)).toBe(true);
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  it('renames a local declared with `some contains`', async () => {
    const source = lines(
      'package some_contains',
      '',
      'r {',
      '\tsome contains',
      '\tinput.xs[contains] == "a"',
      '}',
    );
    const env = await migrate({ source, inputs: [{ xs: ['b', 'a'] }, { xs: ['b'] }] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  it('aliases an import whose path ends in a keyword, and follows it through the body', async () => {
    const source = lines('package imp', '', 'import input.in', '', 'r {', '\tin.x', '}');
    const env = await migrate({ source, inputs: [{ in: { x: 1 } }, { in: {} }] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.migrated).toContain('import input.in as in_');
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  it('says it had nothing to compare for a source already in v1', async () => {
    const env = await migrate({ source: 'package ok\n\nallow if input.x\n', inputs: [{}] });
    expect(env.data?.notes[0]).toMatch(/nothing to compare `inputs` against/);
  });
});
