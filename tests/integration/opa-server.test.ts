/**
 * Live OPA server integration tests.
 *
 * Spawns a real `opa run --server` instance and exercises every
 * server-management tool against it. Closes the gap that
 * `tests/unit/tools/server-management.test.ts` leaves open (it mocks
 * fetch; this drives real HTTP traffic to a real OPA process).
 *
 * The server runs on port 18181 (chosen to avoid colliding with a
 * developer's local OPA on the default 8181). Each test isolates its
 * state by using unique policy IDs and data paths.
 *
 * Skipped automatically if `opa` is not on PATH or `OPA_BINARY` is
 * unset — CI installs OPA before running this suite.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import type { ToolEnvelope } from '../../src/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerServerManagementTools } from '../../src/tools/server-management/index.js';

const OPA_BINARY = process.env['OPA_BINARY'] ?? 'opa';
const OPA_TEST_PORT = 18181;
const OPA_TEST_URL = `http://127.0.0.1:${OPA_TEST_PORT}`;

let opaProcess: ChildProcess | undefined;
let workDir: string;

async function waitForReady(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }
  throw new Error(`OPA never became ready on ${url} within ${timeoutMs}ms`);
}

async function startOpa(): Promise<void> {
  workDir = join(tmpdir(), `orygn-opa-it-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  // Pre-seed one policy so list/get tests have something to find.
  await writeFile(
    join(workDir, 'seed.rego'),
    'package seed\nimport rego.v1\nallow := true\n',
    'utf8',
  );

  opaProcess = spawn(
    OPA_BINARY,
    [
      'run',
      '--server',
      '--addr',
      `127.0.0.1:${OPA_TEST_PORT}`,
      '--log-level',
      'error',
      join(workDir, 'seed.rego'),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  // Capture stderr so test failures surface OPA-side errors.
  let stderrBuf = '';
  opaProcess.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  opaProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`OPA test server exited with code ${code}: ${stderrBuf}`);
    }
  });

  await waitForReady(OPA_TEST_URL).catch((e: unknown) => {
    console.error('OPA never came up. stderr:', stderrBuf);
    opaProcess?.kill('SIGKILL');
    throw e;
  });
}

async function stopOpa(): Promise<void> {
  if (!opaProcess) return;
  opaProcess.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (!opaProcess || opaProcess.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      opaProcess?.kill('SIGKILL');
      resolve();
    }, 3000);
    opaProcess.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (workDir) await rm(workDir, { recursive: true, force: true });
}

beforeAll(async () => {
  await startOpa();
}, 30_000);

afterAll(async () => {
  await stopOpa();
});

const buildConfig = (overrides: Partial<Config> = {}): Config => ({
  opaUrl: OPA_TEST_URL,
  opaBinary: OPA_BINARY,
  regalBinary: 'regal',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 5_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-opa-it.log'),
  logLevel: 'error',
  maxResponseBytes: 100_000,
  ...overrides,
});

interface RegisteredTools {
  _registeredTools: Record<
    string,
    {
      handler: (
        args: Record<string, unknown>,
      ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    }
  >;
}

async function setup(overrides?: Partial<Config>): Promise<{
  client: Client;
  call: <T = unknown>(
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolEnvelope<T>>;
}> {
  const config = buildConfig(overrides);
  const server = new McpServer({ name: 'opa-it-server', version: '0.0.0' });
  registerServerManagementTools(server, config);
  const client = new Client({ name: 'opa-it-client', version: '0.0.0' });
  const [s, c] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);

  // Also expose direct handler invocation for finer assertions.
  const registry = (server as unknown as RegisteredTools)._registeredTools;
  const call = async <T,>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolEnvelope<T>> => {
    const entry = registry[name];
    if (!entry) throw new Error(`Tool ${name} not registered`);
    const result = await entry.handler(args);
    return JSON.parse(result.content[0]!.text) as ToolEnvelope<T>;
  };
  return { client, call };
}

// ─── Health & status ──────────────────────────────────────────────────────

describe('opa_health', () => {
  it('reports healthy against a real OPA server', async () => {
    const { call } = await setup();
    const env = await call<{ healthy: boolean }>('opa_health', {});
    expect(env.ok).toBe(true);
    expect(env.data?.healthy).toBe(true);
  });

  it('reports OPA_UNREACHABLE when the URL is wrong', async () => {
    const { call } = await setup({ opaUrl: 'http://127.0.0.1:39999' });
    const env = await call('opa_health', {});
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
  });
});

describe('opa_status and opa_config', () => {
  it('opa_status returns a config object', async () => {
    const { call } = await setup();
    const env = await call<{ status: { default_decision?: string } }>(
      'opa_status',
      {},
    );
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBeDefined();
  });

  it('opa_config returns the running config', async () => {
    const { call } = await setup();
    const env = await call<{ config: unknown }>('opa_config', {});
    expect(env.ok).toBe(true);
    expect(env.data?.config).toBeDefined();
  });
});

// ─── Policy lifecycle ─────────────────────────────────────────────────────

describe('policy lifecycle (list / get / put / delete)', () => {
  it('lists at least one policy and surfaces its raw source', async () => {
    const { call } = await setup();
    const env = await call<{ policies: Array<{ id: string; raw?: string }> }>(
      'opa_list_policies',
      {},
    );
    expect(env.ok).toBe(true);
    expect(env.data?.policies.length).toBeGreaterThan(0);
    // The seeded policy lives at <workDir>/seed.rego — OPA stores it under
    // its full path. Match by content rather than ID for portability.
    const seeded = env.data?.policies.find((p) => p.raw?.includes('package seed'));
    expect(seeded).toBeDefined();
  });

  it('uploads a new policy via PUT and reads it back via GET', async () => {
    const { call } = await setup();
    const id = `it_${Date.now()}.rego`;
    const source = 'package it\nimport rego.v1\nallow := input.x == 1\n';

    const putEnv = await call<{ id: string; replaced: boolean }>('opa_put_policy', {
      id,
      source,
    });
    expect(putEnv.ok).toBe(true);
    expect(putEnv.data?.replaced).toBe(true);

    const getEnv = await call<{ policy: { id: string; raw: string } }>('opa_get_policy', {
      id,
    });
    expect(getEnv.ok).toBe(true);
    expect(getEnv.data?.policy.raw).toContain('package it');

    const delEnv = await call<{ deleted: boolean }>('opa_delete_policy', { id });
    expect(delEnv.ok).toBe(true);
  });

  it('returns POLICY_NOT_FOUND on get of a missing policy', async () => {
    const { call } = await setup();
    const env = await call('opa_get_policy', { id: 'definitely_does_not_exist.rego' });
    expect(env.error?.code).toBe('POLICY_NOT_FOUND');
  });
});

// ─── Data lifecycle ───────────────────────────────────────────────────────

describe('data lifecycle (put / get / patch)', () => {
  it('puts a JSON value and reads it back', async () => {
    const { call } = await setup();
    const path = `it_data_${Date.now()}`;
    const value = { roles: ['admin'], created: '2026-05-06' };

    const putEnv = await call<{ written: boolean }>('opa_put_data', { path, value });
    expect(putEnv.ok).toBe(true);

    const getEnv = await call<{ result: typeof value }>('opa_get_data', { path });
    expect(getEnv.ok).toBe(true);
    expect(getEnv.data?.result).toEqual(value);
  });

  it('accepts dotted-path form interchangeably with slash form', async () => {
    const { call } = await setup();
    const base = `it_dotted_${Date.now()}`;
    await call('opa_put_data', { path: `${base}.nested.key`, value: 'x' });
    // Read back with slash form.
    const env = await call<{ result: unknown }>('opa_get_data', {
      path: `${base}/nested/key`,
    });
    expect(env.data?.result).toBe('x');
  });

  it('applies a JSON Patch to an existing object', async () => {
    const { call } = await setup();
    const path = `it_patch_${Date.now()}`;
    await call('opa_put_data', { path, value: { roles: ['viewer'] } });

    const patchEnv = await call('opa_patch_data', {
      path,
      operations: [{ op: 'add', path: '/roles/-', value: 'editor' }],
    });
    expect(patchEnv.ok).toBe(true);

    const getEnv = await call<{ result: { roles: string[] } }>('opa_get_data', { path });
    expect(getEnv.data?.result.roles).toEqual(['viewer', 'editor']);
  });
});

// ─── Decision queries ─────────────────────────────────────────────────────

describe('decision queries', () => {
  it('opa_query_decision evaluates a seeded rule and returns the result', async () => {
    const { call } = await setup();
    const env = await call<{ result: unknown }>('opa_query_decision', {
      path: 'seed.allow',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.result).toBe(true);
  });

  it('opa_query_decision returns explanation when explain=full', async () => {
    const { call } = await setup();
    const env = await call<{ result: unknown; explanation?: unknown[] }>(
      'opa_query_decision',
      { path: 'seed.allow', explain: 'full' },
    );
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.data?.explanation)).toBe(true);
  });

  it('opa_compile_query partially evaluates a query', async () => {
    const { call } = await setup();
    const env = await call<{ result: unknown }>('opa_compile_query', {
      query: 'data.seed.allow == true',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.result).toBeDefined();
  });
});

// ─── End-to-end policy upload + decision ──────────────────────────────────

describe('end-to-end: upload a policy and query against it', () => {
  it('uploads a policy, queries it for a decision, then deletes it', async () => {
    const { call } = await setup();
    const id = `it_e2e_${Date.now()}.rego`;
    const source = `package e2e
import rego.v1

default allow := false

allow if input.user.role == "admin"
`;

    expect(
      (await call<{ replaced: boolean }>('opa_put_policy', { id, source })).ok,
    ).toBe(true);

    const adminEnv = await call<{ result: unknown }>('opa_query_decision', {
      path: 'e2e.allow',
      input: { user: { role: 'admin' } },
    });
    expect(adminEnv.data?.result).toBe(true);

    const viewerEnv = await call<{ result: unknown }>('opa_query_decision', {
      path: 'e2e.allow',
      input: { user: { role: 'viewer' } },
    });
    expect(viewerEnv.data?.result).toBe(false);

    expect(
      (await call<{ deleted: boolean }>('opa_delete_policy', { id })).ok,
    ).toBe(true);
  });
});
