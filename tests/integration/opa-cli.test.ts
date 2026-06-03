import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { OpaCli } from '../../src/lib/opa-cli.js';

const fixturesDir = join(__dirname, '..', 'fixtures');
const validRbacPath = join(fixturesDir, 'policies', 'valid', 'rbac.rego');
const validHttpAuthzPath = join(fixturesDir, 'policies', 'valid', 'http_authz.rego');
const invalidUnsafePath = join(fixturesDir, 'policies', 'invalid', 'unsafe_var.rego');
const rbacInputPath = join(fixturesDir, 'inputs', 'rbac.json');

const config: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: process.env['OPA_BINARY'] ?? 'opa',
  regalBinary: process.env['REGAL_BINARY'] ?? 'regal',
  conftestBinary: process.env['CONFTEST_BINARY'] ?? 'conftest',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-opa-mcp-test.log'),
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

const opa = new OpaCli(config);

let tmpWorkDir: string;

beforeAll(async () => {
  tmpWorkDir = join(tmpdir(), `orygn-opa-mcp-it-${Date.now()}`);
  await mkdir(tmpWorkDir, { recursive: true });
});

afterAll(async () => {
  if (tmpWorkDir) await rm(tmpWorkDir, { recursive: true, force: true });
});

describe('OpaCli integration', () => {
  it('version() returns a parseable semver-ish string', async () => {
    const v = await opa.version();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  describe('fmt()', () => {
    it('reformats unidiomatic source to canonical form', async () => {
      const ugly = 'package x\nallow{input.user==1}\n';
      const result = await opa.fmt({ source: ugly });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('package x');
      expect(result.stdout).not.toEqual(ugly);
    });

    it('is idempotent on already-formatted source', async () => {
      const source = await readFile(validRbacPath, 'utf8');
      const result = await opa.fmt({ source });
      expect(result.exitCode).toBe(0);
    });
  });

  describe('check()', () => {
    it('returns exitCode 0 on a valid policy file', async () => {
      const result = await opa.check({ paths: [validRbacPath] });
      expect(result.exitCode).toBe(0);
    });

    it('returns non-zero with structured JSON on stderr for an invalid policy', async () => {
      const result = await opa.check({ paths: [invalidUnsafePath] });
      expect(result.exitCode).not.toBe(0);
      // `opa check --format=json` writes errors to stderr, not stdout.
      const parsed = JSON.parse(result.stderr) as { errors?: unknown[] };
      expect(Array.isArray(parsed.errors)).toBe(true);
    });

    it('accepts inline source and reports invalid Rego on stderr', async () => {
      const result = await opa.check({ source: 'package x\nallow if y' });
      expect(result.exitCode).not.toBe(0);
      const parsed = JSON.parse(result.stderr) as { errors?: Array<{ code?: string }> };
      // `allow if y` parses as a malformed rule head — could be parse or
      // unsafe-var depending on Rego version. We just assert there's an error.
      expect((parsed.errors ?? []).length).toBeGreaterThan(0);
    });

    describe('--schema (schemaDir) flag', () => {
      it('exits 0 and produces empty stderr when all input.* references match the schema', async () => {
        const schemaFile = join(tmpWorkDir, 'schema-valid.json');
        const policyFile = join(tmpWorkDir, 'policy-schema-valid.rego');
        await writeFile(
          schemaFile,
          JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
              user: { type: 'string' },
              action: { type: 'string' },
            },
          }),
          'utf8',
        );
        await writeFile(
          policyFile,
          [
            'package authz',
            'import rego.v1',
            'default allow := false',
            'allow if { input.user == "admin"; input.action == "read" }',
          ].join('\n') + '\n',
          'utf8',
        );

        const result = await opa.check({ paths: [policyFile], schemaDir: schemaFile });
        expect(result.exitCode).toBe(0);
        expect(result.stderr.trim()).toBe('');
      });

      it('exits 1 with rego_type_error on stderr when a policy ref is not in the schema', async () => {
        const schemaFile = join(tmpWorkDir, 'schema-violation.json');
        const policyFile = join(tmpWorkDir, 'policy-schema-violation.rego');
        await writeFile(
          schemaFile,
          JSON.stringify({ type: 'object', properties: { user: { type: 'string' } } }),
          'utf8',
        );
        await writeFile(
          policyFile,
          'package authz\nimport rego.v1\nallow if input.nonexistent_field == "x"\n',
          'utf8',
        );

        const result = await opa.check({ paths: [policyFile], schemaDir: schemaFile });
        expect(result.exitCode).not.toBe(0);
        const parsed = JSON.parse(result.stderr) as {
          errors?: Array<{ code?: string; message?: string }>;
        };
        expect(Array.isArray(parsed.errors)).toBe(true);
        expect(parsed.errors!.length).toBeGreaterThan(0);
        expect(parsed.errors![0]?.code).toBe('rego_type_error');
        expect(parsed.errors![0]?.message).toContain('input.nonexistent_field');
      });

      it('reports all schema violations in a single run (not just the first)', async () => {
        const schemaFile = join(tmpWorkDir, 'schema-multi.json');
        const policyFile = join(tmpWorkDir, 'policy-schema-multi.rego');
        await writeFile(
          schemaFile,
          JSON.stringify({ type: 'object', properties: { user: { type: 'string' } } }),
          'utf8',
        );
        await writeFile(
          policyFile,
          'package authz\nimport rego.v1\nallow if { input.foo == "a"; input.bar == "b" }\n',
          'utf8',
        );

        const result = await opa.check({ paths: [policyFile], schemaDir: schemaFile });
        expect(result.exitCode).not.toBe(0);
        const parsed = JSON.parse(result.stderr) as { errors?: Array<{ code?: string }> };
        expect((parsed.errors ?? []).length).toBeGreaterThanOrEqual(2);
        for (const e of parsed.errors ?? []) {
          expect(e.code).toBe('rego_type_error');
        }
      });

      it('exits 0 for inline source when all input refs match the schema', async () => {
        const schemaFile = join(tmpWorkDir, 'schema-inline-ok.json');
        await writeFile(
          schemaFile,
          JSON.stringify({ type: 'object', properties: { role: { type: 'string' } } }),
          'utf8',
        );
        const result = await opa.check({
          source: 'package authz\nimport rego.v1\nallow if input.role == "admin"\n',
          schemaDir: schemaFile,
        });
        expect(result.exitCode).toBe(0);
      });

      it('exits non-zero for inline source when an input ref is absent from the schema', async () => {
        const schemaFile = join(tmpWorkDir, 'schema-inline-fail.json');
        await writeFile(
          schemaFile,
          JSON.stringify({ type: 'object', properties: { role: { type: 'string' } } }),
          'utf8',
        );
        const result = await opa.check({
          source: 'package authz\nimport rego.v1\nallow if input.notinschema == "x"\n',
          schemaDir: schemaFile,
        });
        expect(result.exitCode).not.toBe(0);
        const parsed = JSON.parse(result.stderr) as {
          errors?: Array<{ code?: string }>;
        };
        expect((parsed.errors ?? []).length).toBeGreaterThan(0);
        expect(parsed.errors![0]?.code).toBe('rego_type_error');
      });
    });
  });

  describe('parse()', () => {
    it('returns AST JSON for a valid policy', async () => {
      const source = await readFile(validRbacPath, 'utf8');
      const result = await opa.parse({ source });
      expect(result.exitCode).toBe(0);
      const ast = JSON.parse(result.stdout) as { package?: unknown };
      expect(ast.package).toBeDefined();
    });

    it('returns body expressions with location.text when includeLocations: true', async () => {
      const source = 'package authz\nimport rego.v1\nallow if input.role == "admin"\n';
      const result = await opa.parse({ source, includeLocations: true });
      expect(result.exitCode).toBe(0);
      const ast = JSON.parse(result.stdout) as {
        rules?: Array<{ body?: Array<{ location?: { text?: string; row?: number } }> }>;
      };
      const bodyExprs = ast.rules?.flatMap((r) => r.body ?? []) ?? [];
      expect(bodyExprs.length).toBeGreaterThan(0);
      // At least one expression must carry a non-empty base64 text field.
      const withText = bodyExprs.filter(
        (e) => typeof e.location?.text === 'string' && e.location.text.length > 0,
      );
      expect(withText.length).toBeGreaterThan(0);
      // Verify each text field decodes to a non-empty string.
      for (const expr of withText) {
        const decoded = Buffer.from(expr.location!.text!, 'base64').toString('utf8');
        expect(decoded.length).toBeGreaterThan(0);
        // The decoded text should contain the source expression.
        expect(decoded).toMatch(/input\.role/);
      }
    });

    it('does not include location.text fields when includeLocations is not set', async () => {
      const source = 'package authz\nimport rego.v1\nallow if input.role == "admin"\n';
      const result = await opa.parse({ source });
      expect(result.exitCode).toBe(0);
      const ast = JSON.parse(result.stdout) as {
        rules?: Array<{ body?: Array<{ location?: { text?: string } }> }>;
      };
      const bodyExprs = ast.rules?.flatMap((r) => r.body ?? []) ?? [];
      // Without includeLocations, expressions should not have a text field.
      const withText = bodyExprs.filter((e) => typeof e.location?.text === 'string');
      expect(withText.length).toBe(0);
    });
  });

  describe('inspect()', () => {
    it('inspects a single Rego file and reports its package', async () => {
      const result = await opa.inspect({ target: validRbacPath });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        namespaces?: Record<string, unknown>;
      };
      expect(parsed.namespaces).toBeDefined();
    });
  });

  describe('capabilities()', () => {
    it('returns the current capabilities including builtins', async () => {
      const result = await opa.capabilities({ current: true });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { builtins?: unknown[] };
      expect(Array.isArray(parsed.builtins)).toBe(true);
      expect((parsed.builtins ?? []).length).toBeGreaterThan(50);
    });
  });

  describe('deps()', () => {
    it('reports the data references used by a rule', async () => {
      const result = await opa.deps({ paths: [validRbacPath], ref: 'data.rbac.allow' });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        base?: unknown[];
        virtual?: unknown[];
      };
      expect(parsed.base ?? parsed.virtual).toBeDefined();
    });
  });

  describe('eval()', () => {
    it('evaluates a query against inline policy + inline input', async () => {
      const source = await readFile(validRbacPath, 'utf8');
      const input = JSON.parse(await readFile(rbacInputPath, 'utf8')) as unknown;
      const result = await opa.eval({
        query: 'data.rbac.allow',
        source,
        input,
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        result?: Array<{ expressions?: Array<{ value?: unknown }> }>;
      };
      const value = parsed.result?.[0]?.expressions?.[0]?.value;
      expect(value).toBe(true);
    });

    it('returns explain trace when explain is set', async () => {
      const source = await readFile(validRbacPath, 'utf8');
      const input = JSON.parse(await readFile(rbacInputPath, 'utf8')) as unknown;
      const result = await opa.eval({
        query: 'data.rbac.allow',
        source,
        input,
        explain: 'full',
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        explanation?: unknown[];
      };
      expect(Array.isArray(parsed.explanation)).toBe(true);
    });

    it('supports paths input via --input file', async () => {
      const source = await readFile(validHttpAuthzPath, 'utf8');
      const result = await opa.eval({
        query: 'data.http.authz.allow',
        source,
        inputPath: join(fixturesDir, 'inputs', 'http_authz.json'),
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        result?: Array<{ expressions?: Array<{ value?: unknown }> }>;
      };
      expect(parsed.result?.[0]?.expressions?.[0]?.value).toBe(true);
    });
  });

  describe('test()', () => {
    it('runs tests in a directory and reports pass count', async () => {
      // Write a tiny passing test file so we don't depend on fixture tests.
      const dir = join(tmpWorkDir, 'tests-dir');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'test_basic.rego'),
        'package basic_test\nimport rego.v1\ntest_truthy if 1 == 1\n',
        'utf8',
      );

      const result = await opa.test({ paths: [dir], verbose: true });
      // Exit code is 0 when all tests pass.
      expect(result.exitCode).toBe(0);
      // JSON output is one record per test (NDJSON-ish per opa).
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it('emits coverage JSON (not a test-record array) when coverage:true', async () => {
      const dir = join(tmpWorkDir, 'tests-coverage');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'policy.rego'),
        'package cov\nimport rego.v1\nallow if input.x == 1\ndeny if input.x == 0\n',
        'utf8',
      );
      await writeFile(
        join(dir, 'policy_test.rego'),
        'package cov_test\nimport rego.v1\nimport data.cov\ntest_allow if { cov.allow with input as {"x": 1} }\n',
        'utf8',
      );

      const result = await opa.test({ paths: [dir], coverage: true });
      expect(result.exitCode).toBe(0);
      // stdout must be the coverage JSON object, not a test-record array
      const parsed = JSON.parse(result.stdout) as { coverage?: number; files?: unknown };
      expect(typeof parsed.coverage).toBe('number');
      expect(parsed.files).toBeDefined();
    });

    it('exits non-zero and writes threshold message to stderr when threshold is not met', async () => {
      const dir = join(tmpWorkDir, 'tests-threshold-fail');
      await mkdir(dir, { recursive: true });
      // Policy has two rules; test only exercises one -> coverage < 100%
      await writeFile(
        join(dir, 'policy.rego'),
        'package thresh\nimport rego.v1\nallow if input.x == 1\ndeny if input.x == 0\n',
        'utf8',
      );
      await writeFile(
        join(dir, 'policy_test.rego'),
        'package thresh_test\nimport rego.v1\nimport data.thresh\ntest_allow if { thresh.allow with input as {"x": 1} }\n',
        'utf8',
      );

      // Require 100% coverage -- impossible since deny is not tested.
      const result = await opa.test({ paths: [dir], threshold: 100 });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/threshold not met|got .* instead of/i);
    });

    it('exits 0 when threshold is met', async () => {
      const dir = join(tmpWorkDir, 'tests-threshold-pass');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'policy.rego'),
        'package pass\nimport rego.v1\nallow if input.x == 1\n',
        'utf8',
      );
      await writeFile(
        join(dir, 'policy_test.rego'),
        'package pass_test\nimport rego.v1\nimport data.pass\ntest_allow if { pass.allow with input as {"x": 1} }\n',
        'utf8',
      );

      // Any threshold <= actual coverage passes.
      const result = await opa.test({ paths: [dir], threshold: 50 });
      expect(result.exitCode).toBe(0);
      // stdout is coverage JSON (threshold implies coverage mode)
      const parsed = JSON.parse(result.stdout) as { coverage?: number };
      expect(typeof parsed.coverage).toBe('number');
    });

    it('filters tests with --run when runPattern is set', async () => {
      const dir = join(tmpWorkDir, 'tests-run-filter');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'test_filter.rego'),
        [
          'package filter_test',
          'import rego.v1',
          'test_included if 1 == 1',
          'test_excluded if 2 == 2',
        ].join('\n') + '\n',
        'utf8',
      );

      // Only run the "included" test.
      const result = await opa.test({
        paths: [dir],
        runPattern: '^data.filter_test.test_included$',
      });
      expect(result.exitCode).toBe(0);
      // The array should contain only one record.
      const records = JSON.parse(result.stdout) as Array<{ name?: string }>;
      expect(records).toHaveLength(1);
      expect(records[0]?.name).toBe('test_included');
    });

    describe('--var-values flag', () => {
      it('exits 0 and returns JSON records when all tests pass with varValues: true', async () => {
        const dir = join(tmpWorkDir, 'tests-var-values-pass');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'test_varvals.rego'),
          [
            'package varvals_test',
            'import rego.v1',
            'test_simple if {',
            '  x := 1',
            '  x == 1',
            '}',
          ].join('\n') + '\n',
          'utf8',
        );

        const result = await opa.test({ paths: [dir], varValues: true, verbose: true });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.length).toBeGreaterThan(0);
        // stdout must parse as a JSON array of test records.
        const records = JSON.parse(result.stdout) as Array<{ name?: string }>;
        expect(Array.isArray(records)).toBe(true);
        expect(records.length).toBeGreaterThan(0);
      });

      it('includes trace with local variable bindings in failing test record', async () => {
        // A failing test with a local variable. With --var-values + --verbose,
        // OPA attaches a `trace` array to the failing record that includes the
        // variable binding so the caller can see what `x` was.
        const dir = join(tmpWorkDir, 'tests-var-values-fail-trace');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'test_trace.rego'),
          [
            'package trace_test',
            'import rego.v1',
            'test_failing if {',
            '  x := 42',
            '  x == 99', // deliberate failure
            '}',
          ].join('\n') + '\n',
          'utf8',
        );

        const result = await opa.test({ paths: [dir], varValues: true, verbose: true });
        // Exit non-zero: one test fails.
        expect(result.exitCode).not.toBe(0);
        // OPA still emits the JSON array with the failing record on stdout.
        expect(result.stdout.length).toBeGreaterThan(0);
        const records = JSON.parse(result.stdout) as Array<{
          name?: string;
          fail?: boolean;
          trace?: unknown[];
        }>;
        const failing = records.find((r) => r.fail === true);
        expect(failing).toBeDefined();
        // With --var-values, the failing record should carry a trace array.
        expect(Array.isArray(failing?.trace)).toBe(true);
        expect((failing?.trace ?? []).length).toBeGreaterThan(0);
      });

      it('passes without --var-values even when varValues is omitted -- trace absent', async () => {
        // Baseline: without --var-values, failing records have no trace.
        const dir = join(tmpWorkDir, 'tests-no-var-values');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'test_novarvals.rego'),
          [
            'package novarvals_test',
            'import rego.v1',
            'test_failing if {',
            '  y := 7',
            '  y == 8', // deliberate failure
            '}',
          ].join('\n') + '\n',
          'utf8',
        );

        const result = await opa.test({ paths: [dir] });
        // Exit non-zero: one test fails.
        expect(result.exitCode).not.toBe(0);
        const records = JSON.parse(result.stdout) as Array<{
          fail?: boolean;
          trace?: unknown;
        }>;
        const failing = records.find((r) => r.fail === true);
        expect(failing).toBeDefined();
        // Without --var-values, trace is absent from the record.
        expect(failing?.trace).toBeUndefined();
      });

      it('works correctly with table-driven tests: trace shows failing case context', async () => {
        // A table-driven test using `every tc in cases { ... }`.
        // With --var-values + --verbose, the trace identifies which tc failed.
        const dir = join(tmpWorkDir, 'tests-var-values-table');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'policy.rego'),
          ['package tbl', 'import rego.v1', 'allow if input.role == "admin"'].join('\n') + '\n',
          'utf8',
        );
        await writeFile(
          join(dir, 'policy_test.rego'),
          [
            'package tbl_test',
            'import rego.v1',
            'import data.tbl',
            'allow_cases := [',
            '  {"input": {"role": "admin"}, "expected": true},',
            '  {"input": {"role": "viewer"}, "expected": false},', // will fail: allow is undefined, not false
            ']',
            'test_allow if {',
            '  every tc in allow_cases {',
            '    actual := tbl.allow with input as tc.input',
            '    actual == tc.expected',
            '  }',
            '}',
          ].join('\n') + '\n',
          'utf8',
        );

        const result = await opa.test({ paths: [dir], varValues: true, verbose: true });
        // The "viewer" case fails because `allow` is undefined (not false).
        expect(result.exitCode).not.toBe(0);
        const records = JSON.parse(result.stdout) as Array<{
          name?: string;
          fail?: boolean;
          trace?: unknown[];
        }>;
        const failing = records.find((r) => r.fail === true);
        expect(failing).toBeDefined();
        expect(failing?.name).toBe('test_allow');
        // With --var-values, OPA provides a trace that includes variable bindings
        // from the failing iteration -- the caller can inspect tc to find the case.
        expect(Array.isArray(failing?.trace)).toBe(true);
      });

      it('varValues: true with runPattern filters which tests emit trace', async () => {
        // Sanity check: combining varValues with runPattern should still work.
        const dir = join(tmpWorkDir, 'tests-var-values-filtered');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'test_filtered.rego'),
          [
            'package filtered_test',
            'import rego.v1',
            'test_target if {',
            '  z := 5',
            '  z == 5',
            '}',
            'test_other if {',
            '  w := 3',
            '  w == 3',
            '}',
          ].join('\n') + '\n',
          'utf8',
        );

        const result = await opa.test({
          paths: [dir],
          varValues: true,
          verbose: true,
          runPattern: '^data.filtered_test.test_target$',
        });
        expect(result.exitCode).toBe(0);
        const records = JSON.parse(result.stdout) as Array<{ name?: string }>;
        // Only the targeted test should appear.
        expect(records).toHaveLength(1);
        expect(records[0]?.name).toBe('test_target');
      });
    });
  });

  describe('build()', () => {
    it('builds a bundle from a directory', async () => {
      const policyDir = join(tmpWorkDir, 'policies');
      await mkdir(policyDir, { recursive: true });
      await writeFile(
        join(policyDir, 'main.rego'),
        'package main\nimport rego.v1\nallow if input.x == 1\n',
        'utf8',
      );
      const out = join(tmpWorkDir, 'bundle.tar.gz');

      const result = await opa.build({
        paths: [policyDir],
        output: out,
        revision: 'integration-test',
      });
      expect(result.exitCode).toBe(0);

      const stat = await readFile(out);
      expect(stat.length).toBeGreaterThan(0);
    });
  });

  describe('fmtList()', () => {
    it('returns exit 0 on a valid already-formatted fixture', async () => {
      const result = await opa.fmtList({ paths: [validRbacPath] });
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it('returns empty stdout when the file is already canonical', async () => {
      // rbac.rego in fixtures is kept formatted; --list should produce no output.
      const result = await opa.fmtList({ paths: [validRbacPath] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('lists a dirty file in stdout', async () => {
      const dirty = join(tmpWorkDir, 'dirty_list.rego');
      // Unformatted: `allow=true` instead of `allow = true`
      await writeFile(dirty, 'package fmt_list_test\nallow=true\n', 'utf8');
      const result = await opa.fmtList({ paths: [dirty] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('dirty_list.rego');
    });

    it('exits non-zero on a file that cannot be parsed', async () => {
      const bad = join(tmpWorkDir, 'bad_fmt.rego');
      await writeFile(bad, 'package bad\n[broken syntax', 'utf8');
      const result = await opa.fmtList({ paths: [bad] });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/rego_parse_error/);
    });

    it('throws when paths is empty', async () => {
      await expect(opa.fmtList({ paths: [] })).rejects.toThrow(/at least one path/);
    });
  });

  describe('fmtWrite()', () => {
    it('formats a dirty file in place and exits 0', async () => {
      const dirty = join(tmpWorkDir, 'dirty_write.rego');
      await writeFile(dirty, 'package fmt_write_test\nallow=true\n', 'utf8');

      const result = await opa.fmtWrite({ paths: [dirty] });
      expect(result.exitCode).toBe(0);

      const formatted = await readFile(dirty, 'utf8');
      expect(formatted).toContain('allow = true');
    });

    it('exits 0 on an already-canonical file (no-op)', async () => {
      const clean = join(tmpWorkDir, 'clean_write.rego');
      await writeFile(
        clean,
        'package fmt_write_clean\nimport rego.v1\nallow if input.x == 1\n',
        'utf8',
      );
      const result = await opa.fmtWrite({ paths: [clean] });
      expect(result.exitCode).toBe(0);
    });

    it('exits non-zero on a file that cannot be parsed', async () => {
      const bad = join(tmpWorkDir, 'bad_write.rego');
      await writeFile(bad, 'package bad\n[broken syntax', 'utf8');
      const result = await opa.fmtWrite({ paths: [bad] });
      expect(result.exitCode).not.toBe(0);
    });

    it('throws when paths is empty', async () => {
      await expect(opa.fmtWrite({ paths: [] })).rejects.toThrow(/at least one path/);
    });
  });

  describe('exec()', () => {
    it('loads policy from dataPaths via --bundle and evaluates each input', async () => {
      const policyDir = join(tmpWorkDir, 'exec-policy');
      await mkdir(policyDir, { recursive: true });
      await writeFile(
        join(policyDir, 'authz.rego'),
        'package authz\nimport rego.v1\n\nallow if input.user == "admin"\n',
        'utf8',
      );
      const inputFile = join(tmpWorkDir, 'exec-input.json');
      await writeFile(inputFile, JSON.stringify({ user: 'admin' }), 'utf8');

      const result = await opa.exec({
        inputPaths: [inputFile],
        decision: 'authz/allow',
        dataPaths: [policyDir],
      });

      // Regression guard for the dataPaths fix: opa exec has no --data flag.
      // The old code pushed --data and always failed with "unknown flag: --data".
      expect(result.stderr).not.toMatch(/unknown flag/i);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { result?: Array<{ result?: unknown }> };
      expect(parsed.result?.[0]?.result).toBe(true);
    });

    it('exits non-zero but still prints results JSON when a --fail-defined gate fires', async () => {
      const policyDir = join(tmpWorkDir, 'exec-gate-policy');
      await mkdir(policyDir, { recursive: true });
      await writeFile(
        join(policyDir, 'authz.rego'),
        'package authz\nimport rego.v1\n\nallow if input.user == "admin"\n',
        'utf8',
      );
      const inputFile = join(tmpWorkDir, 'exec-gate-input.json');
      await writeFile(inputFile, JSON.stringify({ user: 'admin' }), 'utf8');

      const result = await opa.exec({
        inputPaths: [inputFile],
        decision: 'authz/allow',
        dataPaths: [policyDir],
        failDefined: true,
      });

      // allow is defined (true), so --fail-defined makes opa exit non-zero.
      // Crucially, opa still prints the per-file JSON to stdout -- which is the
      // behavior the opa_exec gate handling relies on to report failed:true
      // alongside the results rather than erroring.
      expect(result.exitCode).not.toBe(0);
      const parsed = JSON.parse(result.stdout) as { result?: unknown[] };
      expect(Array.isArray(parsed.result)).toBe(true);
      expect(parsed.result?.length).toBe(1);
    });
  });
});
