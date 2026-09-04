import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  classifyVerificationFailure,
  isKeyOrAlgorithmError,
  readSignaturesSummary,
} from '../../../src/lib/bundle-signatures.js';

const b64url = (s: string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function jwt(header: unknown, payload: unknown): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.c2ln`;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orygn-bundle-signatures-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

describe('readSignaturesSummary', () => {
  it('reads algorithm, file count, and claims from the JWT', async () => {
    const file = await write(
      'ok.json',
      JSON.stringify({
        signatures: [
          jwt(
            { alg: 'ES256', typ: 'JWT' },
            { files: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], keyid: 'k1', scope: 'write' },
          ),
        ],
      }),
    );
    await expect(readSignaturesSummary(file)).resolves.toEqual({
      algorithm: 'ES256',
      filesSigned: 3,
      keyId: 'k1',
      scope: 'write',
    });
  });

  it('omits keyId and scope when the payload has none', async () => {
    const file = await write(
      'plain.json',
      JSON.stringify({ signatures: [jwt({ alg: 'RS256' }, { files: [] })] }),
    );
    const summary = await readSignaturesSummary(file);
    expect(summary).toEqual({ algorithm: 'RS256', filesSigned: 0 });
    expect('keyId' in summary).toBe(false);
  });

  it('decodes base64url segments that need padding and use - and _', async () => {
    const payload = { files: [{ name: '~~~???>>>' }], scope: 's' };
    const std = Buffer.from(JSON.stringify(payload)).toString('base64');
    expect(std).toMatch(/[+/]/);
    const file = await write(
      'urlsafe.json',
      JSON.stringify({ signatures: [jwt({ alg: 'HS256' }, payload)] }),
    );
    await expect(readSignaturesSummary(file)).resolves.toEqual({
      algorithm: 'HS256',
      filesSigned: 1,
      scope: 's',
    });
  });

  it('rejects two JWTs, which OPA never writes', async () => {
    const file = await write('two.json', JSON.stringify({ signatures: ['a.b.c', 'd.e.f'] }));
    await expect(readSignaturesSummary(file)).rejects.toThrow(/exactly one JWT/);
  });

  it('rejects a signature that is not a JWT', async () => {
    const file = await write('notjwt.json', JSON.stringify({ signatures: ['nope'] }));
    await expect(readSignaturesSummary(file)).rejects.toThrow(/not a JWT/);
  });

  it('rejects a header without alg', async () => {
    const file = await write(
      'noalg.json',
      JSON.stringify({ signatures: [jwt({ typ: 'JWT' }, { files: [] })] }),
    );
    await expect(readSignaturesSummary(file)).rejects.toThrow(/no alg/);
  });

  it('rejects a payload without files', async () => {
    const file = await write(
      'nofiles.json',
      JSON.stringify({ signatures: [jwt({ alg: 'RS256' }, { keyid: 'k' })] }),
    );
    await expect(readSignaturesSummary(file)).rejects.toThrow(/no files/);
  });

  it('rejects a file that is not JSON', async () => {
    const file = await write('notjson.json', 'not json');
    await expect(readSignaturesSummary(file)).rejects.toThrow();
  });
});

describe('isKeyOrAlgorithmError', () => {
  it('recognises the two messages opa prints for a bad key or algorithm', () => {
    expect(isKeyOrAlgorithmError('error: failed to parse PEM block containing the key')).toBe(true);
    expect(isKeyOrAlgorithmError('error: unknown signature algorithm: FOO256')).toBe(true);
    expect(isKeyOrAlgorithmError('error: load error: bundle x: digest mismatch')).toBe(false);
  });
});

describe('classifyVerificationFailure', () => {
  // Every message here is what OPA 1.19 printed for that case.
  const cases: Array<[string, string]> = [
    ['failed to parse PEM block containing the key', 'key_invalid'],
    ['unknown signature algorithm: FOO256', 'key_invalid'],
    ['bundle read failed: archive read failed: gzip: invalid header', 'not_a_bundle'],
    ['failed to verify JWT signature: crypto/rsa: verification error', 'signature_invalid'],
    ['scope mismatch', 'scope_mismatch'],
    ['x/policy.rego: digest mismatch (want: aa, got: bb)', 'file_modified'],
    [
      'file(s) [x/data.json] specified in bundle signatures but not found in the target bundle',
      'file_missing',
    ],
    ['file x/extra.json not included in bundle signature', 'file_added'],
    ['bundle missing .signatures.json file', 'unsigned'],
    [
      "bundle load failed on signatures decode: invalid character 'o' in literal null",
      'signatures_malformed',
    ],
    ['.signatures.json: missing JWT (expected exactly one)', 'signatures_malformed'],
    [
      'failed to base64 decode JWT payload: illegal base64 data at input byte 0',
      'signatures_malformed',
    ],
    ['failed to split compact JWT: jwsbb: invalid number of segments', 'signatures_malformed'],
    ["invalid character 'o' in literal null (expecting 'u')", 'signatures_malformed'],
    ["yaml: line 1: did not find expected ',' or '}'", 'file_unparseable'],
    [
      '1 error occurred: x/policy.rego:4: rego_parse_error: unexpected eof token',
      'bundle_load_error',
    ],
    [
      "manifest roots [other] do not permit 'package p' in module 'x/policy.rego'",
      'bundle_load_error',
    ],
    ['', 'unknown'],
  ];
  for (const [message, reason] of cases) {
    it(`maps "${message.slice(0, 45)}" to ${reason}`, () => {
      expect(classifyVerificationFailure(`error: load error: bundle x: ${message}`).reason).toBe(
        reason,
      );
    });
  }

  it('lets the signature check win when a message also mentions a digest', () => {
    const out = 'failed to verify JWT signature after digest mismatch';
    expect(classifyVerificationFailure(out).reason).toBe('signature_invalid');
  });

  it('classifies a broken signatures envelope before the bare JSON error', () => {
    const out = "bundle load failed on signatures decode: invalid character 'x'";
    expect(classifyVerificationFailure(out).reason).toBe('signatures_malformed');
  });

  it('classifies an unparseable data file as possibly modified, not as a load error', () => {
    const failure = classifyVerificationFailure('bundle x: yaml: line 1: did not find expected');
    expect(failure.reason).toBe('file_unparseable');
    expect(failure.hint).toMatch(/before comparing digests/);
  });

  it('points a v1 parse failure at v0Compatible', () => {
    const out =
      '1 error occurred: v0/p.rego:3: rego_parse_error: `if` keyword is required before rule body';
    const failure = classifyVerificationFailure(out);
    expect(failure.reason).toBe('bundle_load_error');
    expect(failure.hint).toMatch(/v0Compatible/);
  });

  it('describes scope_mismatch without assuming which side had the scope', () => {
    const failure = classifyVerificationFailure('bundle x: scope mismatch');
    expect(failure.summary).toMatch(/scope given does not match/);
    expect(failure.hint).toMatch(/no scope if it was signed without one/);
  });

  it('explains the directory-name binding on file_added', () => {
    expect(classifyVerificationFailure('file y not included in bundle signature').hint).toMatch(
      /different name than it was signed with/,
    );
  });

  it('tells an HMAC user to pass signingAlg on key_invalid', () => {
    expect(classifyVerificationFailure('failed to parse PEM block').hint).toMatch(/HS256/);
  });

  it('attaches no hint to reasons that have none', () => {
    expect(classifyVerificationFailure('digest mismatch').hint).toBeUndefined();
  });
});
