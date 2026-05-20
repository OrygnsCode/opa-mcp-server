/**
 * Path-allow-list security tests.
 *
 * The validatePath function is the entire boundary between
 * agent-supplied paths and the host filesystem. These tests cover the
 * traversal attacks, edge-case input shapes, and platform-specific
 * resolution rules that the function has to get right.
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isDirectory, validatePath } from '../../../src/lib/security.js';

let workDir: string;
let allowedRoot: string;
let realFile: string;
let realSubDir: string;

beforeAll(async () => {
  workDir = join(tmpdir(), `orygn-sec-test-${Date.now()}`);
  allowedRoot = join(workDir, 'policies');
  realSubDir = join(allowedRoot, 'sub');
  realFile = join(allowedRoot, 'main.rego');
  await mkdir(realSubDir, { recursive: true });
  await writeFile(realFile, 'package x', 'utf8');
  await writeFile(join(realSubDir, 'inner.rego'), 'package y', 'utf8');
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('validatePath — input shape', () => {
  it('rejects empty string', () => {
    const result = validatePath('', [allowedRoot]);
    expect(result.ok).toBe(false);
    expect(result.error?.error?.code).toBe('INVALID_INPUT');
  });

  // The function signature requires `string`, but defensive runtime
  // check should still reject malformed inputs.
  it('rejects non-string inputs at runtime', () => {
    const result = validatePath(undefined as unknown as string, [allowedRoot]);
    expect(result.ok).toBe(false);
    expect(result.error?.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects when allowedRoots is empty (fail-secure default)', () => {
    const result = validatePath(realFile, []);
    expect(result.ok).toBe(false);
    expect(result.error?.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(result.error?.error?.hint).toMatch(/OPA_MCP_ALLOWED_PATHS/);
  });
});

describe('validatePath — happy paths', () => {
  it('accepts an absolute path inside an allowed root', () => {
    const result = validatePath(realFile, [allowedRoot]);
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(resolve(realFile));
  });

  it('accepts a path nested deeper than the root', () => {
    const deep = join(realSubDir, 'inner.rego');
    const result = validatePath(deep, [allowedRoot]);
    expect(result.ok).toBe(true);
  });

  it('accepts the allowed root itself', () => {
    const result = validatePath(allowedRoot, [allowedRoot]);
    expect(result.ok).toBe(true);
  });

  it('accepts when one of multiple allowed roots matches', () => {
    const otherRoot = join(workDir, 'something-else');
    const result = validatePath(realFile, [otherRoot, allowedRoot]);
    expect(result.ok).toBe(true);
  });
});

describe('validatePath — traversal and overlap protection', () => {
  it('blocks `..` traversal that escapes the allowed root', () => {
    const escape = join(allowedRoot, '..', '..', 'etc', 'passwd');
    const result = validatePath(escape, [allowedRoot]);
    expect(result.ok).toBe(false);
    expect(result.error?.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('does not treat a sibling that prefix-matches the root as inside it', () => {
    // /tmp/xxx/policies vs /tmp/xxx/policies-evil — the second must NOT
    // be considered inside the first even though `startsWith` would
    // succeed without the path-separator boundary check.
    const sibling = `${allowedRoot}-evil`;
    const result = validatePath(sibling, [allowedRoot]);
    expect(result.ok).toBe(false);
    expect(result.error?.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('blocks an unrelated absolute path', () => {
    const unrelated = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/hosts';
    const result = validatePath(unrelated, [allowedRoot]);
    expect(result.ok).toBe(false);
    expect(result.error?.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('resolves a relative path against process.cwd() before checking the allow-list', () => {
    // A relative path resolves to <cwd>/relative — outside the
    // tmp-based allow-list — so we expect a rejection.
    const result = validatePath('relative.rego', [allowedRoot]);
    expect(result.ok).toBe(false);
    expect(result.error?.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('reports the resolved path and allowedRoots in the error details', () => {
    const result = validatePath('/etc/shadow', [allowedRoot]);
    expect(result.ok).toBe(false);
    const details = result.error?.error?.details as {
      resolved?: string;
      allowedRoots?: string[];
    };
    expect(details.resolved).toBeDefined();
    expect(details.allowedRoots).toEqual([allowedRoot]);
  });
});

describe('validatePath — mustExist option', () => {
  it('returns PATH_NOT_FOUND when mustExist is true and the file is missing', () => {
    const missing = join(allowedRoot, 'nope.rego');
    const result = validatePath(missing, [allowedRoot], { mustExist: true });
    expect(result.ok).toBe(false);
    expect(result.error?.error?.code).toBe('PATH_NOT_FOUND');
  });

  it('passes when mustExist is true and the file exists', () => {
    const result = validatePath(realFile, [allowedRoot], { mustExist: true });
    expect(result.ok).toBe(true);
  });

  it('passes when mustExist is false and the file is missing (write case)', () => {
    const futureFile = join(allowedRoot, 'future.tar.gz');
    const result = validatePath(futureFile, [allowedRoot], { mustExist: false });
    expect(result.ok).toBe(true);
  });
});

describe('validatePath — symlink traversal', () => {
  // Symlink creation requires elevated rights on Windows (no developer mode).
  // The fix is exercised on Linux/macOS where symlinks are unprivileged.
  it.skipIf(process.platform === 'win32')(
    'blocks a symlink inside the allowed root that points outside',
    async () => {
      // Create a target outside the allowed root.
      const outsideDir = join(workDir, 'outside');
      const outsideFile = join(outsideDir, 'secret.txt');
      await mkdir(outsideDir, { recursive: true });
      await writeFile(outsideFile, 'top secret', 'utf8');

      // Create a symlink inside the allowed root pointing to the outside file.
      const linkPath = join(allowedRoot, 'evil-link.rego');
      await symlink(outsideFile, linkPath);

      const result = validatePath(linkPath, [allowedRoot], { mustExist: true });
      expect(result.ok).toBe(false);
      expect(result.error?.error?.code).toBe('PATH_NOT_ALLOWED');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'blocks a symlink to a directory outside the allowed root',
    async () => {
      const outsideDir = join(workDir, 'outside-dir');
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, 'data.json'), '{}', 'utf8');

      const linkPath = join(allowedRoot, 'evil-dir-link');
      await symlink(outsideDir, linkPath);

      const result = validatePath(linkPath, [allowedRoot], { mustExist: true });
      expect(result.ok).toBe(false);
      expect(result.error?.error?.code).toBe('PATH_NOT_ALLOWED');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'allows a symlink that points to a file still inside the allowed root',
    async () => {
      const linkPath = join(allowedRoot, 'safe-link.rego');
      await symlink(realFile, linkPath);

      const result = validatePath(linkPath, [allowedRoot], { mustExist: true });
      expect(result.ok).toBe(true);
      // resolved must be the real file, not the symlink path
      expect(result.resolved).toBe(realFile);
    },
  );
});

describe('validatePath — path normalization', () => {
  it('normalizes redundant separators and dot segments', () => {
    const messy = join(allowedRoot, '.', 'sub', '..', 'main.rego');
    const result = validatePath(messy, [allowedRoot]);
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(resolve(realFile));
  });

  it('blocks a path that normalizes outside the root via mid-path `..`', () => {
    // <root>/../escape.rego — after normalization, escapes the root.
    const tricky = join(allowedRoot, '..', 'escape.rego');
    const result = validatePath(tricky, [allowedRoot]);
    expect(result.ok).toBe(false);
  });
});

describe('isDirectory', () => {
  it('returns true for an existing directory', () => {
    expect(isDirectory(allowedRoot)).toBe(true);
  });

  it('returns false for a regular file', () => {
    expect(isDirectory(realFile)).toBe(false);
  });

  it('returns false for a missing path (does not throw)', () => {
    expect(isDirectory(join(allowedRoot, 'missing'))).toBe(false);
  });
});
