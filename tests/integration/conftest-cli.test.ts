/**
 * Integration tests for ConftestCli against a real conftest binary.
 *
 * These tests are skipped automatically when `conftest` is not on PATH
 * (or CONFTEST_BINARY is not set). They exercise the real subprocess so
 * they complement the unit tests that mock runBinary.
 *
 * Set CONFTEST_BINARY to a specific binary path if conftest is not on
 * PATH, e.g.:
 *   CONFTEST_BINARY=/usr/local/bin/conftest npm test
 */
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { ConftestCli } from '../../src/lib/conftest-cli.js';

const CONFTEST_BINARY = process.env['CONFTEST_BINARY'] ?? 'conftest';
const FIXTURES = join(__dirname, '..', 'fixtures', 'conftest');
const POLICY_DIR = join(FIXTURES, 'policy');
const PASSING_CONFIG = join(FIXTURES, 'configs', 'passing.yaml');
const FAILING_CONFIG = join(FIXTURES, 'configs', 'failing.yaml');

const config: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: process.env['OPA_BINARY'] ?? 'opa',
  regalBinary: process.env['REGAL_BINARY'] ?? 'regal',
  conftestBinary: CONFTEST_BINARY,
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-opa-mcp-conftest-it.log'),
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

const cli = new ConftestCli(config);

// ─── Skip guard ───────────────────────────────────────────────────────────────

let conftestVersion: string | null = null;

beforeAll(async () => {
  conftestVersion = await cli.version().catch(() => null);
}, 15_000);

function skipIfNoConftest(): boolean {
  return conftestVersion === null;
}

// ─── version() ────────────────────────────────────────────────────────────────

describe('ConftestCli integration', () => {
  describe('version()', () => {
    it('returns a parseable version string', () => {
      if (skipIfNoConftest()) return;
      expect(conftestVersion).toMatch(/^\d+\.\d+/);
    });
  });

  // ─── test() ───────────────────────────────────────────────────────────────

  describe('test()', () => {
    it('exit 0 when config passes all policy rules', async () => {
      if (skipIfNoConftest()) return;

      const result = await cli.test({
        files: [PASSING_CONFIG],
        policy: POLICY_DIR,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as Array<{ failures: unknown[] }>;
      expect(Array.isArray(parsed)).toBe(true);
      for (const r of parsed) {
        expect(r.failures).toHaveLength(0);
      }
    }, 15_000);

    it('exit 1 when config violates policy rules', async () => {
      if (skipIfNoConftest()) return;

      const result = await cli.test({
        files: [FAILING_CONFIG],
        policy: POLICY_DIR,
      });

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout) as Array<{ failures: Array<{ msg: string }> }>;
      expect(Array.isArray(parsed)).toBe(true);
      const allFailures = parsed.flatMap((r) => r.failures);
      expect(allFailures.length).toBeGreaterThan(0);
    }, 15_000);

    it('exit 0 for inlineConfig that passes policy', async () => {
      if (skipIfNoConftest()) return;

      const passingManifest = `
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
    - name: app
      image: nginx:1.25.0
      resources:
        limits:
          cpu: "500m"
          memory: "128Mi"
      securityContext:
        runAsUser: 1000
`;

      const result = await cli.test({
        inlineConfig: passingManifest,
        inlineConfigParser: 'yaml',
        policy: POLICY_DIR,
      });

      expect(result.exitCode).toBe(0);
      // Temp path should be sanitized to <inline> in output
      expect(result.stdout).toContain('<inline>');
      expect(result.stdout).not.toMatch(/orygn-conftest-/);
    }, 15_000);

    it('exit 1 for inlineConfig that violates policy', async () => {
      if (skipIfNoConftest()) return;

      const failingManifest = `
apiVersion: v1
kind: Pod
metadata:
  name: bad-pod
spec:
  containers:
    - name: app
      image: nginx:latest
      securityContext:
        runAsUser: 0
`;

      const result = await cli.test({
        inlineConfig: failingManifest,
        inlineConfigParser: 'yaml',
        policy: POLICY_DIR,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('<inline>');
      const parsed = JSON.parse(result.stdout) as Array<{ failures: unknown[] }>;
      const hasFailures = parsed.some((r) => r.failures.length > 0);
      expect(hasFailures).toBe(true);
    }, 15_000);

    it('uses --namespace to target a specific namespace', async () => {
      if (skipIfNoConftest()) return;

      const result = await cli.test({
        files: [PASSING_CONFIG],
        policy: POLICY_DIR,
        namespace: 'main',
      });

      // exit code 0 or 1 -- just verify JSON output is produced
      const parsed = JSON.parse(result.stdout) as Array<{ namespace: string }>;
      expect(Array.isArray(parsed)).toBe(true);
      for (const r of parsed) {
        expect(r.namespace).toBe('main');
      }
    }, 15_000);

    it('exit 0 when using inlinePolicy that always passes', async () => {
      if (skipIfNoConftest()) return;

      // A policy that never denies -- everything passes
      const allowAllPolicy = `package main\n`;

      const result = await cli.test({
        files: [PASSING_CONFIG],
        inlinePolicy: allowAllPolicy,
      });

      expect(result.exitCode).toBe(0);
      // Both the inline policy dir and config file should be sanitized
      // (config is a real file here, so only policyDir gets sanitized)
    }, 15_000);
  });

  // ─── verify() ─────────────────────────────────────────────────────────────

  describe('verify()', () => {
    it('exit 0 when all _test.rego tests pass', async () => {
      if (skipIfNoConftest()) return;

      const result = await cli.verify({ policy: POLICY_DIR });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as Array<{ failures: unknown[] }>;
      expect(Array.isArray(parsed)).toBe(true);
      for (const r of parsed) {
        expect(r.failures).toHaveLength(0);
      }
    }, 15_000);

    it('produces --output=json structured output', async () => {
      if (skipIfNoConftest()) return;

      const result = await cli.verify({ policy: POLICY_DIR });

      // Output should be parseable JSON array
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      // Each entry should have the standard conftest result shape
      if (parsed.length > 0) {
        const entry = parsed[0] as Record<string, unknown>;
        expect(entry).toHaveProperty('filename');
        expect(entry).toHaveProperty('namespace');
        expect(entry).toHaveProperty('successes');
        expect(entry).toHaveProperty('failures');
      }
    }, 15_000);
  });

  // ─── pull() with invalid URL should error (no network required) ───────────

  describe('pull() with bad URL', () => {
    let workDir: string;

    beforeAll(async () => {
      workDir = join(tmpdir(), `orygn-conftest-pull-it-${Date.now()}`);
      await mkdir(workDir, { recursive: true });
    });

    afterAll(async () => {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    });

    it('exits non-zero for an unreachable registry URL', async () => {
      if (skipIfNoConftest()) return;

      // This URL won't resolve -- we just want to see conftest exit non-zero
      // so we know the error path works. We don't need network access.
      const result = await cli.pull({
        url: 'oci://localhost:9999/nonexistent/repo:latest',
        policy: workDir,
      });

      // conftest should fail (exit code 1 or 2) when the registry is unreachable
      expect(result.exitCode).not.toBe(0);
    }, 15_000);
  });

  // ─── AbortSignal cancellation ─────────────────────────────────────────────

  describe('AbortSignal cancellation', () => {
    it('sets aborted=true on SpawnResult when signal fires mid-run', async () => {
      if (skipIfNoConftest()) return;

      const controller = new AbortController();
      // Abort immediately -- conftest should see a cancelled spawn
      controller.abort();

      const result = await cli.test(
        {
          files: [PASSING_CONFIG],
          policy: POLICY_DIR,
        },
        controller.signal,
      );

      // When aborted before spawn, exitCode is null and aborted is true
      expect(result.aborted).toBe(true);
      expect(result.exitCode).toBeNull();
    }, 10_000);
  });
});
