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
