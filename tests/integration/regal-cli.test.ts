import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { RegalCli } from '../../src/lib/regal-cli.js';

const fixturesDir = join(__dirname, '..', 'fixtures');
const validRbacPath = join(fixturesDir, 'policies', 'valid', 'rbac.rego');

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

const regal = new RegalCli(config);

describe('RegalCli integration', () => {
  it('version() returns a parseable semver', async () => {
    const v = await regal.version();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lints a known-clean fixture and returns JSON output', async () => {
    const result = await regal.lint({ paths: [validRbacPath] });
    // exitCode may be 0 (no issues at fail level) or non-zero (findings).
    // Regal sometimes flags idiom suggestions on perfectly working policies.
    const parsed = JSON.parse(result.stdout) as {
      violations?: unknown[];
    };
    expect(Array.isArray(parsed.violations)).toBe(true);
  });

  it('lints inline source containing a known violation', async () => {
    // `print` calls are flagged by Regal's `print-or-trace-call` rule.
    const source = 'package x\nimport rego.v1\nallow if {\n\tprint(input)\n}\n';
    const result = await regal.lint({ source });
    const parsed = JSON.parse(result.stdout) as {
      violations?: Array<{ title?: string }>;
    };
    expect(Array.isArray(parsed.violations)).toBe(true);
  });

  it('respects --disable to silence a specific rule', async () => {
    const source = 'package x\nimport rego.v1\nallow if {\n\tprint(input)\n}\n';
    const result = await regal.lint({
      source,
      disable: ['print-or-trace-call'],
    });
    const parsed = JSON.parse(result.stdout) as {
      violations?: Array<{ title?: string }>;
    };
    const printViolations = (parsed.violations ?? []).filter(
      (v) => v.title === 'print-or-trace-call',
    );
    expect(printViolations).toHaveLength(0);
  });

  it('bugs category surfaces real violations on a policy with known bugs', async () => {
    // constant-condition and duplicate-rule are confirmed bugs-category violations in regal 0.30.0.
    const source = [
      'package bug_test',
      'import rego.v1',
      'always_true if { 1 == 1 }',
      'foo if { input.x == 1 }',
      'foo if { input.x == 1 }',
    ].join('\n');
    const result = await regal.lint({
      source,
      disableAll: true,
      enableCategory: ['security', 'bugs'],
    });
    const parsed = JSON.parse(result.stdout) as {
      violations?: Array<{ title?: string; category?: string }>;
    };
    const titles = (parsed.violations ?? []).map((v) => v.title);
    expect(titles).toContain('constant-condition');
    expect(titles).toContain('duplicate-rule');
    // Every violation must be in the bugs category.
    for (const v of parsed.violations ?? []) {
      expect(v.category).toBe('bugs');
    }
  });

  // Read RBAC fixture to ensure the test file path resolution is right.
  it('fixture path is reachable', async () => {
    const source = await readFile(validRbacPath, 'utf8');
    expect(source).toContain('package rbac');
  });
});

describe('RegalCli.fix() integration', () => {
  it('dry-run on a fixture returns exit 0 and parseable text output', async () => {
    // We always use --dry-run in integration tests so no files are modified.
    // directory-package-mismatch is disabled to keep the output deterministic
    // (that fix moves files, which depends on directory layout).
    const result = await regal.fix({
      paths: [validRbacPath],
      dryRun: true,
      disable: ['directory-package-mismatch'],
    });
    // regal fix exits 0 whether or not there are fixes to apply.
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // Output must be one of the two known patterns.
    const isValidOutput =
      result.stdout.includes('fix') || result.stdout.trim() === 'No fixes to apply.';
    expect(isValidOutput).toBe(true);
  });

  it('dry-run on a directory returns exit 0', async () => {
    const dir = join(fixturesDir, 'policies', 'valid');
    const result = await regal.fix({
      paths: [dir],
      dryRun: true,
      disable: ['directory-package-mismatch'],
    });
    expect(result.exitCode).toBe(0);
  });

  it('throws when paths array is empty', async () => {
    await expect(regal.fix({ paths: [] })).rejects.toThrow(/at least one path/);
  });
});
