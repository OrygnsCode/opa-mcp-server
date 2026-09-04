/**
 * Real-binary tests for `opa_bundle_sign` and `opa_bundle_verify`.
 *
 * Every expected outcome here was observed from OPA 1.19 before being
 * asserted: what `opa sign` writes and where, the order in which `opa build`
 * checks a signed bundle, the exact messages it prints for each failure, and
 * how directory signatures bind to the directory name. Mocked unit tests
 * cannot hold a wrapper to any of that, so this suite runs the binary with
 * real keys.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config.js';
import { registerBundleTools } from '../../src/tools/bundles/index.js';
import type { OpaBundleSignOutput } from '../../src/tools/bundles/sign.js';
import type { OpaBundleVerifyOutput } from '../../src/tools/bundles/verify.js';
import { callTool, makeServer } from '../unit/tools/_helpers.js';

const OPA = process.env['OPA_BINARY'] ?? 'opa';
const SIGNATURES = '.signatures.json';
const POLICY = 'package p\n\ndefault allow := false\n\nallow if input.ok\n';

let workDir: string;
let server: ReturnType<typeof makeServer>;
let keys: {
  rsaPrivate: string;
  rsaPublic: string;
  otherPublic: string;
  ecPrivate: string;
  ecPublic: string;
  hmacSecret: string;
  hmacWrong: string;
};
let bundleCounter = 0;

type Details = { reason?: string; stdout?: string; stderr?: string };

const sign = (input: Record<string, unknown>) =>
  callTool<OpaBundleSignOutput>(server, 'opa_bundle_sign', input);
const verify = (input: Record<string, unknown>) =>
  callTool<OpaBundleVerifyOutput>(server, 'opa_bundle_verify', input);
const build = (input: Record<string, unknown>) =>
  callTool<{ output: string; bytes: number }>(server, 'opa_bundle_build', input);

/** A fresh two-file bundle directory under the allowed root. */
async function makeBundle(policy = POLICY, data = '{"x":1}'): Promise<string> {
  const dir = join(workDir, `bundle-${bundleCounter++}`);
  await mkdir(dir);
  await writeFile(join(dir, 'policy.rego'), policy);
  await writeFile(join(dir, 'data.json'), data);
  return dir;
}

/** A signed bundle directory, with the tool's own sign call asserted good. */
async function makeSignedBundle(): Promise<string> {
  const dir = await makeBundle();
  const env = await sign({ bundle: dir, signingKey: keys.rsaPrivate });
  expect(env.ok, JSON.stringify(env.error)).toBe(true);
  return dir;
}

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function expectFailure(
  input: Record<string, unknown>,
  reason: string,
  code = 'INVALID_BUNDLE',
) {
  const env = await verify(input);
  expect(env.ok).toBe(false);
  expect(env.error?.code, JSON.stringify(env.error)).toBe(code);
  expect((env.error?.details as Details).reason, JSON.stringify(env.error?.details)).toBe(reason);
  return env;
}

/** Run the raw opa binary, the way a user at a shell would. */
function rawOpa(args: string[], cwd: string): { status: number | null; stdout: string } {
  const r = spawnSync(OPA, args, { cwd, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/**
 * Create a directory link to `target`: a junction on Windows, which needs no
 * privilege, a symlink elsewhere. Returns false when neither is possible.
 */
async function linkDirectory(link: string, target: string): Promise<boolean> {
  if (platform() === 'win32') {
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' });
    return r.status === 0;
  }
  try {
    await symlink(target, link, 'dir');
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'orygn-bundle-sign-verify-')));

  const rsa = (): { privateKey: string; publicKey: string } =>
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  const k1 = rsa();
  const k2 = rsa();
  const ec = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const keyDir = join(workDir, 'keys');
  await mkdir(keyDir);
  keys = {
    rsaPrivate: join(keyDir, 'rsa.pem'),
    rsaPublic: join(keyDir, 'rsa.pub.pem'),
    otherPublic: join(keyDir, 'other.pub.pem'),
    ecPrivate: join(keyDir, 'ec.pem'),
    ecPublic: join(keyDir, 'ec.pub.pem'),
    hmacSecret: join(keyDir, 'hmac.txt'),
    hmacWrong: join(keyDir, 'hmac-wrong.txt'),
  };
  await writeFile(keys.rsaPrivate, k1.privateKey);
  await writeFile(keys.rsaPublic, k1.publicKey);
  await writeFile(keys.otherPublic, k2.publicKey);
  await writeFile(keys.ecPrivate, ec.privateKey);
  await writeFile(keys.ecPublic, ec.publicKey);
  await writeFile(keys.hmacSecret, 'correct horse battery staple');
  await writeFile(keys.hmacWrong, 'wrong secret');

  const config: Config = {
    opaUrl: 'http://localhost:8181',
    opaBinary: OPA,
    regalBinary: 'regal',
    conftestBinary: 'conftest',
    subprocessTimeoutMs: 30_000,
    httpTimeoutMs: 15_000,
    allowedPaths: [workDir],
    logFile: join(tmpdir(), 'orygn-bundle-sign-verify.log'),
    logLevel: 'error',
    maxResponseBytes: 100_000,
    maxSubprocessBytes: 32 * 1024 * 1024,
  };
  server = makeServer();
  registerBundleTools(server, config);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('opa_bundle_sign against the real opa', () => {
  it('writes .signatures.json into the bundle directory, not the server cwd', async () => {
    const cwdFile = join(process.cwd(), SIGNATURES);
    expect(existsSync(cwdFile), `stale ${SIGNATURES} in cwd before the test`).toBe(false);

    const dir = await makeBundle();
    const env = await sign({ bundle: dir, signingKey: keys.rsaPrivate });

    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.signed).toBe(true);
    expect(env.data?.signaturesPath).toBe(join(dir, SIGNATURES));
    expect(existsSync(join(dir, SIGNATURES))).toBe(true);
    expect(existsSync(cwdFile)).toBe(false);
    expect(existsSync(join(dirname(dir), SIGNATURES))).toBe(false);
  });

  it('records files under the directory name, not an absolute path', async () => {
    const dir = await makeBundle();
    await sign({ bundle: dir, signingKey: keys.rsaPrivate });
    const parsed = JSON.parse(await readFile(join(dir, SIGNATURES), 'utf8')) as {
      signatures: string[];
    };
    const payload = JSON.parse(
      Buffer.from(parsed.signatures[0]!.split('.')[1]!, 'base64').toString(),
    ) as { files: Array<{ name: string }> };
    const names = payload.files.map((f) => f.name.replace(/\\/g, '/')).sort();
    expect(names).toEqual([`${basename(dir)}/data.json`, `${basename(dir)}/policy.rego`]);
  });

  it('reports the algorithm and how many files the signature covers', async () => {
    const dir = await makeBundle();
    const env = await sign({ bundle: dir, signingKey: keys.rsaPrivate });
    expect(env.data?.algorithm).toBe('RS256');
    expect(env.data?.filesSigned).toBe(2);
    expect(env.data?.keyId).toBeUndefined();
    expect(env.data?.scope).toBeUndefined();
  });

  it('rejects outputDir for a directory bundle, which is signed in place', async () => {
    const dir = await makeBundle();
    const out = join(workDir, `sigs-${bundleCounter}`);
    await mkdir(out);
    const env = await sign({ bundle: dir, signingKey: keys.rsaPrivate, outputDir: out });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect(existsSync(join(out, SIGNATURES))).toBe(false);
    expect(existsSync(join(dir, SIGNATURES))).toBe(false);
  });

  it('honours outputDir for an archive', async () => {
    const dir = await makeBundle();
    const archive = join(workDir, `archive-out-${bundleCounter}.tar.gz`);
    expect((await build({ paths: [dir], output: archive })).ok).toBe(true);
    const out = join(workDir, `sigs-${bundleCounter}`);
    await mkdir(out);
    const env = await sign({ bundle: archive, signingKey: keys.rsaPrivate, outputDir: out });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.signaturesPath).toBe(join(out, SIGNATURES));
    expect(existsSync(join(out, SIGNATURES))).toBe(true);
    expect(existsSync(join(workDir, SIGNATURES))).toBe(false);
  });

  it('rejects an outputDir outside the allowed roots without running opa', async () => {
    const dir = await makeBundle();
    const archive = join(workDir, `archive-outside-${bundleCounter}.tar.gz`);
    expect((await build({ paths: [dir], output: archive })).ok).toBe(true);
    const outside = await mkdtemp(join(tmpdir(), 'orygn-outside-'));
    try {
      const env = await sign({ bundle: archive, signingKey: keys.rsaPrivate, outputDir: outside });
      expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
      expect(existsSync(join(outside, SIGNATURES))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('signs with ES256 using an EC key', async () => {
    const dir = await makeBundle();
    const env = await sign({ bundle: dir, signingKey: keys.ecPrivate, signingAlg: 'ES256' });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.algorithm).toBe('ES256');
  });

  it('signs with HS256 using a file that holds the secret', async () => {
    const dir = await makeBundle();
    const env = await sign({ bundle: dir, signingKey: keys.hmacSecret, signingAlg: 'HS256' });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.algorithm).toBe('HS256');
  });

  it('carries keyid and scope from a claims file into the signature', async () => {
    const dir = await makeBundle();
    const claims = join(workDir, `claims-${bundleCounter}.json`);
    await writeFile(claims, JSON.stringify({ keyid: 'k-v1', scope: 'write' }));
    const env = await sign({ bundle: dir, signingKey: keys.rsaPrivate, claimsFile: claims });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.keyId).toBe('k-v1');
    expect(env.data?.scope).toBe('write');
  });

  it('signs an archive beside itself and leaves the archive untouched', async () => {
    const dir = await makeBundle();
    const archive = join(workDir, `archive-${bundleCounter}.tar.gz`);
    const built = await build({ paths: [dir], output: archive });
    expect(built.ok, JSON.stringify(built.error)).toBe(true);
    const before = await readFile(archive);

    const env = await sign({ bundle: archive, signingKey: keys.rsaPrivate });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.signaturesPath).toBe(join(dirname(archive), SIGNATURES));
    expect(existsSync(env.data!.signaturesPath)).toBe(true);
    expect((await readFile(archive)).equals(before)).toBe(true);
    // The archive's own manifest is covered as well as the two files.
    expect(env.data?.filesSigned).toBe(3);
    await rm(env.data!.signaturesPath);
  });

  it('signs the real directory behind a junction or symlink, not an empty file list', async (ctx) => {
    const target = await makeBundle();
    const link = join(workDir, `link-${bundleCounter}`);
    if (!(await linkDirectory(link, target))) {
      ctx.skip('this account cannot create directory links');
    }
    const env = await sign({ bundle: link, signingKey: keys.rsaPrivate });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.filesSigned).toBe(2);
    expect(env.data?.signaturesPath).toBe(join(target, SIGNATURES));
    const viaLink = await verify({ bundle: link, verificationKey: keys.rsaPublic });
    expect(viaLink.ok, JSON.stringify(viaLink.error)).toBe(true);
  });

  it('does not report success for an empty directory', async () => {
    const dir = join(workDir, `empty-${bundleCounter++}`);
    await mkdir(dir);
    const env = await sign({ bundle: dir, signingKey: keys.rsaPrivate });
    expect(env.error?.code).toBe('INVALID_BUNDLE');
    expect(env.error?.message).toMatch(/covered no files/);
  });

  it('refuses to write through a symlinked .signatures.json', async (ctx) => {
    const dir = await makeBundle();
    const target = join(workDir, `precious-${bundleCounter}.json`);
    await writeFile(target, 'precious');
    try {
      await symlink(target, join(dir, SIGNATURES), 'file');
    } catch {
      ctx.skip('creating symlinks needs a privilege this account lacks');
    }
    const env = await sign({ bundle: dir, signingKey: keys.rsaPrivate });
    expect(env.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(await readFile(target, 'utf8')).toBe('precious');
  });

  it('reports a key opa cannot parse as INVALID_INPUT, with the reason from stdout', async () => {
    const dir = await makeBundle();
    const garbage = join(workDir, `garbage-${bundleCounter}.pem`);
    await writeFile(garbage, 'not a key');
    const env = await sign({ bundle: dir, signingKey: garbage });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect((env.error?.details as Details).stdout).toMatch(/failed to parse PEM/);
    expect(existsSync(join(dir, SIGNATURES))).toBe(false);
  });

  it('reports an algorithm opa does not know as INVALID_INPUT', async () => {
    const dir = await makeBundle();
    const env = await sign({ bundle: dir, signingKey: keys.rsaPrivate, signingAlg: 'FOO256' });
    expect(env.error?.code).toBe('INVALID_INPUT');
    expect((env.error?.details as Details).stdout).toMatch(/unknown signature algorithm/);
  });

  it('fails on a bundle whose data does not load, and writes nothing', async () => {
    const dir = await makeBundle(POLICY, '{not json');
    const env = await sign({ bundle: dir, signingKey: keys.rsaPrivate });
    expect(env.error?.code).toBe('INVALID_BUNDLE');
    expect(existsSync(join(dir, SIGNATURES))).toBe(false);
  });

  it('re-signing replaces the previous signature', async () => {
    const dir = await makeSignedBundle();
    const first = await readFile(join(dir, SIGNATURES), 'utf8');
    const env = await sign({ bundle: dir, signingKey: keys.ecPrivate, signingAlg: 'ES256' });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data?.algorithm).toBe('ES256');
    expect(await readFile(join(dir, SIGNATURES), 'utf8')).not.toBe(first);
  });
});

describe('opa_bundle_verify against the real opa', () => {
  it('verifies a bundle signed by opa_bundle_sign', async () => {
    const dir = await makeSignedBundle();
    const env = await verify({ bundle: dir, verificationKey: keys.rsaPublic });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data).toEqual({ bundle: dir, verified: true });
  });

  it('still verifies after the directory is moved under the same name', async () => {
    const dir = await makeSignedBundle();
    const otherParent = join(workDir, `elsewhere-${bundleCounter}`);
    await mkdir(otherParent);
    const moved = join(otherParent, basename(dir));
    await rename(dir, moved);
    const env = await verify({ bundle: moved, verificationKey: keys.rsaPublic });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
  });

  it('reports file_added, with the naming hint, after the directory is renamed', async () => {
    const dir = await makeSignedBundle();
    const renamed = `${dir}-renamed`;
    await rename(dir, renamed);
    const env = await expectFailure(
      { bundle: renamed, verificationKey: keys.rsaPublic },
      'file_added',
    );
    expect(env.error?.hint).toMatch(/different name than it was signed with/);
  });

  it('verifies a directory signed with the opa CLI from its parent', async () => {
    const dir = await makeBundle();
    const r = rawOpa(
      ['sign', '--bundle', '--signing-key', keys.rsaPrivate, '-o', basename(dir), basename(dir)],
      dirname(dir),
    );
    expect(r.status, r.stdout).toBe(0);
    const env = await verify({ bundle: dir, verificationKey: keys.rsaPublic });
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
  });

  it('produces a directory the opa CLI verifies from its parent', async () => {
    const dir = await makeSignedBundle();
    const out = join(workDir, `cli-${bundleCounter}.tar.gz`);
    const r = rawOpa(
      ['build', '-b', basename(dir), '--verification-key', keys.rsaPublic, '-o', out],
      dirname(dir),
    );
    expect(r.status, r.stdout).toBe(0);
    await rm(out, { force: true });
  });

  it('rejects the wrong key', async () => {
    const dir = await makeSignedBundle();
    await expectFailure({ bundle: dir, verificationKey: keys.otherPublic }, 'signature_invalid');
  });

  it('detects a modified policy file', async () => {
    const dir = await makeSignedBundle();
    await writeFile(join(dir, 'policy.rego'), POLICY + '# tampered\n');
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'file_modified');
  });

  it('detects modified data', async () => {
    const dir = await makeSignedBundle();
    await writeFile(join(dir, 'data.json'), '{"x":2}');
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'file_modified');
  });

  it('reports data that no longer parses as file_unparseable, not as signed content', async () => {
    // OPA hashes data files by parsed value, so an unparseable one fails
    // before its digest is compared. The tool must not tell the caller the
    // file is signed and unmodified.
    const dir = await makeSignedBundle();
    await writeFile(join(dir, 'data.json'), '{not json');
    const env = await expectFailure(
      { bundle: dir, verificationKey: keys.rsaPublic },
      'file_unparseable',
    );
    expect(env.error?.hint).toMatch(/may have been modified/);
  });

  it('detects a file added after signing', async () => {
    const dir = await makeSignedBundle();
    await writeFile(join(dir, 'extra.json'), '{}');
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'file_added');
  });

  it('detects a signed file that was removed', async () => {
    const dir = await makeSignedBundle();
    await rm(join(dir, 'data.json'));
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'file_missing');
  });

  it('rejects an unsigned bundle', async () => {
    const dir = await makeBundle();
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'unsigned');
  });

  it('rejects a corrupted signature', async () => {
    const dir = await makeSignedBundle();
    const file = join(dir, SIGNATURES);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { signatures: string[] };
    const [h, p, s] = parsed.signatures[0]!.split('.') as [string, string, string];
    const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
    await writeFile(file, JSON.stringify({ signatures: [`${h}.${p}.${flipped}`] }));
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'signature_invalid');
  });

  it('rejects a payload edited under the original signature', async () => {
    const dir = await makeSignedBundle();
    const file = join(dir, SIGNATURES);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { signatures: string[] };
    const [h, p, s] = parsed.signatures[0]!.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64').toString()) as {
      files: Array<{ hash: string }>;
    };
    payload.files[0]!.hash = '00' + payload.files[0]!.hash.slice(2);
    await writeFile(
      file,
      JSON.stringify({ signatures: [`${h}.${b64url(JSON.stringify(payload))}.${s}`] }),
    );
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'signature_invalid');
  });

  it('rejects an alg=none token', async () => {
    const dir = await makeSignedBundle();
    const file = join(dir, SIGNATURES);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { signatures: string[] };
    const p = parsed.signatures[0]!.split('.')[1]!;
    const none = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    await writeFile(file, JSON.stringify({ signatures: [`${none}.${p}.`] }));
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'signature_invalid');
  });

  it('rejects a signatures file that is not JSON', async () => {
    const dir = await makeSignedBundle();
    await writeFile(join(dir, SIGNATURES), 'not json');
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'signatures_malformed');
  });

  it('rejects a JWT whose payload is not JSON', async () => {
    const dir = await makeSignedBundle();
    const file = join(dir, SIGNATURES);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { signatures: string[] };
    const [h, , s] = parsed.signatures[0]!.split('.') as [string, string, string];
    await writeFile(file, JSON.stringify({ signatures: [`${h}.${b64url('not json')}.${s}`] }));
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'signatures_malformed');
  });

  it('rejects an empty signatures array', async () => {
    const dir = await makeSignedBundle();
    await writeFile(join(dir, SIGNATURES), JSON.stringify({ signatures: [] }));
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'signatures_malformed');
  });

  it('reports a load error, after signature and digests pass, for a policy that does not parse', async () => {
    // opa sign does not parse Rego, so a broken policy signs fine, and OPA
    // checks every digest before it parses. This is a bundle whose
    // signature held and whose content is unusable.
    const dir = await makeBundle('package s\n\nallow if {\n');
    const signed = await sign({ bundle: dir, signingKey: keys.rsaPrivate });
    expect(signed.ok, JSON.stringify(signed.error)).toBe(true);
    const env = await expectFailure(
      { bundle: dir, verificationKey: keys.rsaPublic },
      'bundle_load_error',
    );
    expect((env.error?.details as Details).stdout).toMatch(/rego_parse_error/);
  });

  it('verifies a Rego v0 bundle only with v0Compatible', async () => {
    const dir = await makeBundle('package v\n\nallow { input.x }\n');
    const signed = await sign({ bundle: dir, signingKey: keys.rsaPrivate });
    expect(signed.ok, JSON.stringify(signed.error)).toBe(true);
    const v1 = await expectFailure(
      { bundle: dir, verificationKey: keys.rsaPublic },
      'bundle_load_error',
    );
    expect(v1.error?.hint).toMatch(/v0Compatible/);
    const v0 = await verify({ bundle: dir, verificationKey: keys.rsaPublic, v0Compatible: true });
    expect(v0.ok, JSON.stringify(v0.error)).toBe(true);
  });

  it('enforces the scope claim in both directions, and does not check the key id', async () => {
    // Observed on OPA 1.19: a signed scope must be matched with `scope`, a
    // scope given for an unscoped signature also fails, and
    // verificationKeyId is only the name the single key is registered under.
    const dir = await makeBundle();
    const claims = join(workDir, `claims-verify-${bundleCounter}.json`);
    await writeFile(claims, JSON.stringify({ keyid: 'k-v1', scope: 'write' }));
    const signed = await sign({ bundle: dir, signingKey: keys.rsaPrivate, claimsFile: claims });
    expect(signed.ok, JSON.stringify(signed.error)).toBe(true);

    const noScope = await expectFailure(
      { bundle: dir, verificationKey: keys.rsaPublic },
      'scope_mismatch',
    );
    expect(noScope.error?.hint).toMatch(/scope/);
    await expectFailure(
      { bundle: dir, verificationKey: keys.rsaPublic, scope: 'read' },
      'scope_mismatch',
    );
    const withScope = await verify({
      bundle: dir,
      verificationKey: keys.rsaPublic,
      scope: 'write',
    });
    expect(withScope.ok, JSON.stringify(withScope.error)).toBe(true);
    const otherKeyId = await verify({
      bundle: dir,
      verificationKey: keys.rsaPublic,
      verificationKeyId: 'other',
      scope: 'write',
    });
    expect(otherKeyId.ok, JSON.stringify(otherKeyId.error)).toBe(true);

    const unscoped = await makeSignedBundle();
    await expectFailure(
      { bundle: unscoped, verificationKey: keys.rsaPublic, scope: 'write' },
      'scope_mismatch',
    );
  });

  it('round-trips HS256 through a secret file and rejects the wrong secret', async () => {
    const dir = await makeBundle();
    const signed = await sign({ bundle: dir, signingKey: keys.hmacSecret, signingAlg: 'HS256' });
    expect(signed.ok, JSON.stringify(signed.error)).toBe(true);

    const ok = await verify({ bundle: dir, verificationKey: keys.hmacSecret, signingAlg: 'HS256' });
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    await expectFailure(
      { bundle: dir, verificationKey: keys.hmacWrong, signingAlg: 'HS256' },
      'signature_invalid',
    );
    // An RSA key against an HMAC signature is a signature failure.
    await expectFailure({ bundle: dir, verificationKey: keys.rsaPublic }, 'signature_invalid');
    // The secret file without signingAlg is read as PEM and rejected as a key.
    const noAlg = await expectFailure(
      { bundle: dir, verificationKey: keys.hmacSecret },
      'key_invalid',
      'INVALID_INPUT',
    );
    expect(noAlg.error?.hint).toMatch(/HS256/);
  });

  it('round-trips ES256', async () => {
    const dir = await makeBundle();
    const signed = await sign({ bundle: dir, signingKey: keys.ecPrivate, signingAlg: 'ES256' });
    expect(signed.ok, JSON.stringify(signed.error)).toBe(true);
    const ok = await verify({ bundle: dir, verificationKey: keys.ecPublic, signingAlg: 'ES256' });
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    await expectFailure(
      { bundle: dir, verificationKey: keys.rsaPublic, signingAlg: 'ES256' },
      'signature_invalid',
    );
  });

  it('reports a key opa cannot parse as INVALID_INPUT', async () => {
    const dir = await makeSignedBundle();
    const garbage = join(workDir, `garbage-verify-${bundleCounter}.pem`);
    await writeFile(garbage, 'not a key');
    await expectFailure({ bundle: dir, verificationKey: garbage }, 'key_invalid', 'INVALID_INPUT');
  });

  it('reports a plain file given as the bundle as not_a_bundle', async () => {
    await expectFailure(
      { bundle: keys.rsaPrivate, verificationKey: keys.rsaPublic },
      'not_a_bundle',
    );
  });

  it('verifies an archive signed by opa_bundle_build and rejects it with the wrong key', async () => {
    const dir = await makeBundle();
    const archive = join(workDir, `signed-${bundleCounter}.tar.gz`);
    // No `bundle: true` here on purpose: opa build refuses --signing-key
    // outside bundle mode, so the build tool has to imply it.
    const built = await build({ paths: [dir], output: archive, signingKey: keys.rsaPrivate });
    expect(built.ok, JSON.stringify(built.error)).toBe(true);

    const ok = await verify({ bundle: archive, verificationKey: keys.rsaPublic });
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    await expectFailure(
      { bundle: archive, verificationKey: keys.otherPublic },
      'signature_invalid',
    );
  });

  it('rejects an unsigned archive', async () => {
    const dir = await makeBundle();
    const archive = join(workDir, `plain-${bundleCounter}.tar.gz`);
    const built = await build({ paths: [dir], output: archive });
    expect(built.ok, JSON.stringify(built.error)).toBe(true);
    await expectFailure({ bundle: archive, verificationKey: keys.rsaPublic }, 'unsigned');
  });

  it('an archive signed by opa_bundle_sign is not itself verifiable, since the signature sits beside it', async () => {
    const dir = await makeBundle();
    const archive = join(workDir, `beside-${bundleCounter}.tar.gz`);
    const built = await build({ paths: [dir], output: archive });
    expect(built.ok, JSON.stringify(built.error)).toBe(true);
    const signed = await sign({ bundle: archive, signingKey: keys.rsaPrivate });
    expect(signed.ok, JSON.stringify(signed.error)).toBe(true);
    await expectFailure({ bundle: archive, verificationKey: keys.rsaPublic }, 'unsigned');
    await rm(signed.data!.signaturesPath);
  });

  it('leaves nothing behind in the temp directory, on success or failure', async () => {
    // os.tmpdir() is read at call time, so pointing it at a private
    // directory isolates this check from anything else using the shared
    // temp directory while the test runs.
    const dir = await makeSignedBundle();
    const privateTmp = join(workDir, `tmp-${bundleCounter}`);
    await mkdir(privateTmp);
    const saved = {
      TMPDIR: process.env['TMPDIR'],
      TMP: process.env['TMP'],
      TEMP: process.env['TEMP'],
    };
    process.env['TMPDIR'] = privateTmp;
    process.env['TMP'] = privateTmp;
    process.env['TEMP'] = privateTmp;
    try {
      expect(tmpdir()).toBe(privateTmp);
      await verify({ bundle: dir, verificationKey: keys.rsaPublic });
      await verify({ bundle: dir, verificationKey: keys.otherPublic });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(await readdir(privateTmp)).toEqual([]);
  });

  it('does not modify the bundle it verifies', async () => {
    const dir = await makeSignedBundle();
    const snapshot = async () => {
      const names = (await readdir(dir)).sort();
      const sizes = await Promise.all(names.map(async (n) => (await stat(join(dir, n))).size));
      return names.map((n, i) => `${n}:${sizes[i]}`).join(',');
    };
    const before = await snapshot();
    await verify({ bundle: dir, verificationKey: keys.rsaPublic });
    expect(await snapshot()).toBe(before);
  });
});
