/**
 * Tests for the opa binary resolver.
 *
 * The resolver decides which `opa` the server spawns. Two properties
 * matter most and are covered explicitly here:
 *   - an explicit OPA_BINARY is never second-guessed, and
 *   - an `opa` already on PATH is never replaced by the bundled binary
 *     (the zero-regression guarantee for existing installs).
 *
 * The decision tree is exercised with injected probes; the real PATH scan
 * is exercised against actual files in a temp directory so the
 * cross-platform extension/quote handling is tested faithfully rather
 * than against a mock.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  binOnPath,
  bundledOpaPath,
  platformPackageName,
  resolveOpaBinary,
} from '../../../src/lib/resolve-binary.js';

describe('platformPackageName()', () => {
  it('maps every supported platform/arch to its package', () => {
    expect(platformPackageName('linux', 'x64')).toBe('@orygn/opa-mcp-linux-x64');
    expect(platformPackageName('linux', 'arm64')).toBe('@orygn/opa-mcp-linux-arm64');
    expect(platformPackageName('darwin', 'x64')).toBe('@orygn/opa-mcp-darwin-x64');
    expect(platformPackageName('darwin', 'arm64')).toBe('@orygn/opa-mcp-darwin-arm64');
    expect(platformPackageName('win32', 'x64')).toBe('@orygn/opa-mcp-win32-x64');
  });

  it('returns undefined for unsupported combinations', () => {
    expect(platformPackageName('linux', 'ia32')).toBeUndefined();
    expect(platformPackageName('win32', 'arm64')).toBeUndefined();
    expect(platformPackageName('freebsd', 'x64')).toBeUndefined();
    expect(platformPackageName('darwin', 'ppc64')).toBeUndefined();
  });
});

describe('resolveOpaBinary() — decision tree', () => {
  it('returns an explicit OPA_BINARY verbatim without probing', () => {
    const onPath = vi.fn(() => true);
    const bundled = vi.fn(() => '/bundled/opa');
    expect(resolveOpaBinary('/usr/local/bin/opa-custom', { onPath, bundled })).toBe(
      '/usr/local/bin/opa-custom',
    );
    expect(onPath).not.toHaveBeenCalled();
    expect(bundled).not.toHaveBeenCalled();
  });

  it('prefers opa on PATH and does not consult the bundle', () => {
    const onPath = vi.fn(() => true);
    const bundled = vi.fn(() => '/bundled/opa');
    expect(resolveOpaBinary('opa', { onPath, bundled })).toBe('opa');
    expect(onPath).toHaveBeenCalledWith('opa');
    expect(bundled).not.toHaveBeenCalled();
  });

  it('falls back to the bundled binary when opa is not on PATH', () => {
    const onPath = vi.fn(() => false);
    const bundled = vi.fn(() => '/node_modules/@orygn/opa-mcp-linux-x64/opa');
    expect(resolveOpaBinary('opa', { onPath, bundled })).toBe(
      '/node_modules/@orygn/opa-mcp-linux-x64/opa',
    );
  });

  it("falls back to literal 'opa' when neither PATH nor a bundle is available", () => {
    const onPath = vi.fn(() => false);
    const bundled = vi.fn(() => undefined);
    expect(resolveOpaBinary('opa', { onPath, bundled })).toBe('opa');
  });
});

describe('binOnPath() — real filesystem scan', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-binary-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds a bare binary on a posix-style PATH', () => {
    writeFileSync(join(dir, 'opa'), '');
    expect(binOnPath('opa', { platform: 'linux', pathEnv: dir })).toBe(true);
  });

  it('returns false when the binary is absent from every PATH entry', () => {
    const other = mkdtempSync(join(tmpdir(), 'resolve-binary-empty-'));
    try {
      expect(
        binOnPath('opa', { platform: 'linux', pathEnv: [dir, other].join(delimiter) }),
      ).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('skips empty PATH segments without error', () => {
    writeFileSync(join(dir, 'opa'), '');
    const pathEnv = ['', dir, ''].join(delimiter);
    expect(binOnPath('opa', { platform: 'linux', pathEnv })).toBe(true);
  });

  it('strips surrounding double quotes from a PATH entry (windows-style)', () => {
    writeFileSync(join(dir, 'opa.exe'), '');
    const pathEnv = `"${dir}"`;
    expect(binOnPath('opa', { platform: 'win32', pathEnv, pathExt: '.EXE' })).toBe(true);
  });

  it('honors PATHEXT on win32, matching by appending an extension', () => {
    writeFileSync(join(dir, 'opa.exe'), '');
    // The bare name must NOT match on win32 (only name+ext is tried).
    expect(binOnPath('opa', { platform: 'win32', pathEnv: dir, pathExt: '.COM;.EXE' })).toBe(
      true,
    );
  });

  it('does not match a win32 binary when no PATHEXT extension lines up', () => {
    writeFileSync(join(dir, 'opa.exe'), '');
    expect(binOnPath('opa', { platform: 'win32', pathEnv: dir, pathExt: '.COM;.BAT' })).toBe(
      false,
    );
  });
});

describe('bundledOpaPath()', () => {
  it('returns undefined for an unsupported platform without touching the filesystem', () => {
    expect(bundledOpaPath('freebsd', 'x64')).toBeUndefined();
    expect(bundledOpaPath('linux', 'ia32')).toBeUndefined();
  });

  it('returns undefined when the optional dependency is not installed', () => {
    // The platform packages are not dependencies of this repo, so even on a
    // supported host require.resolve fails and the resolver degrades cleanly.
    expect(bundledOpaPath('linux', 'x64')).toBeUndefined();
  });
});
