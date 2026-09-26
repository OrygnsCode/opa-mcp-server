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
      rules: [
        'all_non_root',
        'allow',
        'any_privileged',
        'approved_registries',
        'busy',
        'deny',
        'extra_ports',
        'internal',
        'label',
        'self_reference',
      ],
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
    expect(env.data?.equivalence).toMatchObject({ compared: 3, identical: true, differences: [] });
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
    expect(env.data?.equivalence).toMatchObject({ compared: 2, identical: true, differences: [] });
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
    // Nothing calls regex.match, so no note says a call was replaced by it.
    expect(env.data?.notes.join(' ')).not.toMatch(/with `regex.match`/);
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

  it.each(['import input["in"]', 'import input[`in`]'])(
    'aliases an import written with a bracketed keyword: %s',
    async (importLine) => {
      const source = lines('package br', '', importLine, '', 'r {', '\tin.x', '}');
      const env = await migrate({ source, inputs: [{ in: { x: 1 } }] });
      expect(env.ok, JSON.stringify(env.error)).toBe(true);
      expect(env.data?.migrated).toContain('as in_');
      expect(env.data?.equivalence?.identical).toBe(true);
    },
  );

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
    expect(env.data?.equivalence).toMatchObject({ compared: 2, identical: true, differences: [] });
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

  it('keeps each mock on the calls it reached when a module calls both re_match and regex.match', async () => {
    // In v0 a `with` on one name never reached calls made under the other. A
    // plain rename would make the two mocks identical and drop a violation.
    const source = lines(
      'package images',
      '',
      'approved(img) {',
      '\tre_match(`^registry[.]corp/`, img)',
      '}',
      '',
      'tag_ok(img) {',
      '\tregex.match(`:v[0-9]+$`, img)',
      '}',
      '',
      'deny[msg] {',
      '\timg := input.images[_]',
      '\tnot approved(img)',
      '\tmsg := sprintf("%s: not from registry.corp", [img])',
      '}',
      '',
      'deny[msg] {',
      '\timg := input.images[_]',
      '\tnot tag_ok(img)',
      '\tmsg := sprintf("%s: tag must be a version", [img])',
      '}',
      '',
      'registry_only = d {',
      '\td := deny with regex.match as true',
      '}',
      '',
      'tags_only = d {',
      '\td := deny with re_match as true',
      '}',
    );
    const inputs = [
      { images: ['docker.io/x:latest'] },
      { images: ['registry.corp/a:v1'] },
      { images: ['registry.corp/a:latest', 'ghcr.io/b:v2'] },
    ];
    const env = await migrate({ source, inputs });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid, JSON.stringify(env.data?.errors)).toBe(true);
    expect(env.data?.migrated).toContain('re_match_(`^registry[.]corp/`, img)');
    expect(env.data?.migrated).toContain('with re_match_ as true');
    expect(env.data?.migrated).toContain('with regex.match as true');
    expect(env.data?.equivalence).toMatchObject({ identical: true, differences: [] });
    const notes = env.data?.notes.join('\n') ?? '';
    expect(notes).toMatch(/without calling `regex.match`/);
    expect(notes).toMatch(/no longer reaches calls to `re_match` in other modules/);
    expect(notes).not.toMatch(/Replaced `re_match` with `regex.match`/);
  });

  it('does the same for net.cidr_overlap and net.cidr_contains', async () => {
    const source = lines(
      'package nets',
      '',
      'dmz_ok {',
      '\tnet.cidr_overlap("10.0.0.0/8", input.ip)',
      '}',
      '',
      'corp_ok {',
      '\tnet.cidr_contains("192.168.0.0/16", input.ip)',
      '}',
      '',
      'dmz_mocked = x {',
      '\tx := dmz_ok with net.cidr_contains as true',
      '}',
      '',
      'corp_mocked = x {',
      '\tx := corp_ok with net.cidr_overlap as true',
      '}',
    );
    const inputs = [{ ip: '8.8.8.8' }, { ip: '10.1.2.3' }, { ip: '192.168.1.1' }, { ip: 'bogus' }];
    const env = await migrate({ source, inputs });
    expect(env.data?.valid, JSON.stringify(env.data?.errors)).toBe(true);
    expect(env.data?.migrated).toContain('with cidr_overlap as true');
    expect(env.data?.equivalence).toMatchObject({ identical: true, differences: [] });
  });

  it('renames a renamed rule where the module reaches it through an import of its package', async () => {
    const source = lines(
      'package policy.ingress',
      '',
      'import data.policy.ingress',
      'import data.policy as pol',
      '',
      'contains[h] {',
      '\th := input.hosts[_]',
      '\tendswith(h, ".corp")',
      '}',
      '',
      'internal_count = count(ingress.contains)',
      '',
      'via_parent = count(pol.ingress.contains)',
      '',
      'deny[msg] {',
      '\tcount(ingress.contains) == 0',
      '\tmsg := "no internal host"',
      '}',
    );
    const env = await migrate({ source, inputs: [{ hosts: ['b.com'] }, { hosts: ['a.corp'] }] });
    expect(env.data?.valid, JSON.stringify(env.data?.errors)).toBe(true);
    expect(env.data?.migrated).toContain('count(ingress.contains_)');
    expect(env.data?.migrated).toContain('count(pol.ingress.contains_)');
    expect(env.data?.equivalence).toMatchObject({ identical: true, differences: [] });
  });

  it('leaves a local that reuses the name of an import of the package alone', async () => {
    const source = lines(
      'package policy.ingress',
      '',
      'import data.policy.ingress',
      '',
      'contains[x] {',
      '\tx := input.xs[_]',
      '}',
      '',
      'allow {',
      '\tingress := input.ingress',
      '\tingress.contains == "yes"',
      '}',
      '',
      'f(ingress) = ingress.contains',
      '',
      'g = r {',
      '\tr := [v | ingress := input.list[_]; v := ingress.contains]',
      '}',
      '',
      'total = count(ingress.contains)',
    );
    const env = await migrate({
      source,
      inputs: [{ xs: ['a'], ingress: { contains: 'yes' }, list: [{ contains: 1 }] }],
      queries: ['data.policy.ingress.f({"contains": 7})'],
    });
    expect(env.data?.valid, JSON.stringify(env.data?.errors)).toBe(true);
    expect(env.data?.migrated).toContain('ingress.contains == "yes"');
    expect(env.data?.migrated).toContain('count(ingress.contains_)');
    expect(env.data?.equivalence).toMatchObject({ identical: true, differences: [] });
  });

  it('gives re_match a helper when the module names something `regex`', async () => {
    const source = lines(
      'package names',
      '',
      'name_ok(name, regex) {',
      '\tre_match(regex, name)',
      '}',
      '',
      'allow {',
      '\tname_ok(input.name, "^[a-z]+$")',
      '}',
    );
    const env = await migrate({ source, inputs: [{ name: 'abc' }, { name: 'A1' }] });
    expect(env.data?.valid, JSON.stringify(env.data?.errors)).toBe(true);
    expect(env.data?.migrated).toContain('re_match_(regex, name)');
    expect(env.data?.notes.join(' ')).toMatch(/binds the name `regex` itself/);
    expect(env.data?.equivalence).toMatchObject({ identical: true, differences: [] });
  });

  it('builds the helper on another built-in when the module mocks regex.find_n too', async () => {
    const source = lines(
      'package mocks2',
      '',
      'm(a, b) = true',
      '',
      'mn(a, b, c) = ["x"]',
      '',
      'a {',
      '\tre_match("^x", input.s)',
      '}',
      '',
      'b {',
      '\tregex.match("^x", input.s)',
      '}',
      '',
      't {',
      '\ta with regex.match as m with regex.find_n as mn',
      '}',
    );
    const env = await migrate({ source, inputs: [{ s: 'abc' }, { s: 'xyz' }] });
    expect(env.data?.valid, JSON.stringify(env.data?.errors)).toBe(true);
    expect(env.data?.migrated).toContain('regex.find_all_string_submatch_n(pattern, value, 1)');
    expect(env.data?.equivalence).toMatchObject({ identical: true, differences: [] });
  });

  it('renames an import alias v1 reserves, and its uses', async () => {
    const source = lines(
      'package aliases',
      '',
      'import input.user as in',
      '',
      'allow {',
      '\tin.name == "alice"',
      '}',
    );
    const env = await migrate({ source, inputs: [{ user: { name: 'alice' } }, { user: {} }] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid).toBe(true);
    expect(env.data?.migrated).toContain('import input.user as in_');
    expect(env.data?.migrated).toContain('in_.name == "alice"');
    expect(env.data?.notes.join(' ')).toMatch(/Renamed the import alias `in` to `in_`/);
    expect(env.data?.notes.join(' ')).not.toMatch(/local variable/);
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  it('renames an import alias that names a removed built-in, rather than calling it one', async () => {
    const source = lines(
      'package aliases2',
      '',
      'import data.aliases2.matcher as re_match',
      '',
      'matcher(p, s) {',
      '\tstartswith(s, p)',
      '}',
      '',
      'allow {',
      '\tre_match("a", input.x)',
      '}',
    );
    const env = await migrate({ source, inputs: [{ x: 'abc' }, { x: 'xyz' }] });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.valid, JSON.stringify(env.data?.errors)).toBe(true);
    expect(env.data?.migrated).toContain('as re_match_');
    expect(env.data?.migrated).toContain('re_match_("a", input.x)');
    expect(env.data?.migrated).not.toContain('regex.match');
    expect(env.data?.equivalence?.identical).toBe(true);
  });

  const functionsOnly = lines(
    'package lib.names',
    '',
    'name_ok(n) {',
    '\tre_match("^[a-z]+$", n)',
    '}',
    '',
    'label_ok(l) {',
    '\tregex.match("^[a-z]+$", l)',
    '}',
    '',
    'resource_ok(n, l) {',
    '\tname_ok(n)',
    '\tlabel_ok(l)',
    '}',
    '',
    'label_only_ok(n, l) {',
    '\tresource_ok(n, l) with re_match as allow_any',
    '}',
    '',
    'allow_any(_, _) = true',
  );
  const namesInputs = [
    { name: 'Web', label: 'BAD' },
    { name: 'web', label: 'ok' },
    { name: 'Web', label: 'ok' },
  ];

  it('says nothing was compared for a module of functions given no `queries`', async () => {
    const env = await migrate({ source: functionsOnly, inputs: namesInputs });
    expect(env.data?.equivalence?.rules).toEqual([]);
    expect(env.data?.notes.join(' ')).toMatch(
      /Nothing was compared: the functions `allow_any`, `label_ok`, `label_only_ok`, `name_ok`, `resource_ok`/,
    );
  });

  it('compares functions through `queries`', async () => {
    const queries = [
      'data.lib.names.label_only_ok(input.name, input.label)',
      'data.lib.names.resource_ok(input.name, input.label)',
      // A v1 keyword works in the query on the v0 side as well.
      '[x | some x in [input.name]; data.lib.names.name_ok(x)]',
    ];
    const env = await migrate({ source: functionsOnly, inputs: namesInputs, queries });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.equivalence).toMatchObject({ identical: true, differences: [] });
    expect(env.data?.notes.join(' ')).not.toMatch(/Nothing was compared/);
  });

  const renamedSet = lines('package q', '', 'contains[x] {', '\tx := input.xs[_]', '}');

  it('gives a renamed rule its new name in a query', async () => {
    const env = await migrate({
      source: renamedSet,
      inputs: [{ xs: [1, 2] }],
      queries: ['count(data.q.contains)', 'data.q.contains'],
    });
    expect(env.data?.equivalence).toMatchObject({ identical: true, differences: [] });
  });

  it('reports a query that differs, naming it', async () => {
    // Only the dot form is renamed, as documented, so the bracket form finds
    // the rule on the v0 side and nothing on the v1 side.
    const env = await migrate({
      source: renamedSet,
      inputs: [{ xs: [1, 2] }],
      queries: ['data.q["contains"]'],
    });
    expect(env.data?.equivalence?.identical).toBe(false);
    expect(env.data?.equivalence?.differences[0]).toMatchObject({
      input: 0,
      query: 'data.q["contains"]',
      migrated: { undefined: true },
    });
  });

  it('refuses a query that compiles on neither side', async () => {
    const env = await migrate({ source: renamedSet, inputs: [{ xs: [1] }], queries: ['1 +'] });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.message).toMatch(/`queries\[0\]` does not compile/);
  });

  it('gives both sides the same clock, and warns about other built-ins that vary', async () => {
    const source = lines(
      'package audit',
      '',
      'decision = {"allow": allow, "at": time.now_ns()}',
      '',
      'allow {',
      '\tinput.user == "admin"',
      '}',
    );
    const env = await migrate({ source, inputs: [{ user: 'admin' }, { user: 'bob' }] });
    expect(env.data?.equivalence).toMatchObject({ identical: true, differences: [] });
    expect(env.data?.notes.join(' ')).toMatch(/same time/);

    const withUuid = await migrate({
      source: lines('package audit2', '', 'request_id = uuid.rfc4122(input.path)'),
      inputs: [{ path: '/a' }],
    });
    expect(withUuid.data?.notes.join(' ')).toMatch(/`uuid.rfc4122` can return something different/);
  });

  it('says why `inputs` were not compared when the result does not check', async () => {
    const source = lines('package bad', '', 'x = y {', '\ty := 1 + "a"', '}');
    const env = await migrate({ source, inputs: [{}] });
    expect(env.data?.valid).toBe(false);
    expect(env.data?.equivalence).toBeUndefined();
    expect(env.data?.notes.join(' ')).toMatch(
      /does not pass `opa check`, so `inputs` were not compared/,
    );
  });
});
