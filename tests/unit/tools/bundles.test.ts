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
  spawnTimedOut,
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
    const entryIdxs = args.map((a, i) => (a === '--entrypoint' ? i : -1)).filter((i) => i !== -1);
    expect(entryIdxs).toHaveLength(2);
    expect(args[entryIdxs[0]! + 1]).toBe('rbac/allow');
  });

  it('passes bundle, pruneUnused, v1Compatible, and ignore flags', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
      bundle: true,
      pruneUnused: true,
      v1Compatible: true,
      ignore: ['.*', 'testdata'],
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--bundle');
    expect(args).toContain('--prune-unused');
    expect(args).toContain('--v1-compatible');
    const ignoreIdxs = args.map((a, i) => (a === '--ignore' ? i : -1)).filter((i) => i !== -1);
    expect(ignoreIdxs).toHaveLength(2);
    expect(args[ignoreIdxs[0]! + 1]).toBe('.*');
    expect(args[ignoreIdxs[1]! + 1]).toBe('testdata');
  });

  it('validates verificationKey and passes --verification-key/-id', async () => {
    const keyPath = join(workDir, 'pub.pem');
    await writeFile(keyPath, '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n', 'utf8');
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
      bundle: true,
      verificationKey: keyPath,
      verificationKeyId: 'my-key',
    });
    const args = mockRun.mock.calls[0]![1].args;
    const vkIdx = args.indexOf('--verification-key');
    expect(vkIdx).toBeGreaterThan(-1);
    expect(args[vkIdx + 1]).toMatch(/pub\.pem$/);
    expect(args).toContain('--verification-key-id');
    expect(args[args.indexOf('--verification-key-id') + 1]).toBe('my-key');
  });

  it('rejects a verificationKey outside allowed roots', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
      verificationKey: '/outside/pub.pem',
    });
    expect(env.ok).toBe(false);
    expect(['PATH_NOT_ALLOWED', 'PATH_NOT_FOUND']).toContain(env.error?.code);
    expect(mockRun).not.toHaveBeenCalled();
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

  it('rejects auxiliary signingKey path outside the allow-list', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
      signingKey: '/outside/key.pem',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects claimsFile outside the allow-list', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
      claimsFile: '/outside/claims.json',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects capabilities outside the allow-list', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
      capabilities: '/outside/caps.json',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
  });

  it('passes resolved (absolute) paths for signingKey and claimsFile to opa build', async () => {
    const signingKey = join(workDir, 'build-key.pem');
    const claimsFile = join(workDir, 'build-claims.json');
    await writeFile(signingKey, 'fake key');
    await writeFile(claimsFile, '{}');
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    await callTool(server, 'opa_bundle_build', {
      paths: [fixturePath('policies', 'valid')],
      output: outputBundle,
      signingKey,
      claimsFile,
    });
    const args = mockRun.mock.calls[0]![1].args;
    // Verify the resolved (real) paths appear in argv -- not some unresolved variant.
    const skIdx = args.indexOf('--signing-key');
    expect(skIdx).toBeGreaterThan(-1);
    expect(args[skIdx + 1]).toBe(signingKey);
    const cfIdx = args.indexOf('--claims-file');
    expect(cfIdx).toBeGreaterThan(-1);
    expect(args[cfIdx + 1]).toBe(claimsFile);
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

  it('passes signingAlg and claimsFile through to opa sign', async () => {
    const claimsFile = join(workDir, 'claims.json');
    await writeFile(claimsFile, '{"keyid":"k1"}');
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    await callTool(server, 'opa_bundle_sign', {
      bundle: outputBundle,
      signingKey,
      signingAlg: 'RS256',
      claimsFile,
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--signing-alg');
    expect(args).toContain('RS256');
    expect(args).toContain('--claims-file');
    expect(args).toContain(claimsFile);
  });

  it('maps missing binary to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_sign', {
      bundle: outputBundle,
      signingKey,
    });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });
});

describe('opa_bundle_verify', () => {
  let publicKey: string;

  beforeEach(async () => {
    publicKey = join(workDir, `verify-key-${Math.random().toString(36).slice(2)}.pem`);
    await writeFile(
      publicKey,
      '-----BEGIN PUBLIC KEY-----\nfakepublickey\n-----END PUBLIC KEY-----',
    );
  });

  it('issues correct argv and returns { bundle, verified: true } on success', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool<{ bundle: string; verified: boolean }>(server, 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.bundle).toBe(outputBundle);
    expect(env.data?.verified).toBe(true);

    const args = mockRun.mock.calls[0]![1].args;
    expect(args[0]).toBe('eval');
    expect(args).toContain('--bundle');
    const bundleIdx = args.indexOf('--bundle');
    expect(args[bundleIdx + 1]).toBe(outputBundle);
    expect(args).toContain('--verification-key');
    const keyIdx = args.indexOf('--verification-key');
    expect(args[keyIdx + 1]).toBe(publicKey);
    // The trivial query must be the final arg so OPA exits after verification.
    expect(args[args.length - 1]).toBe('true');
  });

  it('passes optional verificationKeyId, signingAlg, and scope through to opa', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    await callTool(server, 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
      verificationKeyId: 'key-v1',
      signingAlg: 'PS256',
      scope: 'read',
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).toContain('--verification-key-id');
    expect(args[args.indexOf('--verification-key-id') + 1]).toBe('key-v1');
    expect(args).toContain('--signing-alg');
    expect(args[args.indexOf('--signing-alg') + 1]).toBe('PS256');
    expect(args).toContain('--scope');
    expect(args[args.indexOf('--scope') + 1]).toBe('read');
  });

  it('omits optional flags when they are not provided', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    await callTool(server, 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).not.toContain('--verification-key-id');
    expect(args).not.toContain('--signing-alg');
    expect(args).not.toContain('--scope');
  });

  it('rejects a bundle path outside the allow-list without calling opa', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_verify', {
      bundle: '/outside/signed.tar.gz',
      verificationKey: publicKey,
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects a verificationKey path outside the allow-list without calling opa', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: '/outside/public.pem',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('maps non-zero exit to INVALID_BUNDLE and surfaces stderr in details', async () => {
    const errMsg = 'bundle signature verification failed: invalid signature';
    mockRun.mockResolvedValueOnce(spawnFailure(1, errMsg));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_BUNDLE');
    expect(env.error?.message).toMatch(/verification failed/i);
    expect((env.error?.details as { stderr?: string })?.stderr).toContain(errMsg);
  });

  it('maps missing opa binary to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });

  it('maps subprocess timeout to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    expect(env.error?.code).toBe('TIMEOUT');
  });

  it('uses resolved (real) paths for bundle and key in argv', async () => {
    // Both paths must exist so validatePaths(mustExist) resolves them.
    // outputBundle and publicKey are both created in the workDir beforeEach.
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    await callTool(server, 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    const args = mockRun.mock.calls[0]![1].args;
    // Resolved paths are absolute. Check they appear in the correct flag positions.
    const bundleIdx = args.indexOf('--bundle');
    const keyIdx = args.indexOf('--verification-key');
    expect(bundleIdx).toBeGreaterThan(-1);
    expect(keyIdx).toBeGreaterThan(-1);
    expect(args[bundleIdx + 1]).toBe(outputBundle);
    expect(args[keyIdx + 1]).toBe(publicKey);
  });

  it('rejects non-existent bundle path with PATH_NOT_FOUND', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_verify', {
      bundle: join(workDir, 'does-not-exist.tar.gz'),
      verificationKey: publicKey,
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects non-existent verification key path with PATH_NOT_FOUND', async () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    const env = await callTool(server, 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: join(workDir, 'no-such-key.pem'),
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
    expect(mockRun).not.toHaveBeenCalled();
  });
});
