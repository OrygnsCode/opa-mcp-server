/**
 * Reads a bundle archive written by `opa build`, to tell which kind of bundle
 * OPA loaded.
 *
 * Signature verification runs as `opa build --verification-key`, and OPA
 * before 1.21.3 skipped it for delta bundles: an unsigned bundle holding a
 * `patch.json` loaded, built and exited 0 (GHSA-g2pf-6v5v-qcc8). A delta
 * bundle cannot be signed at all, so no verification of one means anything.
 *
 * OPA writes a delta bundle back out as `/patch.json` and `/.manifest`, and
 * never writes a file of that name into a snapshot bundle, so the archive it
 * produced says what it loaded whichever version produced it. Reading OPA's
 * own output avoids reimplementing its rules for what counts as a delta
 * bundle against an input an attacker may have shaped.
 */
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const BLOCK = 512;

/** Largest PAX or GNU long-name record read into memory. */
const MAX_META_BYTES = 1024 * 1024;

/** OPA's name for the operations file of a delta bundle. */
const PATCH_FILE = 'patch.json';

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;

/** A NUL-terminated string field. */
function field(header: Buffer, start: number, end: number): string {
  const raw = header.subarray(start, end);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString('utf8');
}

/** A numeric field: octal text, or base-256 when the top bit is set. */
function numeric(header: Buffer, start: number, end: number): number {
  const raw = header.subarray(start, end);
  if (raw[0]! & 0x80) {
    let n = raw[0]! & 0x7f;
    for (const byte of raw.subarray(1)) n = n * 256 + byte;
    return n;
  }
  const text = raw
    .toString('latin1')
    .replace(/[\0 ]+$/, '')
    .trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`malformed tar numeric field "${text}"`);
  return parseInt(text, 8);
}

/** The header checksum counts the checksum field itself as eight spaces. */
function checksumMatches(header: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum === numeric(header, 148, 156);
}

/** The `path` record of a PAX extended header, if it has one. */
function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const length = parseInt(data.subarray(pos, space).toString('latin1'), 10);
    if (!Number.isInteger(length) || length <= 0 || pos + length > data.length) {
      throw new Error('malformed PAX record');
    }
    const record = data.subarray(space + 1, pos + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    pos += length;
  }
  return path;
}

/**
 * Names of the file entries in a gzipped tar archive, in archive order.
 * Throws on anything it cannot read: a corrupt or truncated archive, a bad
 * header checksum, or input that is not gzip.
 */
export async function tarGzFileNames(path: string): Promise<string[]> {
  const names: string[] = [];
  let buf: Buffer = Buffer.alloc(0);
  let skip = 0;
  let meta: { type: string; size: number } | undefined;
  let nextName: string | undefined;
  let ended = false;

  const parse = (chunk: Buffer): void => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      if (skip > 0) {
        const n = Math.min(skip, buf.length);
        buf = buf.subarray(n);
        skip -= n;
        if (skip > 0) break;
        continue;
      }
      if (meta) {
        const length = padded(meta.size);
        if (buf.length < length) break;
        const data = buf.subarray(0, meta.size);
        nextName = meta.type === 'x' ? (paxPath(data) ?? nextName) : field(data, 0, data.length);
        buf = buf.subarray(length);
        meta = undefined;
        continue;
      }
      if (buf.length < BLOCK) break;
      const header = buf.subarray(0, BLOCK);
      buf = buf.subarray(BLOCK);
      if (header.every((b) => b === 0)) {
        ended = true;
        return;
      }
      if (!checksumMatches(header)) throw new Error('tar header checksum mismatch');

      const size = numeric(header, 124, 136);
      const type = String.fromCharCode(header[156]!);
      if (type === 'x' || type === 'L') {
        if (size > MAX_META_BYTES) throw new Error('tar extended header too large');
        meta = { type, size };
        continue;
      }

      let name = field(header, 0, 100);
      // POSIX ustar splits a long name into prefix and name; GNU tar uses
      // those bytes for timestamps, so only the POSIX magic has a prefix.
      if (header.subarray(257, 263).toString('latin1') === 'ustar\0') {
        const prefix = field(header, 345, 500);
        if (prefix !== '') name = `${prefix}/${name}`;
      }
      if (nextName !== undefined) name = nextName;
      nextName = undefined;

      if (type === '0' || type === '\0' || type === '7') names.push(name);
      // A global PAX header ('g'), a link, a directory: nothing to read, but
      // any data it carries still has to be stepped over.
      skip = padded(size);
    }
  };

  // pipeline() carries a read error through to the loop and closes the file
  // either way; a plain .pipe() would leave the loop waiting on a stream that
  // never ends. A parse error is held and the rest drained, since a throw
  // from the sink surfaces as a bare AbortError. So is anything after the
  // end-of-archive marker.
  let failure: Error | undefined;
  await pipeline(createReadStream(path), createGunzip(), async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      if (ended || failure !== undefined) continue;
      try {
        parse(chunk);
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e));
      }
    }
  });
  if (failure !== undefined) throw failure;

  if (!ended && (skip > 0 || meta !== undefined || buf.length > 0)) {
    throw new Error('tar archive is truncated');
  }
  return names;
}

/**
 * What a bundle archive written by `opa build` holds: `delta` when it has a
 * `patch.json` at any depth, `snapshot` when it has none, and `unreadable`
 * when it cannot be read, which a caller must not treat as either.
 */
export async function loadedBundleType(path: string): Promise<'snapshot' | 'delta' | 'unreadable'> {
  try {
    const names = await tarGzFileNames(path);
    return names.some((n) => n.split(/[\\/]/).pop() === PATCH_FILE) ? 'delta' : 'snapshot';
  } catch {
    return 'unreadable';
  }
}
