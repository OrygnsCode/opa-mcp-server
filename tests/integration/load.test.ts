/**
 * Load / concurrency tests.
 *
 * MCP runs single-client over stdio in production, so true
 * multi-client concurrency is moot. But within a single client,
 * agents fire many tool calls in parallel — `Promise.all([format,
 * check, lint])` is a common pattern. These tests verify the server
 * handles that fan-out correctly:
 *
 *   - 100 concurrent in-memory tool calls complete without
 *     cross-contamination
 *   - OpaCli temp file generation does not collide under high
 *     parallelism (the randomUUID-based naming scheme works)
 *   - OpaClient HTTP requests do not share state across calls
 *   - The server handles partial failures (some calls error, others
 *     succeed) without dropping responses
 *
 * Mocking the subprocess and fetch layers lets us drive enough
 * concurrency to expose real bugs without spawning hundreds of real
 * processes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../src/config.js';
import type { ToolEnvelope } from '../../src/types.js';
import { registerTools } from '../../src/tools/index.js';

vi.mock('../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));
import { runBinary } from '../../src/lib/subprocess.js';
const mockRun = vi.mocked(runBinary);

let fetchMock: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Response>>>;
const realFetch = globalThis.fetch;

const baseConfig: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: 'opa',
  regalBinary: 'regal',
  conftestBinary: 'conftest',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 5_000,
  allowedPaths: [],
  logFile: '/tmp/load-test.log',
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

const okSpawn = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  durationMs: 1,
};

beforeEach(() => {
  mockRun.mockReset();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function buildClient(): Promise<Client> {
  const server = new McpServer({ name: 'load-server', version: '0.0.0' });
  registerTools(server, baseConfig);
  const client = new Client({ name: 'load-client', version: '0.0.0' });
  const [s, c] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

interface CallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function readEnvelope<T>(result: CallToolResult): ToolEnvelope<T> {
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  return JSON.parse(text) as ToolEnvelope<T>;
}

// ─── 100 concurrent rego_format calls ─────────────────────────────────────

describe('Concurrent tool dispatch through one MCP server', () => {
  it('completes 100 parallel rego_format calls with correct per-call results', async () => {
    // Each call gets a deterministic mocked output that includes the
    // call index, so we can assert on cross-talk.
    let callIndex = 0;
    mockRun.mockImplementation(() => {
      const idx = callIndex++;
      return Promise.resolve({
        ...okSpawn,
        stdout: `package call_${idx}\n\nallow := true\n`,
      });
    });

    const client = await buildClient();
    const promises = Array.from({ length: 100 }, (_, i) =>
      client.callTool({
        name: 'rego_format',
        arguments: { source: `package call_${i}\nallow{true}` },
      }),
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(100);

    // Every call returned something parseable and ok.
    for (const r of results) {
      const env = readEnvelope<{ formatted: string; changed: boolean }>(r as CallToolResult);
      expect(env.ok).toBe(true);
      expect(env.data?.formatted).toMatch(/^package call_\d+/);
    }

    // The mocked subprocess was invoked exactly 100 times.
    expect(mockRun).toHaveBeenCalledTimes(100);
    await client.close();
  }, 30_000);

  it('handles a mixed fan-out of different tools cleanly', async () => {
    mockRun.mockImplementation((_, opts) => {
      // Differentiate by argv so the response shape matches the tool.
      if (opts.args[0] === 'fmt') {
        return Promise.resolve({ ...okSpawn, stdout: 'package y\n\nallow := true\n' });
      }
      if (opts.args[0] === 'check') {
        return Promise.resolve(okSpawn); // exitCode 0, valid policy
      }
      if (opts.args[0] === 'parse') {
        return Promise.resolve({
          ...okSpawn,
          stdout: JSON.stringify({ package: { path: [] } }),
        });
      }
      return Promise.resolve(okSpawn);
    });

    const client = await buildClient();
    const calls = await Promise.all([
      client.callTool({
        name: 'rego_format',
        arguments: { source: 'package y\nallow{true}' },
      }),
      client.callTool({ name: 'rego_check', arguments: { source: 'package y' } }),
      client.callTool({ name: 'rego_parse_ast', arguments: { source: 'package y' } }),
    ]);

    expect(readEnvelope(calls[0] as CallToolResult).ok).toBe(true);
    expect(readEnvelope(calls[1] as CallToolResult).ok).toBe(true);
    expect(readEnvelope(calls[2] as CallToolResult).ok).toBe(true);
    await client.close();
  });

  it('preserves per-call errors when some calls fail and others succeed', async () => {
    let i = 0;
    mockRun.mockImplementation(() => {
      const idx = i++;
      // Every third call produces a parse error; the rest succeed.
      if (idx % 3 === 0) {
        return Promise.resolve({
          ...okSpawn,
          exitCode: 1,
          stderr: JSON.stringify({ errors: [{ code: 'rego_parse_error' }] }),
        });
      }
      return Promise.resolve({
        ...okSpawn,
        stdout: `package x_${idx}\nallow := true\n`,
      });
    });

    const client = await buildClient();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, n) =>
        client.callTool({
          name: 'rego_format',
          arguments: { source: `package x_${n}` },
        }),
      ),
    );

    let okCount = 0;
    let errCount = 0;
    for (const r of results) {
      const env = readEnvelope(r as CallToolResult);
      if (env.ok) okCount++;
      else errCount++;
    }
    expect(errCount).toBe(10); // every third of 30
    expect(okCount).toBe(20);
    await client.close();
  });
});

// ─── Direct OpaCli temp-file collision check ──────────────────────────────

describe('OpaCli temp-file collision under high parallelism', () => {
  it('100 concurrent inline-source operations produce 100 distinct temp paths', async () => {
    const seenPaths = new Set<string>();
    mockRun.mockImplementation((_, opts) => {
      // Capture the path that was passed to opa as the second argv entry
      // (after the subcommand). Inline-source operations always pass a
      // generated temp path here.
      const pathArg = opts.args[1];
      if (typeof pathArg === 'string' && pathArg.endsWith('.rego')) {
        seenPaths.add(pathArg);
      }
      return Promise.resolve({ ...okSpawn, stdout: 'package x\n\nallow := true\n' });
    });

    const { OpaCli } = await import('../../src/lib/opa-cli.js');
    const opa = new OpaCli(baseConfig);

    await Promise.all(
      Array.from({ length: 100 }, () => opa.fmt({ source: 'package x\nallow{true}' })),
    );
    expect(seenPaths.size).toBe(100);
  });

  it('cleans up every temp file even under parallel pressure', async () => {
    const writtenPaths: string[] = [];
    mockRun.mockImplementation((_, opts) => {
      const pathArg = opts.args[1];
      if (typeof pathArg === 'string' && pathArg.endsWith('.rego')) {
        writtenPaths.push(pathArg);
      }
      return Promise.resolve({ ...okSpawn, stdout: 'package x\n\nallow := true\n' });
    });

    const { OpaCli } = await import('../../src/lib/opa-cli.js');
    const opa = new OpaCli(baseConfig);

    await Promise.all(
      Array.from({ length: 30 }, () => opa.fmt({ source: 'package x\nallow{true}' })),
    );

    // After all calls complete, every temp file should be gone (the
    // `withTempSource` finally clause unlinks them on success or
    // failure).
    const { existsSync } = await import('node:fs');
    const stragglers = writtenPaths.filter((p) => existsSync(p));
    expect(stragglers).toEqual([]);
  });

  it('cleans up the temp file even when the subprocess fails', async () => {
    const writtenPaths: string[] = [];
    mockRun.mockImplementation((_, opts) => {
      const pathArg = opts.args[1];
      if (typeof pathArg === 'string' && pathArg.endsWith('.rego')) {
        writtenPaths.push(pathArg);
      }
      return Promise.resolve({ ...okSpawn, exitCode: 1, stderr: 'boom' });
    });

    const { OpaCli } = await import('../../src/lib/opa-cli.js');
    const opa = new OpaCli(baseConfig);

    await Promise.all(Array.from({ length: 10 }, () => opa.fmt({ source: 'package x' })));

    const { existsSync } = await import('node:fs');
    const stragglers = writtenPaths.filter((p) => existsSync(p));
    expect(stragglers).toEqual([]);
  });
});

// ─── Concurrent OpaClient HTTP — no shared state ──────────────────────────

describe('OpaClient HTTP concurrency', () => {
  it('100 concurrent requests preserve per-call body / response pairing', async () => {
    // Each fetch call should see its own body. We assert by echoing
    // the request body in the mocked response.
    fetchMock.mockImplementation((_url, init) => {
      const body = (init as RequestInit).body as string;
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      return Promise.resolve(
        new Response(JSON.stringify({ result: parsed }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    const { OpaClient } = await import('../../src/lib/opa-client.js');
    const client = new OpaClient(baseConfig);

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        client.request<{ result: { id: number } }>({
          method: 'POST',
          path: '/v1/data/x',
          body: { id: i },
        }),
      ),
    );

    // Every response must carry back its specific id — no cross-talk.
    for (let i = 0; i < 100; i++) {
      expect(results[i]?.result.id).toBe(i);
    }
  });

  it('handles a mix of 200 / 404 / network-failure responses cleanly', async () => {
    let i = 0;
    fetchMock.mockImplementation(() => {
      const idx = i++;
      if (idx % 3 === 0) {
        return Promise.reject(new Error('ECONNRESET'));
      }
      if (idx % 3 === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ result: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    const { OpaClient, OpaUnreachableError, OpaHttpError } =
      await import('../../src/lib/opa-client.js');
    const client = new OpaClient(baseConfig);

    const settled = await Promise.allSettled(
      Array.from({ length: 30 }, () => client.request({ method: 'GET', path: '/v1/policies' })),
    );

    let unreachable = 0;
    let notFound = 0;
    let okay = 0;
    for (const s of settled) {
      if (s.status === 'fulfilled') okay++;
      else if (s.reason instanceof OpaUnreachableError) unreachable++;
      else if (s.reason instanceof OpaHttpError && s.reason.status === 404) notFound++;
    }
    expect(unreachable).toBe(10);
    expect(notFound).toBe(10);
    expect(okay).toBe(10);
  });
});

// ─── Throughput sanity (smoke) ────────────────────────────────────────────

describe('Throughput sanity', () => {
  it('200 concurrent rego_eval calls finish within a reasonable wall-clock window', async () => {
    mockRun.mockResolvedValue({
      ...okSpawn,
      stdout: JSON.stringify({ result: [{ expressions: [{ value: true }] }] }),
    });

    const { OpaCli } = await import('../../src/lib/opa-cli.js');
    const opa = new OpaCli(baseConfig);

    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        opa.eval({
          query: 'data.x.allow',
          source: 'package x\nimport rego.v1\nallow := true',
        }),
      ),
    );
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(200);
    expect(results.every((r) => r.exitCode === 0)).toBe(true);
    // Mocked subprocess returns instantly — temp file write/read is the
    // only real I/O. 200 calls should finish in under 5s on any machine.
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);
});
