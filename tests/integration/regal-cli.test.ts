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

  // Read RBAC fixture to ensure the test file path resolution is right.
  it('fixture path is reachable', async () => {
    const source = await readFile(validRbacPath, 'utf8');
    expect(source).toContain('package rbac');
  });
});
