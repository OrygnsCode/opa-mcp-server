import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  baseConfig,
  callTool,
  fixturePath,
  makeServer,
  spawnFailure,
  spawnSuccess,
  spawnUnreachable,
} from './_helpers.js';

vi.mock('../../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));

import { runBinary } from '../../../src/lib/subprocess.js';

import { registerBundleTools } from '../../../src/tools/bundles/index.js';

const mockRun = vi.mocked(runBinary);

let workDir: string;
let outputBundle: string;

beforeAll(async () => {
  workDir = join(tmpdir(), `orygn-bundle-tests-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  mockRun.mockReset();
  // The build tool reads the produced bundle's size after a successful
  // build; mocked subprocess won't write the file, so we pre-create it
  // wherever a happy-path test points.
  outputBundle = join(workDir, `bundle-${Math.random().toString(36).slice(2)}.tar.gz`);
  await writeFile(outputBundle, 'fake bundle bytes', 'utf8');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('opa_bundle_build', () => {
  it('builds with the expected argv and reports the output bytes', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    // Allow both the source dir and the output bundle path.
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool<{ output: string; bytes: number }>(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
      revision: 'rev-1',
      optimize: 1,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.output).toBe(outputBundle);
    expect(env.data?.bytes).toBeGreaterThan(0);

    const args = mockRun.mock.calls[0]![1].args;
    expect(args[0]).toBe('build');
    expect(args).toContain('-o');
    expect(args).toContain(outputBundle);
    expect(args).toContain('--revision');
    expect(args).toContain('rev-1');
    expect(args).toContain('--optimize');
    expect(args).toContain('1');
    expect(args).toContain(fixturePath('policies', 'valid'));
  });

  it('passes target=wasm and entrypoints when set', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
      target: 'wasm',
      entrypoints: ['rbac/allow', 'rbac/deny_reasons'],
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--target');
    expect(args).toContain('wasm');
    const entryIdxs = args
      .map((a, i) => (a === '--entrypoint' ? i : -1))
      .filter((i) => i !== -1);
    expect(entryIdxs).toHaveLength(2);
    expect(args[entryIdxs[0]! + 1]).toBe('rbac/allow');
  });

  it('rejects source paths outside allowed roots', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_build', {
      paths: ['/outside/policies'],
      output: outputBundle,
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects output path outside allowed roots', async () => {
    const server = makeServer();
    registerBundleTools(server, baseConfig); // Does not allow workDir.
    const env = await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('maps non-zero exit to INVALID_REGO', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'invalid bundle source'));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
    });
    expect(env.error?.code).toBe('INVALID_REGO');
  });

  it('maps missing binary to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
    });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });
});

describe('opa_bundle_sign', () => {
  let signingKey: string;

  beforeEach(async () => {
    signingKey = join(workDir, 'signing.key');
    await writeFile(signingKey, '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----');
  });

  it('signs with the provided key and reports success', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool<{ signed: boolean }>(server, 'opa_bundle_sign', {
      bundle: outputBundle,
      signingKey,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.signed).toBe(true);
    const args = mockRun.mock.calls[0]![1].args;
    expect(args[0]).toBe('sign');
    expect(args).toContain('--signing-key');
    expect(args).toContain(signingKey);
    expect(args).toContain('--bundle');
    expect(args).toContain(outputBundle);
  });

  it('rejects bundle path outside allowed roots', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_sign', {
      bundle: '/outside/bundle.tar.gz',
      signingKey,
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('maps non-zero exit to INVALID_BUNDLE', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'sign failed'));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_sign', {
      bundle: outputBundle,
      signingKey,
    });
    expect(env.error?.code).toBe('INVALID_BUNDLE');
  });
});
