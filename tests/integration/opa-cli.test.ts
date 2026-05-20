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
