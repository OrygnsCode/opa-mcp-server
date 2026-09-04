/**
 * Helpers for OPA bundle signatures.
 *
 * `opa sign` writes `{ "signatures": ["<JWT>"] }` with exactly one JWT. Its
 * header carries the algorithm and its payload lists every signed file as
 * `{ name, hash, algorithm }`, plus whatever extra claims (`keyid`, `scope`)
 * were supplied through a claims file. Reading that summary back is how the
 * sign tool describes what it just produced, and it is deliberately not a
 * verification: nothing here checks the signature, only OPA does that.
 */
import { readFile } from 'node:fs/promises';

export interface SignaturesSummary {
  /** JWT `alg` header, e.g. `RS256`. */
  algorithm: string;
  /** Number of files the signature covers. */
  filesSigned: number;
  keyId?: string;
  scope?: string;
}

function base64UrlDecode(segment: string): string {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Read the summary of a `.signatures.json` file. Throws on any shape OPA
 * would not have written, so a caller never reports a file it cannot read.
 */
export async function readSignaturesSummary(path: string): Promise<SignaturesSummary> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as { signatures?: unknown };
  const sigs = parsed.signatures;
  if (!Array.isArray(sigs) || sigs.length !== 1 || typeof sigs[0] !== 'string') {
    throw new Error('expected exactly one JWT in "signatures"');
  }
  const parts = sigs[0].split('.');
  if (parts.length !== 3) throw new Error('signature is not a JWT');

  const header = JSON.parse(base64UrlDecode(parts[0]!)) as { alg?: unknown };
  const payload = JSON.parse(base64UrlDecode(parts[1]!)) as {
    files?: unknown;
    keyid?: unknown;
    scope?: unknown;
  };
  if (typeof header.alg !== 'string') throw new Error('JWT header has no alg');
  if (!Array.isArray(payload.files)) throw new Error('JWT payload has no files array');

  const summary: SignaturesSummary = {
    algorithm: header.alg,
    filesSigned: payload.files.length,
  };
  if (typeof payload.keyid === 'string') summary.keyId = payload.keyid;
  if (typeof payload.scope === 'string') summary.scope = payload.scope;
  return summary;
}

/**
 * `opa sign` and `opa build` both print these when the key file is not a PEM
 * key or the algorithm is not one OPA knows. They are the caller's input, not
 * the bundle, so the tools report them as INVALID_INPUT.
 */
const KEY_OR_ALGORITHM_ERROR = /failed to parse PEM block|unknown signature algorithm/i;

export function isKeyOrAlgorithmError(output: string): boolean {
  return KEY_OR_ALGORITHM_ERROR.test(output);
}

export type VerificationFailureReason =
  | 'key_invalid'
  | 'not_a_bundle'
  | 'signature_invalid'
  | 'scope_mismatch'
  | 'file_modified'
  | 'file_missing'
  | 'file_added'
  | 'unsigned'
  | 'signatures_malformed'
  | 'file_unparseable'
  | 'bundle_load_error'
  | 'unknown';

export interface VerificationFailure {
  reason: VerificationFailureReason;
  summary: string;
  hint?: string;
}

/**
 * Each pattern is text OPA 1.19 prints, on stdout, for that failure.
 *
 * The order follows what OPA does while loading a signed bundle: it reads the
 * key and algorithm, checks the JWT against the key, compares the scope claim,
 * then reads every file. A Rego file is hashed as written, so its digest is
 * compared before it is parsed. A data file or `.manifest` is hashed by parsed
 * value, so one that no longer parses fails BEFORE its digest is compared;
 * that is why an unparseable data file is `file_unparseable` (possibly
 * modified) and not a load error of signed content. Rego parse errors come
 * last, after the signature and every digest passed. Where messages overlap,
 * the more specific rule is listed first.
 */
const FAILURE_RULES: ReadonlyArray<VerificationFailure & { pattern: RegExp }> = [
  {
    reason: 'key_invalid',
    pattern: KEY_OR_ALGORITHM_ERROR,
    summary: 'the verification key or algorithm could not be used',
    hint: 'verificationKey must be a PEM public key, and signingAlg one OPA supports. For an HMAC-signed bundle pass signingAlg (HS256, HS384 or HS512) so the file is read as the secret rather than as PEM.',
  },
  {
    reason: 'not_a_bundle',
    pattern: /archive read failed|bundle read failed/i,
    summary: 'the path is not a bundle directory or a .tar.gz archive',
  },
  {
    reason: 'signature_invalid',
    pattern: /failed to verify JWT signature|verification error/i,
    summary: 'the signature does not verify with this key',
    hint: 'Check the key and pass signingAlg matching how the bundle was signed. OPA verifies against the single key given regardless of the signature keyid claim, so this is the key or the algorithm, not the key id.',
  },
  {
    reason: 'scope_mismatch',
    pattern: /scope mismatch/i,
    summary: 'the scope given does not match the scope claim in the signature',
    hint: 'Pass scope with exactly the value the bundle was signed with, and no scope if it was signed without one.',
  },
  {
    reason: 'file_modified',
    pattern: /digest mismatch/i,
    summary: 'a signed file was modified after signing',
  },
  {
    reason: 'file_missing',
    pattern: /specified in bundle signatures but not found/i,
    summary: 'a file the signature covers is missing from the bundle',
  },
  {
    reason: 'file_added',
    pattern: /not included in bundle signature/i,
    summary: 'the bundle contains a file the signature does not cover',
    hint: 'A directory signature names files under the directory name given to opa, so this is also what a directory reports when verified under a different name than it was signed with. Moving it elsewhere under the same name is fine; renaming it is not. For an artifact that survives renaming, build a signed archive with opa_bundle_build.',
  },
  {
    reason: 'unsigned',
    pattern: /missing \.signatures\.json/i,
    summary: 'the bundle has no .signatures.json',
  },
  {
    reason: 'signatures_malformed',
    pattern:
      /signatures decode|missing JWT|base64 decode JWT|split compact JWT|unexpected end of JSON input|\.signatures\.json/i,
    summary: '.signatures.json is not a valid signature file',
  },
  {
    reason: 'file_unparseable',
    pattern: /yaml:/i,
    summary: 'a data file or .manifest could not be parsed, so its digest was never compared',
    hint: 'OPA hashes data files by parsed value and stops at the first one it cannot parse, before comparing digests. The file may have been modified after signing. Restore it, or fix it and sign again.',
  },
  {
    reason: 'bundle_load_error',
    pattern: /rego_\w+_error|errors? occurred|manifest roots/i,
    summary: 'the bundle could not be loaded, so verification did not complete',
    hint: 'OPA parses Rego after the signature and every digest passed, so the policy is signed and unmodified but does not load under Rego v1. A policy written for Rego v0 verifies with v0Compatible.',
  },
  {
    // A JWT payload that decodes but is not JSON: OPA prints only the JSON
    // error, with none of the prefixes matched above.
    reason: 'signatures_malformed',
    pattern: /invalid character/i,
    summary: '.signatures.json is not a valid signature file',
  },
];

/** Classify OPA's stdout+stderr from a failed verification. */
export function classifyVerificationFailure(output: string): VerificationFailure {
  for (const rule of FAILURE_RULES) {
    if (rule.pattern.test(output)) {
      const { pattern: _pattern, ...failure } = rule;
      return failure;
    }
  }
  return {
    reason: 'unknown',
    summary: 'OPA rejected the bundle for a reason this tool does not recognise',
  };
}
