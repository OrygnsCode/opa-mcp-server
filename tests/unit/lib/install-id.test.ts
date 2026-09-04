import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs/promises');
vi.mock('node:os');

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

const FAKE_HOME = '/fake/home';
const FAKE_ID_FILE = join(FAKE_HOME, '.orygn', 'opa-mcp', 'install-id');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  vi.resetModules();
  mockOs.homedir.mockReturnValue(FAKE_HOME);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function load() {
  const { getInstallId } = await import('../../../src/lib/install-id.js');
  return getInstallId;
}

describe('getInstallId()', () => {
  it('returns a UUID from an existing file', async () => {
    const existingId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    mockFs.readFile.mockResolvedValueOnce(`# opa-mcp install ID\n#\n# comment\n\n${existingId}\n`);
    const getInstallId = await load();
    const result = await getInstallId();
    expect(result).toBe(existingId);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('creates the file with a UUID and header comment on first run', async () => {
    // First readFile throws (file not found).
    mockFs.readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFs.mkdir.mockResolvedValueOnce(undefined);
    mockFs.writeFile.mockResolvedValueOnce(undefined);

    const getInstallId = await load();
    const result = await getInstallId();

    expect(result).toMatch(UUID_RE);
    expect(mockFs.mkdir).toHaveBeenCalledWith(expect.stringContaining('.orygn'), {
      recursive: true,
    });
    const [path, content] = mockFs.writeFile.mock.calls[0]!;
    expect(path).toBe(FAKE_ID_FILE);
    expect(typeof content).toBe('string');
    expect(content as string).toContain('# opa-mcp install ID');
    expect(content as string).toContain('OPA_MCP_NO_TELEMETRY');
    expect(content as string).toContain(result!);
  });

  it('handles a race condition: wx write fails, reads the file another process created', async () => {
    const racedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    // First read fails (file not found).
    mockFs.readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFs.mkdir.mockResolvedValueOnce(undefined);
    // wx write fails (other process created the file first).
    mockFs.writeFile.mockRejectedValueOnce(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }));
    // Second read succeeds with the other process's UUID.
    mockFs.readFile.mockResolvedValueOnce(`# comment\n\n${racedId}\n`);

    const getInstallId = await load();
    const result = await getInstallId();

    expect(result).toBe(racedId);
  });

  it('returns null when the file cannot be created and the fallback read also fails', async () => {
    mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockFs.mkdir.mockResolvedValueOnce(undefined);
    mockFs.writeFile.mockRejectedValueOnce(new Error('EROFS'));

    const getInstallId = await load();
    const result = await getInstallId();

    expect(result).toBeNull();
  });

  it('creates a brand-new file exclusively, so two first runs cannot both claim it', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValueOnce(enoent);
    mockFs.mkdir.mockResolvedValueOnce(undefined);
    mockFs.writeFile.mockResolvedValueOnce(undefined);

    const getInstallId = await load();
    await getInstallId();

    expect(mockFs.writeFile).toHaveBeenCalledWith(FAKE_ID_FILE, expect.any(String), { flag: 'wx' });
  });

  it('repairs an empty file instead of failing forever on the exclusive flag', async () => {
    // A zero-byte file (crash or full disk during first run) used to be a
    // permanent trap: `wx` failed because the file existed, the fallback read
    // found no id, and the install pinged without one on every start.
    mockFs.readFile.mockResolvedValueOnce('');
    mockFs.mkdir.mockResolvedValueOnce(undefined);
    mockFs.writeFile.mockResolvedValueOnce(undefined);

    const getInstallId = await load();
    const result = await getInstallId();

    expect(result).toMatch(UUID_RE);
    expect(mockFs.writeFile).toHaveBeenCalledWith(FAKE_ID_FILE, expect.any(String), { flag: 'w' });
    // The id it returns is the one it wrote. Call history is shared across
    // tests in this file, so take this test's own call.
    const written = mockFs.writeFile.mock.calls.at(-1)![1] as string;
    expect(written).toContain(result!);
  });

  it('repairs a file that holds only comments', async () => {
    mockFs.readFile.mockResolvedValueOnce('# opa-mcp install ID\n#\n');
    mockFs.mkdir.mockResolvedValueOnce(undefined);
    mockFs.writeFile.mockResolvedValueOnce(undefined);

    const getInstallId = await load();
    expect(await getInstallId()).toMatch(UUID_RE);
    expect(mockFs.writeFile).toHaveBeenCalledWith(FAKE_ID_FILE, expect.any(String), { flag: 'w' });
  });

  it('ignores lines that are not valid UUIDs and returns null for a corrupt file', async () => {
    mockFs.readFile.mockResolvedValueOnce('# comment\nnot-a-uuid\n');
    // writeFile will succeed for the re-creation attempt
    mockFs.mkdir.mockResolvedValueOnce(undefined);
    mockFs.writeFile.mockResolvedValueOnce(undefined);

    const getInstallId = await load();
    const result = await getInstallId();

    // A new UUID is generated since the file had no valid UUID.
    expect(result).toMatch(UUID_RE);
  });
});
