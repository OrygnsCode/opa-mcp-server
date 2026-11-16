import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadedBundleType, tarGzFileNames } from '../../../src/lib/bundle-archive.js';
import { paxRecord, tar, tarGz, type TarEntry } from './_tar.js';

let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orygn-bundle-archive-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(bytes: Buffer): Promise<string> {
  const path = join(dir, `a-${counter++}.tar.gz`);
  await writeFile(path, bytes);
  return path;
}

const names = async (entries: TarEntry[]) => tarGzFileNames(await file(tarGz(entries)));

describe('tarGzFileNames', () => {
  it('lists file entries in archive order, as opa build writes them', async () => {
    expect(
      await names([
        { name: '/data.json', data: '{}' },
        { name: '/policy/p.rego', data: 'package p\n' },
        { name: '/.manifest', data: '{"revision":""}' },
      ]),
    ).toEqual(['/data.json', '/policy/p.rego', '/.manifest']);
  });

  it('joins a POSIX ustar prefix to the name', async () => {
    expect(await names([{ name: 'patch.json', prefix: 'deep/dir', data: '{}' }])).toEqual([
      'deep/dir/patch.json',
    ]);
  });

  it('ignores the prefix bytes of a GNU header, which hold timestamps there', async () => {
    expect(await names([{ name: 'x.json', prefix: 'junk', gnu: true, data: '{}' }])).toEqual([
      'x.json',
    ]);
  });

  it('takes the name of the next entry from a PAX path record', async () => {
    expect(
      await names([
        { name: 'PaxHeaders/0', type: 'x', data: paxRecord('path', 'long/name/patch.json') },
        { name: 'truncated-name', data: '{}' },
        { name: 'after.json', data: '{}' },
      ]),
    ).toEqual(['long/name/patch.json', 'after.json']);
  });

  it('keeps the header name when a PAX header has no path record', async () => {
    expect(
      await names([
        { name: 'PaxHeaders/0', type: 'x', data: paxRecord('mtime', '1') },
        { name: 'kept.json', data: '{}' },
      ]),
    ).toEqual(['kept.json']);
  });

  it('takes the name of the next entry from a GNU long name', async () => {
    expect(
      await names([
        { name: '././@LongLink', type: 'L', gnu: true, data: 'gnu/long/patch.json\0' },
        { name: 'gnu/long/pat', gnu: true, data: '{}' },
      ]),
    ).toEqual(['gnu/long/patch.json']);
  });

  it('lists no directories, links or global headers, and steps over their data', async () => {
    expect(
      await names([
        { name: 'dir/', type: '5' },
        { name: 'link', type: '2' },
        { name: 'pax_global_header', type: 'g', data: paxRecord('comment', 'x'.repeat(700)) },
        { name: 'dir/f.json', data: '{}' },
      ]),
    ).toEqual(['dir/f.json']);
  });

  it('reads past an entry far larger than a stream chunk', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, 0x61);
    expect(
      await names([
        { name: 'big.json', data: big },
        { name: 'patch.json', data: '{}' },
      ]),
    ).toEqual(['big.json', 'patch.json']);
  });

  it('reads a base-256 size', async () => {
    expect(
      await names([
        { name: 'a.json', data: 'x'.repeat(600), base256: true },
        { name: 'b.json', data: '{}' },
      ]),
    ).toEqual(['a.json', 'b.json']);
  });

  it('stops at the end-of-archive marker and ignores what follows', async () => {
    const archive = Buffer.concat([tar([{ name: 'a.json', data: '{}' }]), Buffer.from('trailing')]);
    expect(await tarGzFileNames(await file(gzipSync(archive)))).toEqual(['a.json']);
  });

  it('throws on a corrupted header checksum', async () => {
    await expect(names([{ name: 'a.json', data: '{}', badChecksum: true }])).rejects.toThrow(
      /checksum/,
    );
  });

  it('throws on a truncated archive', async () => {
    const whole = tar([{ name: 'a.json', data: 'x'.repeat(2000) }]);
    const cut = await file(gzipSync(whole.subarray(0, 1000)));
    await expect(tarGzFileNames(cut)).rejects.toThrow(/truncated/);
  });

  it('throws on input that is not gzip', async () => {
    await expect(tarGzFileNames(await file(Buffer.from('fake bundle bytes')))).rejects.toThrow();
  });

  it('throws, rather than waiting, on a file that does not exist', async () => {
    await expect(tarGzFileNames(join(dir, 'missing.tar.gz'))).rejects.toThrow(/ENOENT/);
  });
});

describe('loadedBundleType', () => {
  const type = async (entries: TarEntry[]) => loadedBundleType(await file(tarGz(entries)));

  it('is delta for the archive opa build writes from a delta bundle', async () => {
    expect(
      await type([
        { name: '/patch.json', data: '{"data":[{"op":"upsert","path":"/x","value":1}]}' },
        { name: '/.manifest', data: '{"roots":["x"]}' },
      ]),
    ).toBe('delta');
  });

  it('is delta for a patch.json at any depth, with either separator', async () => {
    expect(await type([{ name: '/a/b/patch.json', data: '{}' }])).toBe('delta');
    expect(await type([{ name: '/a\\patch.json', data: '{}' }])).toBe('delta');
  });

  it('is snapshot for a bundle with no patch.json', async () => {
    expect(
      await type([
        { name: '/data.json', data: '{}' },
        { name: '/mypatch.json', data: '{}' },
        { name: '/patch.json.bak', data: '{}' },
        { name: '/p.rego', data: 'package p\n' },
        { name: '/.signatures.json', data: '{}' },
      ]),
    ).toBe('snapshot');
  });

  it('is unreadable, never snapshot, when the archive cannot be read', async () => {
    expect(await loadedBundleType(await file(Buffer.from('not gzip')))).toBe('unreadable');
    expect(await loadedBundleType(join(dir, 'missing.tar.gz'))).toBe('unreadable');
    expect(await type([{ name: '/data.json', data: '{}', badChecksum: true }])).toBe('unreadable');
  });
});
