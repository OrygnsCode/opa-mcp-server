/**
 * Persistent install ID for anonymous telemetry.
 *
 * On first run, generates a random UUID and writes it to
 * ~/.orygn/opa-mcp/install-id alongside a plain-English comment
 * explaining what the file is. Subsequent runs read it back.
 *
 * Returns null if the home directory is unwritable (read-only
 * containers, CI) -- the ping still fires without a UUID in that case.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const INSTALL_ID_DIR = join(homedir(), '.orygn', 'opa-mcp');
const INSTALL_ID_FILE = join(INSTALL_ID_DIR, 'install-id');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILE_HEADER = [
  '# opa-mcp install ID',
  '#',
  '# This file was created by @orygn/opa-mcp on first run.',
  '# It holds a randomly generated ID used only to count unique installs.',
  '# No personal information is attached to it. The ID is sent alongside',
  '# the server version and OS platform in the anonymous startup ping.',
  '#',
  '# To opt out of all telemetry: set OPA_MCP_NO_TELEMETRY=1',
  '#',
  '',
].join('\n');

function parseId(content: string): string | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && UUID_RE.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Return the persistent install ID for this machine, creating it on
 * first run. Returns null on any filesystem error so callers never
 * have to handle it.
 */
export async function getInstallId(): Promise<string | null> {
  // Try reading an existing file first.
  let unusableFileExists = false;
  try {
    const content = await readFile(INSTALL_ID_FILE, 'utf8');
    const id = parseId(content);
    if (id) return id;
    // The file is there but holds no id: truncated by a crash or a full
    // disk, or a first run interrupted between create and write.
    unusableFileExists = true;
  } catch {
    // File not found yet -- fall through to create.
  }

  const id = randomUUID();
  try {
    await mkdir(INSTALL_ID_DIR, { recursive: true });
    // `wx` (fail if exists) when the file is absent, so two processes
    // starting at once cannot both claim to have created it.
    //
    // `w` when the file exists but is unusable, so it can be repaired. With
    // `wx` unconditionally a zero-byte file was permanent: the read found no
    // id, the exclusive write failed because the file existed, the fallback
    // read found no id again, and every later run repeated that. The install
    // then pinged without an id forever, was never counted as an install, and
    // cost the collector six writes per start instead of one read. Two
    // processes repairing at once may write different ids and one wins, which
    // over-counts a single install once; that is the cheaper failure.
    await writeFile(INSTALL_ID_FILE, FILE_HEADER + id + '\n', {
      flag: unusableFileExists ? 'w' : 'wx',
    });
    return id;
  } catch {
    // Race: another process created the file between our read and write.
    // Try reading it one more time before giving up.
    try {
      const content = await readFile(INSTALL_ID_FILE, 'utf8');
      return parseId(content);
    } catch {
      return null;
    }
  }
}
