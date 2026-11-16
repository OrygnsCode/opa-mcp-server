/**
 * Builds tar archives byte by byte, so a test can produce exactly the header
 * layouts a reader has to handle: POSIX ustar with a prefix, GNU, PAX records,
 * base-256 sizes.
 */
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  name: string;
  data?: string | Buffer;
  /** Type flag; '0' (regular file) by default. */
  type?: string;
  /** POSIX ustar name prefix. */
  prefix?: string;
  /** Write GNU magic instead of POSIX ustar. */
  gnu?: boolean;
  /** Write the size in base-256 rather than octal. */
  base256?: boolean;
  /** Corrupt the header checksum. */
  badChecksum?: boolean;
}

function header(entry: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(entry.name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  if (entry.base256) {
    h[124] = 0x80;
    h.writeUIntBE(size, 130, 6);
  } else {
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  }
  h.write('00000000000\0', 136, 'latin1');
  h.write(entry.type ?? '0', 156, 'latin1');
  if (entry.gnu) {
    h.write('ustar  \0', 257, 'latin1');
  } else {
    h.write('ustar\0', 257, 'latin1');
    h.write('00', 263, 'latin1');
  }
  if (entry.prefix) h.write(entry.prefix, 345, 155, 'utf8');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  if (entry.badChecksum) sum += 1;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/** One PAX record, `<length> <key>=<value>\n`, where length counts itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length++;
  return `${length}${body}`;
}

/** An uncompressed tar archive, ended by two zero blocks. */
export function tar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    blocks.push(header(entry, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export const tarGz = (entries: TarEntry[]): Buffer => gzipSync(tar(entries));
