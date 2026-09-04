import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  workDir = await mkdtemp(join(tmpdir(), 'orygn-bundle-tests-'));
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

/**
 * Directory link: a junction on Windows, which needs no privilege, a symlink
 * elsewhere. Node creates a junction natively, so no shell is involved.
 * Returns false when neither can be created.
 */
async function linkDir(link: string, target: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('opa_bundle_build', () => {
  it('refuses an output path that goes through a directory link pointing outside the roots', async (ctx) => {
    // The output does not exist yet, so its containment is decided by the
    // real location of its nearest existing ancestor. A junction or symlink
    // inside an allowed root that points outside must not become a write
    // destination.
    const outside = join(tmpdir(), `orygn-outside-${Math.random().toString(36).slice(2)}`);
    await mkdir(outside, { recursive: true });
    const link = join(workDir, 'escape-link');
    try {
      if (!(await linkDir(link, outside))) ctx.skip('cannot create directory links here');
      const server = makeServer();
      registerBundleTools(server, {
        ...baseConfig,
        allowedPaths: [...baseConfig.allowedPaths, workDir],
      });
      const env = await callTool(server, 'opa_bundle_build', {
        paths: [fixturePath('policies', 'valid')],
        output: join(link, 'bundle.tar.gz'),
      });
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
      expect(mockRun).not.toHaveBeenCalled();
      expect(existsSync(join(outside, 'bundle.tar.gz'))).toBe(false);
    } finally {
      await rm(link, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

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
    await writeFile(
      keyPath,
      '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n',
      'utf8',
    );
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

/**
 * Build a `.signatures.json` with the shape OPA writes. The signature segment
 * is not a real signature; nothing in the sign tool verifies it, it only
 * reports what the file says, and the real check lives in the integration
 * suite against the real binary.
 */
async function writeFakeSignatures(
  dir: string,
  opts: { alg?: string; files?: number; keyid?: string; scope?: string } = {},
): Promise<string> {
  const b64url = (s: string) =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', typ: 'JWT' }));
  const files = Array.from({ length: opts.files ?? 2 }, (_, i) => ({
    name: `f${i}.rego`,
    hash: 'ab'.repeat(32),
    algorithm: 'SHA-256',
  }));
  const payload: Record<string, unknown> = { files };
  if (opts.keyid) payload['keyid'] = opts.keyid;
  if (opts.scope) payload['scope'] = opts.scope;
  const file = join(dir, '.signatures.json');
  await writeFile(
    file,
    JSON.stringify({ signatures: [`${header}.${b64url(JSON.stringify(payload))}.sig`] }),
  );
  return file;
}

describe('opa_bundle_sign', () => {
  let signingKey: string;
  let bundleDir: string;
  let realBundleDir: string;

  const serverWithWorkDir = () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    return server;
  };

  beforeEach(async () => {
    signingKey = join(workDir, 'signing.key');
    await writeFile(signingKey, '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----');
    bundleDir = join(workDir, `bundle-dir-${Math.random().toString(36).slice(2)}`);
    await mkdir(bundleDir);
    await writeFile(join(bundleDir, 'policy.rego'), 'package p\n');
    // The tool resolves with fs/promises realpath, which expands Windows 8.3
    // short names; the sync JS implementation does not, and CI temp paths
    // are short names.
    realBundleDir = await realpath(bundleDir);
    // A signatures file a previous test left in the shared workDir would
    // satisfy the archive cases below by accident.
    await rm(join(workDir, '.signatures.json'), { force: true });
  });

  it('signs a directory in place, by name from its parent', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await writeFakeSignatures(bundleDir);
    const env = await callTool<{ signed: boolean; signaturesPath: string }>(
      serverWithWorkDir(),
      'opa_bundle_sign',
      { bundle: bundleDir, signingKey },
    );
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.signaturesPath).toBe(join(realBundleDir, '.signatures.json'));

    const call = mockRun.mock.calls[0]![1];
    expect(call.args).toEqual([
      'sign',
      '--bundle',
      '--signing-key',
      signingKey,
      '--output-file-path',
      realBundleDir,
      '--',
      basename(realBundleDir),
    ]);
    expect(call.cwd).toBe(dirname(realBundleDir));
  });

  it('signs an archive by absolute path, beside itself', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await writeFakeSignatures(workDir);
    const realArchive = await realpath(outputBundle);
    const env = await callTool<{ signaturesPath: string }>(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: outputBundle,
      signingKey,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    // The output directory is the archive's directory as given, not its real
    // path, so a temp root that is a symlink or a short name still passes
    // the allowed-roots check (macOS /var, Windows 8.3 names on CI runners).
    expect(env.data?.signaturesPath).toBe(join(dirname(outputBundle), '.signatures.json'));

    const call = mockRun.mock.calls[0]![1];
    expect(call.args.slice(-2)).toEqual(['--', realArchive]);
    expect(call.args[call.args.indexOf('--output-file-path') + 1]).toBe(dirname(outputBundle));
    expect(call.cwd).toBeUndefined();
  });

  it('reports the signature file it observed, with algorithm, file count and claims', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const file = await writeFakeSignatures(bundleDir, {
      alg: 'ES256',
      files: 3,
      keyid: 'k-v1',
      scope: 'write',
    });
    const env = await callTool<Record<string, unknown>>(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data).toEqual({
      signed: true,
      signaturesPath: await realpath(file),
      algorithm: 'ES256',
      filesSigned: 3,
      keyId: 'k-v1',
      scope: 'write',
    });
  });

  it('does not claim success when opa exits 0 but writes no signature file', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toMatch(/did not write \.signatures\.json/);
  });

  it('does not claim success for a stale signature file from an earlier run', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const file = await writeFakeSignatures(bundleDir);
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    await utimes(file, tenSecondsAgo, tenSecondsAgo);
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });

  it('reports a signature file it cannot read rather than guessing', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await writeFile(
      join(bundleDir, '.signatures.json'),
      JSON.stringify({ signatures: ['a', 'b'] }),
    );
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toMatch(/could not read/);
  });

  it('does not report success for a signature that covers no files', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await writeFakeSignatures(bundleDir, { files: 0 });
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_BUNDLE');
    expect(env.error?.message).toMatch(/covered no files/);
  });

  it('rejects outputDir for a directory bundle without calling opa', async () => {
    const out = join(workDir, `out-${Math.random().toString(36).slice(2)}`);
    await mkdir(out);
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
      outputDir: out,
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.message).toMatch(/archives only/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('honours outputDir for an archive', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const out = join(workDir, `out-${Math.random().toString(36).slice(2)}`);
    await mkdir(out);
    await writeFakeSignatures(out);
    const env = await callTool<{ signaturesPath: string }>(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: outputBundle,
      signingKey,
      outputDir: out,
    });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.signaturesPath).toBe(join(out, '.signatures.json'));
    const args = mockRun.mock.calls[0]![1].args;
    expect(args[args.indexOf('--output-file-path') + 1]).toBe(out);
  });

  it('rejects an outputDir outside the allowed roots without calling opa', async () => {
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: outputBundle,
      signingKey,
      outputDir: '/outside',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects an outputDir that is not a directory without calling opa', async () => {
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: outputBundle,
      signingKey,
      outputDir: signingKey,
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('refuses to write through a symlinked .signatures.json', async (ctx) => {
    const target = join(workDir, `symlink-target-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(target, 'precious');
    try {
      await symlink(target, join(bundleDir, '.signatures.json'), 'file');
    } catch {
      ctx.skip('creating symlinks needs a privilege this account lacks');
    }
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(env.error?.message).toMatch(/symbolic link/);
    expect(mockRun).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('precious');
  });

  it('rejects a bundle path outside allowed roots', async () => {
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: '/outside/bundle.tar.gz',
      signingKey,
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('reports a key opa cannot parse as INVALID_INPUT, from stdout where opa prints it', async () => {
    mockRun.mockResolvedValueOnce(
      spawnFailure(1, '', 'error: failed to parse PEM block containing the key'),
    );
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(env.error?.hint).toMatch(/HS256/);
    expect((env.error?.details as { stdout?: string }).stdout).toMatch(/failed to parse PEM/);
  });

  it('reports an algorithm opa does not know as INVALID_INPUT', async () => {
    mockRun.mockResolvedValueOnce(
      spawnFailure(1, '', 'error: unknown signature algorithm: FOO256'),
    );
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
      signingAlg: 'FOO256',
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
  });

  it('maps any other non-zero exit to INVALID_BUNDLE with both streams', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, 'on stderr', 'error: on stdout'));
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
    });
    expect(env.error?.code).toBe('INVALID_BUNDLE');
    const details = env.error?.details as { stdout?: string; stderr?: string };
    expect(details.stdout).toBe('error: on stdout');
    expect(details.stderr).toBe('on stderr');
  });

  it('passes signingAlg and claimsFile through to opa sign', async () => {
    const claimsFile = join(workDir, 'claims.json');
    await writeFile(claimsFile, '{"keyid":"k1"}');
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await writeFakeSignatures(bundleDir);
    await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
      signingAlg: 'ES256',
      claimsFile,
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args[args.indexOf('--signing-alg') + 1]).toBe('ES256');
    expect(args[args.indexOf('--claims-file') + 1]).toBe(claimsFile);
  });

  it('maps missing binary to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_sign', {
      bundle: bundleDir,
      signingKey,
    });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });
});

describe('opa_bundle_verify', () => {
  let publicKey: string;
  let bundleDir: string;

  const serverWithWorkDir = () => {
    const server = makeServer();
    registerBundleTools(server, {
      ...baseConfig,
      allowedPaths: [...baseConfig.allowedPaths, workDir],
    });
    return server;
  };

  beforeEach(async () => {
    publicKey = join(workDir, `verify-key-${Math.random().toString(36).slice(2)}.pem`);
    await writeFile(
      publicKey,
      '-----BEGIN PUBLIC KEY-----\nfakepublickey\n-----END PUBLIC KEY-----',
    );
    bundleDir = join(workDir, `verify-dir-${Math.random().toString(36).slice(2)}`);
    await mkdir(bundleDir);
    await writeFile(join(bundleDir, 'policy.rego'), 'package p\n');
  });

  it('verifies a directory by name from its parent through opa build, never opa eval', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    const env = await callTool<{ bundle: string; verified: boolean }>(
      serverWithWorkDir(),
      'opa_bundle_verify',
      { bundle: bundleDir, verificationKey: publicKey },
    );
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data).toEqual({ bundle: bundleDir, verified: true });

    const real = await realpath(bundleDir);
    const call = mockRun.mock.calls[0]![1];
    const args = call.args;
    expect(args[0]).toBe('build');
    expect(args).not.toContain('eval');
    expect(args).not.toContain('true');
    expect(args[1]).toBe('--bundle');
    expect(args[args.indexOf('--verification-key') + 1]).toBe(publicKey);
    const out = args[args.indexOf('-o') + 1]!;
    expect(out.startsWith(tmpdir())).toBe(true);
    expect(out.endsWith('verified.tar.gz')).toBe(true);
    expect(args.slice(-2)).toEqual(['--', basename(real)]);
    expect(call.cwd).toBe(dirname(real));
  });

  it('verifies an archive by absolute path with no working directory', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    const call = mockRun.mock.calls[0]![1];
    expect(call.args.slice(-2)).toEqual(['--', await realpath(outputBundle)]);
    expect(call.cwd).toBeUndefined();
  });

  it('passes --v0-compatible when asked', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
      v0Compatible: true,
    });
    expect(mockRun.mock.calls[0]![1].args).toContain('--v0-compatible');
  });

  it('removes its temp directory after a successful call', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    const args = mockRun.mock.calls[0]![1].args;
    const out = args[args.indexOf('-o') + 1]!;
    expect(existsSync(dirname(out))).toBe(false);
  });

  it('removes its temp directory after a failed call', async () => {
    mockRun.mockResolvedValueOnce(spawnFailure(1, '', 'error: load error'));
    await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    const args = mockRun.mock.calls[0]![1].args;
    const out = args[args.indexOf('-o') + 1]!;
    expect(existsSync(dirname(out))).toBe(false);
  });

  it('passes optional verificationKeyId, signingAlg, and scope through to opa', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
      verificationKeyId: 'key-v1',
      signingAlg: 'PS256',
      scope: 'read',
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args[args.indexOf('--verification-key-id') + 1]).toBe('key-v1');
    expect(args[args.indexOf('--signing-alg') + 1]).toBe('PS256');
    expect(args[args.indexOf('--scope') + 1]).toBe('read');
  });

  it('omits optional flags when they are not provided', async () => {
    mockRun.mockResolvedValueOnce(spawnSuccess(''));
    await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    const args = mockRun.mock.calls[0]![1].args;
    expect(args).not.toContain('--verification-key-id');
    expect(args).not.toContain('--signing-alg');
    expect(args).not.toContain('--scope');
    expect(args).not.toContain('--v0-compatible');
  });

  // Each message is what OPA 1.19 printed, on stdout, for that case.
  const FAILURES: Array<[string, string]> = [
    ['failed to verify JWT signature: crypto/rsa: verification error', 'signature_invalid'],
    ['scope mismatch', 'scope_mismatch'],
    ['C:\\b\\policy.rego: digest mismatch (want: 2b0a, got: af83)', 'file_modified'],
    ['file C:\\b\\extra.json not included in bundle signature', 'file_added'],
    [
      'file(s) [C:\\b\\data.json] specified in bundle signatures but not found in the target bundle',
      'file_missing',
    ],
    ['bundle missing .signatures.json file', 'unsigned'],
    [
      "bundle load failed on signatures decode: invalid character 'o' in literal null (expecting 'u')",
      'signatures_malformed',
    ],
    ['.signatures.json: missing JWT (expected exactly one)', 'signatures_malformed'],
    ["yaml: line 1: did not find expected ',' or '}'", 'file_unparseable'],
    [
      '1 error occurred: C:\\b\\policy.rego:4: rego_parse_error: unexpected eof token',
      'bundle_load_error',
    ],
    ['bundle read failed: archive read failed: gzip: invalid header', 'not_a_bundle'],
    ['something this tool has never seen', 'unknown'],
  ];
  for (const [message, reason] of FAILURES) {
    it(`classifies "${message.slice(0, 40)}" as ${reason}`, async () => {
      mockRun.mockResolvedValueOnce(
        spawnFailure(1, '', `error: load error: bundle C:\\b: ${message}`),
      );
      const env = await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
        bundle: outputBundle,
        verificationKey: publicKey,
      });
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('INVALID_BUNDLE');
      expect(env.error?.message).toMatch(/verification failed/i);
      const details = env.error?.details as { reason?: string; stdout?: string };
      expect(details.reason).toBe(reason);
      expect(details.stdout).toContain(message);
    });
  }

  it('reports a key or algorithm opa cannot use as INVALID_INPUT, not as a bad bundle', async () => {
    mockRun.mockResolvedValueOnce(
      spawnFailure(
        1,
        '',
        'error: load error: bundle C:\\b: failed to parse PEM block containing the key',
      ),
    );
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect((env.error?.details as { reason?: string }).reason).toBe('key_invalid');
    expect(env.error?.hint).toMatch(/HS256/);
  });

  it('explains the directory-name binding when a file is reported as not covered', async () => {
    mockRun.mockResolvedValueOnce(
      spawnFailure(
        1,
        '',
        'error: load error: bundle C:\\b: file C:\\b\\x not included in bundle signature',
      ),
    );
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    expect(env.error?.hint).toMatch(/different name than it was signed with/);
  });

  it('rejects a bundle path outside the allow-list without calling opa', async () => {
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: '/outside/signed.tar.gz',
      verificationKey: publicKey,
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects a verificationKey path outside the allow-list without calling opa', async () => {
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: '/outside/public.pem',
    });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('maps missing opa binary to OPA_BINARY_NOT_FOUND', async () => {
    mockRun.mockResolvedValueOnce(spawnUnreachable());
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    expect(env.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });

  it('maps subprocess timeout to TIMEOUT', async () => {
    mockRun.mockResolvedValueOnce(spawnTimedOut());
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: publicKey,
    });
    expect(env.error?.code).toBe('TIMEOUT');
  });

  it('rejects non-existent bundle path with PATH_NOT_FOUND', async () => {
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: join(workDir, 'does-not-exist.tar.gz'),
      verificationKey: publicKey,
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects non-existent verification key path with PATH_NOT_FOUND', async () => {
    const env = await callTool(serverWithWorkDir(), 'opa_bundle_verify', {
      bundle: outputBundle,
      verificationKey: join(workDir, 'no-such-key.pem'),
    });
    expect(env.error?.code).toBe('PATH_NOT_FOUND');
    expect(mockRun).not.toHaveBeenCalled();
  });
});
