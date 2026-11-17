/**
 * The built server, started with no OPA_MCP_ALLOWED_PATHS, takes its allowed
 * folders from a client that shares MCP roots, and runs the real opa in them.
 *
 * Goes over stdio to `dist/server.js`, as Claude Code and VS Code do, so the
 * handshake ordering (initialize, then `initialized`, then the server's
 * `roots/list`) is the real one rather than the in-memory transport's.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DIST_SERVER = join(REPO_ROOT, 'dist', 'server.js');

const POLICY = `package roots.demo

default allow := false

allow if input.user == "alice"
`;

const POLICY_TEST = `package roots.demo_test

import data.roots.demo

test_alice if demo.allow with input as {"user": "alice"}

test_bob if not demo.allow with input as {"user": "bob"}
`;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string };
}

let scratch: string;
let shared: string;
let other: string;
let logFile: string;
let client: Client;
let roots: string[];

async function call<T>(name: string, args: Record<string, unknown>): Promise<Envelope<T>> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Envelope<T>;
}

beforeAll(async () => {
  expect(existsSync(DIST_SERVER), 'run `npm run build` first').toBe(true);
  scratch = mkdtempSync(join(tmpdir(), 'opa-mcp-roots-int-'));
  shared = mkdtempSync(join(scratch, 'shared-'));
  other = mkdtempSync(join(scratch, 'other-'));
  for (const dir of [shared, other]) {
    writeFileSync(join(dir, 'policy.rego'), POLICY);
    writeFileSync(join(dir, 'policy_test.rego'), POLICY_TEST);
  }
  logFile = join(scratch, 'server.log');
  roots = [shared];

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env['OPA_MCP_ALLOWED_PATHS'];
  env['OPA_MCP_LOG_FILE'] = logFile;
  env['OPA_MCP_LOG_LEVEL'] = 'info';
  env['OPA_MCP_NO_TELEMETRY'] = '1';

  client = new Client(
    { name: 'roots-integration', version: '0.0.0' },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: roots.map((p) => ({ uri: pathToFileURL(p).href })),
  }));
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [DIST_SERVER], env }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('client roots over stdio with the real opa', () => {
  it('runs the tests in a shared folder on the first call after connecting', async () => {
    const r = await call<{ passed: number; failed: number; allPassed?: boolean }>('rego_test', {
      paths: [shared],
    });
    expect(r.error).toBeUndefined();
    expect(r.data?.passed).toBe(2);
    expect(r.data?.failed).toBe(0);
    expect(r.data?.allPassed).toBe(true);
  });

  it('refuses a folder the client did not share', async () => {
    const r = await call('rego_test', { paths: [other] });
    expect(r.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('reports the roots and where they came from', async () => {
    const r = await call<{ allowedPaths: string[]; allowedPathsSource: string }>(
      'mcp_server_info',
      {},
    );
    expect(r.data?.allowedPathsSource).toBe('client-roots');
    expect(r.data?.allowedPaths).toEqual([shared]);
  });

  it('follows the client when its roots change', async () => {
    roots = [other];
    await client.sendRootsListChanged();
    const now = await call<{ passed: number }>('rego_test', { paths: [other] });
    expect(now.data?.passed).toBe(2);
    const before = await call('rego_test', { paths: [shared] });
    expect(before.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('logs the roots it was given', () => {
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('using client roots as allowed paths');
  });
});
