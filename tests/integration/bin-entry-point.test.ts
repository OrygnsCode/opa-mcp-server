/**
 * The built server must run when it is reached through a link.
 *
 * npm's `bin` entry is a symlink on macOS and Linux, so a global install or
 * `npx` reaches `dist/server.js` through one. Node resolves symlinks for a
 * module's own `import.meta.url` but leaves `process.argv[1]` as it was
 * invoked, so comparing those two strings decided the file was not the entry
 * point: nothing ran. `--version` printed nothing, and a client saw a process
 * that started and exited without speaking the protocol.
 *
 * A directory junction stands in for the symlink on Windows, where creating a
 * symlink needs a privilege; both are resolved the same way by Node.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = join(REPO_ROOT, 'dist');

let workDir: string;
let linkedDist: string | undefined;

/** Run the built server, returning what it wrote. */
function runServer(scriptPath: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, OPA_MCP_NO_TELEMETRY: '1' },
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-bin-entry-'));
  const link = join(workDir, 'linked-dist');
  try {
    await symlink(DIST, link, process.platform === 'win32' ? 'junction' : 'dir');
    linkedDist = link;
  } catch {
    linkedDist = undefined;
  }
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('the built server runs when reached through a link', () => {
  it('prints its version by its real path', () => {
    const { status, out } = runServer(join(DIST, 'server.js'), ['--version']);
    expect(status).toBe(0);
    expect(out).toMatch(/opa-mcp v\d+\.\d+\.\d+/);
  }, 60_000);

  it('prints its version through a linked directory, as an npm bin symlink would', (ctx) => {
    if (linkedDist === undefined) {
      // The explicit return is what narrows the type; ctx.skip throws, but
      // the compiler cannot know that.
      ctx.skip('cannot create directory links here');
      return;
    }
    const { status, out } = runServer(join(linkedDist, 'server.js'), ['--version']);
    expect(status).toBe(0);
    // The failure this guards against was silence, not an error.
    expect(out.trim(), 'the server produced no output through the link').not.toBe('');
    expect(out).toMatch(/opa-mcp v\d+\.\d+\.\d+/);
  }, 60_000);

  it('prints help through a linked directory', (ctx) => {
    if (linkedDist === undefined) {
      // The explicit return is what narrows the type; ctx.skip throws, but
      // the compiler cannot know that.
      ctx.skip('cannot create directory links here');
      return;
    }
    const { status, out } = runServer(join(linkedDist, 'server.js'), ['--help']);
    expect(status).toBe(0);
    expect(out).toMatch(/OPA_MCP_ALLOWED_PATHS/);
  }, 60_000);

  it('rejects an unknown flag through a linked directory rather than doing nothing', (ctx) => {
    if (linkedDist === undefined) {
      // The explicit return is what narrows the type; ctx.skip throws, but
      // the compiler cannot know that.
      ctx.skip('cannot create directory links here');
      return;
    }
    const { status, out } = runServer(join(linkedDist, 'server.js'), ['--nope']);
    expect(status).toBe(1);
    expect(out).toMatch(/unknown flag/);
  }, 60_000);

  it('does not run the server when the module is merely imported', async () => {
    // The check must stay strict in the other direction: importing the module
    // from a test must not start a transport.
    const probe = join(workDir, 'probe.mjs');
    const { writeFile } = await import('node:fs/promises');
    const { pathToFileURL } = await import('node:url');
    // A Windows path is not a valid module specifier; a file URL is.
    const spec = JSON.stringify(pathToFileURL(join(DIST, 'server.js')).href);
    await writeFile(probe, `import ${spec};\nconsole.log('imported without starting');\n`);
    const r = spawnSync(process.execPath, [probe], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, OPA_MCP_NO_TELEMETRY: '1' },
    });
    expect(r.stdout).toContain('imported without starting');
  }, 60_000);
});
