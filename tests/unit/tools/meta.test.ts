import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseConfig, callTool, makeServer, spawnSuccess, spawnUnreachable } from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

import { SERVER_NAME, SERVER_VERSION } from '../../../src/constants.js';
import { registerMetaTools } from '../../../src/tools/meta/index.js';

const mockRun = vi.mocked(runBinary);

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── mcp_server_info ──────────────────────────────────────────────────────

describe('mcp_server_info', () => {
  it('returns server name, version, and node version', async () => {
    // opa version call returns a parseable version string
    mockRun.mockResolvedValueOnce(spawnSuccess('OPA 0.69.0\nVersion: 0.69.0\nBuild: ...'));
    // regal version call returns a parseable version string
    mockRun.mockResolvedValueOnce(spawnSuccess('Version: 0.30.0\n'));
    // conftest version call returns a parseable version string
    mockRun.mockResolvedValueOnce(spawnSuccess('conftest (version: 0.68.2)'));

    const server = makeServer();
    registerMetaTools(server, baseConfig);
    const env = await callTool<{
      name: string;
      version: string;
      opaVersion: string | null;
      regalVersion: string | null;
      conftestVersion: string | null;
      transport: string;
      node: string;
    }>(server, 'mcp_server_info', {});

    expect(env.ok).toBe(true);
    expect(env.data?.name).toBe(SERVER_NAME);
    expect(env.data?.version).toBe(SERVER_VERSION);
    expect(env.data?.opaVersion).toBe('0.69.0');
    expect(env.data?.regalVersion).toBe('0.30.0');
    expect(env.data?.conftestVersion).toBe('0.68.2');
    expect(env.data?.transport).toBe('stdio');
    expect(env.data?.node).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('returns null for opaVersion when opa binary is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    mockRun.mockResolvedValueOnce(spawnSuccess('Version: 0.30.0\n'));
    mockRun.mockResolvedValueOnce(spawnSuccess('conftest (version: 0.68.2)'));

    const server = makeServer();
    registerMetaTools(server, baseConfig);
    const env = await callTool<{
      opaVersion: string | null;
      regalVersion: string | null;
      conftestVersion: string | null;
    }>(server, 'mcp_server_info', {});

    expect(env.ok).toBe(true);
    expect(env.data?.opaVersion).toBeNull();
    expect(env.data?.regalVersion).toBe('0.30.0');
    expect(env.data?.conftestVersion).toBe('0.68.2');
  });

  it('returns null for regalVersion when regal binary is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('Version: 0.69.0\n'));
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    mockRun.mockResolvedValueOnce(spawnSuccess('conftest (version: 0.68.2)'));

    const server = makeServer();
    registerMetaTools(server, baseConfig);
    const env = await callTool<{
      opaVersion: string | null;
      regalVersion: string | null;
      conftestVersion: string | null;
    }>(server, 'mcp_server_info', {});

    expect(env.ok).toBe(true);
    expect(env.data?.opaVersion).toBe('0.69.0');
    expect(env.data?.regalVersion).toBeNull();
    expect(env.data?.conftestVersion).toBe('0.68.2');
  });

  it('returns null for conftestVersion when conftest binary is unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('Version: 0.69.0\n'));
    mockRun.mockResolvedValueOnce(spawnSuccess('Version: 0.30.0\n'));
    mockRun.mockResolvedValueOnce(spawnUnreachable());

    const server = makeServer();
    registerMetaTools(server, baseConfig);
    const env = await callTool<{
      opaVersion: string | null;
      regalVersion: string | null;
      conftestVersion: string | null;
    }>(server, 'mcp_server_info', {});

    expect(env.ok).toBe(true);
    expect(env.data?.opaVersion).toBe('0.69.0');
    expect(env.data?.regalVersion).toBe('0.30.0');
    expect(env.data?.conftestVersion).toBeNull();
  });

  it('returns null for all versions when all binaries are unreachable', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    mockRun.mockResolvedValueOnce(spawnUnreachable());

    const server = makeServer();
    registerMetaTools(server, baseConfig);
    const env = await callTool<{
      opaVersion: string | null;
      regalVersion: string | null;
      conftestVersion: string | null;
    }>(server, 'mcp_server_info', {});

    expect(env.ok).toBe(true);
    expect(env.data?.opaVersion).toBeNull();
    expect(env.data?.regalVersion).toBeNull();
    expect(env.data?.conftestVersion).toBeNull();
  });

  it('still succeeds when opa version output has no parseable version', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('unexpected output format'));
    mockRun.mockResolvedValueOnce(spawnSuccess('Version: 0.30.0\n'));
    mockRun.mockResolvedValueOnce(spawnSuccess('conftest (version: 0.68.2)'));

    const server = makeServer();
    registerMetaTools(server, baseConfig);
    const env = await callTool<{ opaVersion: string | null; conftestVersion: string | null }>(
      server,
      'mcp_server_info',
      {},
    );

    expect(env.ok).toBe(true);
    // version() returns null when the output doesn't match the pattern
    expect(env.data?.opaVersion).toBeNull();
    expect(env.data?.conftestVersion).toBe('0.68.2');
  });

  it('still succeeds when conftest version output has no parseable version', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess('Version: 0.69.0\n'));
    mockRun.mockResolvedValueOnce(spawnSuccess('Version: 0.30.0\n'));
    mockRun.mockResolvedValueOnce(spawnSuccess('unexpected output format'));

    const server = makeServer();
    registerMetaTools(server, baseConfig);
    const env = await callTool<{ conftestVersion: string | null }>(server, 'mcp_server_info', {});

    expect(env.ok).toBe(true);
    expect(env.data?.conftestVersion).toBeNull();
  });
});
