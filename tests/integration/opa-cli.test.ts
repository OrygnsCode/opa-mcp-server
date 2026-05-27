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
});
