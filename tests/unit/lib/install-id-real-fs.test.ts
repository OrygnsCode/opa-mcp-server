/**
 * Install-id tests against a real filesystem.
 *
 * The mocked tests could not see the bug these cover. A zero-byte install-id
 * file made `getInstallId` return null on every run for the life of the
 * machine: the read found no id, the exclusive write failed because the file
 * existed, and the fallback read found no id again. Only `os.homedir` is
 * stubbed here; every file operation is real.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: vi.fn(() => actual.tmpdir()) };
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let home: string;
let idDir: string;
let idFile: string;

async function load() {
  const { getInstallId } = await import('../../../src/lib/install-id.js');
  return getInstallId;
}

beforeEach(async () => {
  vi.resetModules();
  home = await mkdtemp(join(tmpdir(), 'orygn-install-id-'));
  idDir = join(home, '.orygn', 'opa-mcp');
  idFile = join(idDir, 'install-id');
  vi.mocked(os.homedir).mockReturnValue(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('getInstallId on a real filesystem', () => {
  it('creates the file on first run and returns the same id afterwards', async () => {
    const getInstallId = await load();
    const first = await getInstallId();
    expect(first).toMatch(UUID_RE);
    expect((await stat(idFile)).size).toBeGreaterThan(0);

    // A second call in a fresh module instance reads the file back.
    vi.resetModules();
    const again = await (await load())();
    expect(again).toBe(first);
  });

  it('repairs a zero-byte file rather than returning null forever', async () => {
    await mkdir(idDir, { recursive: true });
    await writeFile(idFile, '');

    const first = await (await load())();
    expect(first, 'an empty file must not be a permanent trap').toMatch(UUID_RE);
    expect(await readFile(idFile, 'utf8')).toContain(first!);

    // Repaired for good: the next run reads it rather than rewriting.
    vi.resetModules();
    expect(await (await load())()).toBe(first);
  });

  it('repairs a file holding only the header comments', async () => {
    await mkdir(idDir, { recursive: true });
    await writeFile(idFile, '# opa-mcp install ID\n#\n# no id below\n');
    const id = await (await load())();
    expect(id).toMatch(UUID_RE);
    expect(await readFile(idFile, 'utf8')).toContain(id!);
  });

  it('repairs a file whose id line is malformed', async () => {
    await mkdir(idDir, { recursive: true });
    await writeFile(idFile, '# header\nnot-a-uuid\n');
    const id = await (await load())();
    expect(id).toMatch(UUID_RE);
  });

  it('keeps a valid id even when the file has unusual whitespace and CRLF', async () => {
    await mkdir(idDir, { recursive: true });
    const existing = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    await writeFile(idFile, `# header\r\n\r\n  ${existing}  \r\n`);
    expect(await (await load())()).toBe(existing);
  });

  it('writes a file a human can understand, with the opt-out named', async () => {
    await (
      await load()
    )();
    const content = await readFile(idFile, 'utf8');
    expect(content).toContain('OPA_MCP_NO_TELEMETRY');
    expect(content.split('\n')[0]).toMatch(/^#/);
  });

  it('returns null when the home directory cannot be written, without throwing', async () => {
    // A path that cannot hold a directory: an existing regular file.
    const blocked = join(home, 'blocked');
    await writeFile(blocked, 'not a directory');
    vi.mocked(os.homedir).mockReturnValue(blocked);
    vi.resetModules();
    await expect((await load())()).resolves.toBeNull();
  });
});
