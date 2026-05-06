/**
 * Tests for src/server.ts.
 *
 * The boot flow is hard to cover via the regular per-tool unit tests
 * because the entry-point file does its work at module import. Phase 5
 * exercises the *built* dist/server.js end-to-end, but v8 coverage
 * only counts code reached through src/. These tests drive the
 * exported buildServer() and main() functions directly so the source
 * file gets credit AND the boot wiring is unit-tested independently
 * of the SDK transport layer.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { Config } from '../../src/config.js';
import {
  buildServer,
  main,
  SERVER_NAME,
  SERVER_VERSION,
} from '../../src/server.js';

const ENV_KEYS = [
  'OPA_URL',
  'OPA_TOKEN',
  'OPA_BINARY',
  'REGAL_BINARY',
  'OPA_MCP_TIMEOUT_MS',
  'OPA_MCP_HTTP_TIMEOUT_MS',
  'OPA_MCP_ALLOWED_PATHS',
  'OPA_MCP_LOG_FILE',
  'OPA_MCP_LOG_LEVEL',
  'OPA_MCP_MAX_RESPONSE_BYTES',
] as const;

let savedEnv: Record<string, string | undefined>;

const baseConfig: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: 'opa',
  regalBinary: 'regal',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-opa-mcp-server-test.log'),
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Make loadConfig() inside main() use a known log file path that
  // the file-only logger can actually write to.
  process.env['OPA_MCP_LOG_FILE'] = baseConfig.logFile;
  process.env['OPA_MCP_LOG_LEVEL'] = 'error';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('buildServer()', () => {
  it('exports the canonical server name and version', () => {
    expect(SERVER_NAME).toBe('orygn-opa-mcp');
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('registers every tool, prompt, and resource expected at v0.1.0', () => {
    const server = buildServer(baseConfig);
    interface Registry {
      _registeredTools: Record<string, unknown>;
      _registeredPrompts: Record<string, unknown>;
      _registeredResources: Record<string, unknown>;
    }
    const registry = server as unknown as Registry;
    expect(Object.keys(registry._registeredTools)).toHaveLength(32);
    expect(Object.keys(registry._registeredPrompts)).toHaveLength(3);
    expect(Object.keys(registry._registeredResources)).toHaveLength(3);
  });

  it('initializes the file logger so log writes do not crash', () => {
    expect(() => buildServer(baseConfig)).not.toThrow();
  });
});

describe('main()', () => {
  it('connects to a supplied transport and resolves with the server', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const serverPromise = main(serverTransport);
    const client = new Client({ name: 'main-test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    const server = await serverPromise;

    // The returned server is connected and serves real protocol traffic.
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    await client.close();
    void server;
  });

  it('reads configuration from environment variables', async () => {
    process.env['OPA_URL'] = 'http://test.example.com:9999';
    process.env['OPA_BINARY'] = '/custom/opa';

    const [s, c] = InMemoryTransport.createLinkedPair();
    const promise = main(s);
    const client = new Client({ name: 'env-test', version: '0.0.0' });
    await client.connect(c);
    await promise;

    // Confirm the server actually wired up tools (sanity check that
    // env-derived config did not throw).
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(32);
    await client.close();
  });

  it('propagates errors from invalid configuration via process.exit', async () => {
    process.env['OPA_URL'] = 'not-a-url';

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => {
        throw new Error('process.exit called');
      }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const [s] = InMemoryTransport.createLinkedPair();
    await expect(main(s)).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
