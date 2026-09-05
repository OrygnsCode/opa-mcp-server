/**
 * Tests for rewriting load paths before they reach `opa`.
 *
 * The rewriter only acts on paths that exist on disk, so these use a real temp
 * tree rather than invented ones. The platform-specific cases are split
 * because the behaviour genuinely differs: an absolute path on POSIX carries
 * no drive letter and needs nothing done to it.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rewriteLoadPaths } from '../../../src/lib/opa-paths.js';

const WINDOWS = process.platform === 'win32';

let workDir: string;
let dataFile: string;
let otherData: string;
let policyFile: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-opa-paths-'));
  await mkdir(join(workDir, 'sub'), { recursive: true });
  dataFile = join(workDir, 'data.json');
  otherData = join(workDir, 'sub', 'more.json');
  policyFile = join(workDir, 'policy.rego');
  await writeFile(dataFile, '{"a":1}');
  await writeFile(otherData, '{"b":2}');
  await writeFile(policyFile, 'package p\n');
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('rewriteLoadPaths', () => {
  it('returns the arguments untouched when there are no load paths', () => {
    const args = ['eval', '--format=json', 'data.example.allow'];
    expect(rewriteLoadPaths(args, [])).toEqual({ args });
  });

  it('ignores a load path that does not exist on disk', () => {
    const missing = join(workDir, 'not-here.json');
    const out = rewriteLoadPaths(['eval', '--data', missing, 'data'], [missing]);
    expect(out.args).toEqual(['eval', '--data', missing, 'data']);
    expect(out.cwd).toBeUndefined();
  });

  it('never touches an argument that was not declared a load path', () => {
    // The same file as an --input value, which opa opens rather than mounts.
    const args = ['eval', '--input', dataFile, 'data.p.allow'];
    expect(rewriteLoadPaths(args, []).args).toEqual(args);
  });

  it('does not respell a .rego module, since it mounts by package', () => {
    // Respelling modules would also catch the temp file used for inline source,
    // whose absolute path is matched afterwards to redact it from output.
    const out = rewriteLoadPaths(['eval', '--data', policyFile], [policyFile]);
    expect(out.args).toEqual(['eval', '--data', policyFile]);
  });

  it.runIf(WINDOWS)("still runs the child on the module's drive", () => {
    // OPA opens a module by the remainder after the colon, a root-relative
    // path it resolves against the drive the child runs on. Left to the
    // server's own working directory, a module on another drive is not found.
    const out = rewriteLoadPaths(['eval', '--data', policyFile], [policyFile]);
    expect(out.cwd).toBe(dirname(policyFile));
    expect(out.conflict).toBeUndefined();
  });

  it.runIf(!WINDOWS)('chooses no working directory for a module without a drive letter', () => {
    const out = rewriteLoadPaths(['eval', '--data', policyFile], [policyFile]);
    expect(out.cwd).toBeUndefined();
  });

  it.runIf(WINDOWS)('rewrites data paths relative to their common directory', () => {
    const out = rewriteLoadPaths(
      ['eval', '--data', dataFile, '--data', otherData, 'data'],
      [dataFile, otherData],
    );
    expect(out.cwd).toBe(workDir);
    expect(out.args).toEqual([
      'eval',
      '--data',
      'data.json',
      '--data',
      join('sub', 'more.json'),
      'data',
    ]);
    // Nothing reaching opa still carries a drive letter.
    for (const a of out.args) expect(a).not.toMatch(/^[A-Za-z]:[\\/]/);
    // And each rewritten argument still names the same file.
    expect(join(out.cwd!, out.args[2]!)).toBe(dataFile);
    expect(join(out.cwd!, out.args[4]!)).toBe(otherData);
  });

  it.runIf(WINDOWS)('rewrites a directory load path relative to its parent', () => {
    // A directory argument is itself a load path, so it cannot also be the
    // place opa runs from; the parent is.
    const out = rewriteLoadPaths(['test', workDir], [workDir]);
    expect(out.cwd).toBe(dirname(workDir));
    expect(out.args).toEqual(['test', basename(workDir)]);
    expect(join(out.cwd!, out.args[1]!)).toBe(workDir);
  });

  it.runIf(WINDOWS)('keeps flags and the query untouched while rewriting paths', () => {
    const out = rewriteLoadPaths(
      ['eval', '--format=json', '--data', dataFile, 'data.p.allow'],
      [dataFile],
    );
    expect(out.args[0]).toBe('eval');
    expect(out.args[1]).toBe('--format=json');
    expect(out.args[4]).toBe('data.p.allow');
  });

  it.runIf(WINDOWS)('reports a conflict when load paths span two drives', () => {
    // Both entries must exist for the rewriter to consider them, so this runs
    // only where a second drive is actually present.
    const otherDrive = ['D:\\', 'E:\\'].find((d) => existsSync(d));
    if (otherDrive === undefined) return;
    const out = rewriteLoadPaths(
      ['eval', '--data', dataFile, '--data', otherDrive],
      [dataFile, otherDrive],
    );
    expect(out.conflict?.drives.length).toBeGreaterThan(1);
    expect(out.cwd).toBeUndefined();
    // The arguments come back untouched rather than half-rewritten.
    expect(out.args).toEqual(['eval', '--data', dataFile, '--data', otherDrive]);
  });

  it.runIf(!WINDOWS)('is a no-op where absolute paths have no drive letter', () => {
    const args = ['eval', '--data', dataFile, '--data', otherData, 'data'];
    const out = rewriteLoadPaths(args, [dataFile, otherData]);
    expect(out.args).toEqual(args);
    expect(out.cwd).toBeUndefined();
  });
});
