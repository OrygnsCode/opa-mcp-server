/**
 * Real-binary tests for the Rego shipped in the `opa://patterns` resource.
 *
 * These snippets are documentation users copy into their own policies, so a
 * mistake in one ships as advice. Every block must compile under Rego v1, and
 * the security examples must actually catch what they claim to.
 *
 * The Terraform IAM example matched `"*" in statement.Action`, which requires
 * Action to be a collection. AWS accepts a bare string there, so the single
 * most common admin policy, `{"Action": "*", "Resource": "*"}`, was allowed by
 * the rule meant to reject exactly it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PATTERNS } from '../../src/resources/patterns.js';

const OPA = process.env['OPA_BINARY'] ?? 'opa';

let workDir: string;

/** Every fenced rego block in the shipped markdown. */
function regoBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = '```';
  let from = 0;
  for (;;) {
    const open = markdown.indexOf(`${fence}rego\n`, from);
    if (open === -1) break;
    const bodyStart = open + fence.length + 'rego\n'.length;
    const close = markdown.indexOf(fence, bodyStart);
    if (close === -1) break;
    blocks.push(markdown.slice(bodyStart, close));
    from = close + fence.length;
  }
  return blocks;
}

async function check(source: string, name: string): Promise<{ ok: boolean; message: string }> {
  const file = join(workDir, `${name}.rego`);
  await writeFile(file, source);
  // Named relatively from its own directory: OPA's loader resolves an
  // absolute path against the drive the child is on.
  const r = spawnSync(OPA, ['check', '--strict', `${name}.rego`], {
    cwd: workDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ok: r.status === 0, message: (r.stdout || r.stderr).slice(0, 400) };
}

/** Evaluate the terraform example against a plan and return the denials. */
async function denialsFor(policyDocument: unknown): Promise<string[]> {
  const terraform = regoBlocks(PATTERNS).find((b) => b.includes('package terraform'));
  expect(terraform, 'the terraform example must be present').toBeDefined();
  const policyFile = join(workDir, 'terraform.rego');
  await writeFile(policyFile, terraform!);

  const plan = {
    resource_changes: [
      {
        address: 'aws_iam_policy.admin',
        type: 'aws_iam_policy',
        change: { after: { policy: JSON.stringify(policyDocument) } },
      },
    ],
  };
  const inputFile = join(workDir, 'plan.json');
  await writeFile(inputFile, JSON.stringify(plan));

  const r = spawnSync(
    OPA,
    ['eval', '-d', policyFile, '-i', inputFile, '--format', 'json', 'data.terraform.deny'],
    { cwd: workDir, encoding: 'utf8', windowsHide: true },
  );
  const parsed = JSON.parse(r.stdout) as {
    result?: Array<{ expressions?: Array<{ value?: string[] }> }>;
  };
  return parsed.result?.[0]?.expressions?.[0]?.value ?? [];
}

/** Evaluate one shipped package against an input document. */
async function evaluate(packageName: string, query: string, input: unknown): Promise<unknown> {
  const block = regoBlocks(PATTERNS).find((b) => b.includes(`package ${packageName}\n`));
  expect(block, `the ${packageName} example must be present`).toBeDefined();
  const policyFile = join(workDir, `${packageName}.rego`);
  await writeFile(policyFile, block!);
  const inputFile = join(workDir, `${packageName}-input.json`);
  await writeFile(inputFile, JSON.stringify(input));

  const r = spawnSync(OPA, ['eval', '-d', policyFile, '-i', inputFile, '--format', 'json', query], {
    cwd: workDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  const parsed = JSON.parse(r.stdout) as {
    errors?: Array<{ code?: string; message?: string }>;
    result?: Array<{ expressions?: Array<{ value?: unknown }> }>;
  };
  if (parsed.errors?.length) {
    throw new Error(`${parsed.errors[0]!.code}: ${parsed.errors[0]!.message}`);
  }
  return parsed.result?.[0]?.expressions?.[0]?.value;
}

const admin = (action: unknown, resource: unknown) => ({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: action, Resource: resource }],
});

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orygn-shipped-patterns-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('the shipped pattern snippets compile', () => {
  it('every rego block passes opa check --strict', async () => {
    const blocks = regoBlocks(PATTERNS);
    expect(blocks.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const [i, source] of blocks.entries()) {
      const result = await check(source, `block-${i}`);
      if (!result.ok) failures.push(`block ${i}: ${result.message}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  }, 60_000);
});

describe('the Terraform IAM example rejects a full-admin policy', () => {
  // AWS accepts a bare string or an array in each position, and all four
  // spellings grant exactly the same thing.
  const wideOpen: Array<[string, unknown, unknown]> = [
    ['string action, string resource', '*', '*'],
    ['array action, string resource', ['*'], '*'],
    ['string action, array resource', '*', ['*']],
    ['array action, array resource', ['*'], ['*']],
  ];

  for (const [label, action, resource] of wideOpen) {
    it(`denies ${label}`, async () => {
      const denials = await denialsFor(admin(action, resource));
      expect(denials.length, `${label} should be denied`).toBeGreaterThan(0);
    }, 30_000);
  }

  it('denies a wildcard buried in a list of actions', async () => {
    const denials = await denialsFor(admin(['s3:GetObject', '*'], ['*']));
    expect(denials.length).toBeGreaterThan(0);
  }, 30_000);

  it('denies a single Statement object rather than an array', async () => {
    const denials = await denialsFor({
      Version: '2012-10-17',
      Statement: { Effect: 'Allow', Action: '*', Resource: '*' },
    });
    expect(denials.length).toBeGreaterThan(0);
  }, 30_000);

  it('allows a scoped policy, so the rule is not simply denying everything', async () => {
    expect(await denialsFor(admin('s3:GetObject', '*'))).toEqual([]);
    expect(await denialsFor(admin('*', 'arn:aws:s3:::bucket/*'))).toEqual([]);
    expect(await denialsFor(admin(['s3:GetObject'], ['arn:aws:s3:::bucket/*']))).toEqual([]);
  }, 30_000);

  it('allows a Deny statement that names the wildcards', async () => {
    const denials = await denialsFor({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }],
    });
    expect(denials).toEqual([]);
  }, 30_000);
});

describe('the ABAC example denies rather than failing to evaluate', () => {
  // The example carries a rule meant to hide "secret" resources from anyone
  // outside the owning organization. Expressed as a second rule assigning
  // `allow := false`, it was a conflict rather than an override: reading your
  // own secret resource from another organization produced
  // eval_conflict_error instead of a denial, which is exactly the case the
  // comment says the rule exists for.
  const evalAllow = (input: unknown) => evaluate('abac', 'data.abac.allow', input);

  it('denies the owner of a secret resource in another organization', async () => {
    await expect(
      evalAllow({
        action: 'read',
        user: { id: 'u1', org_id: 'o1', roles: [] },
        resource: { owner_id: 'u1', org_id: 'o2', classification: 'secret' },
      }),
    ).resolves.toBe(false);
  }, 30_000);

  it('denies an admin looking at a secret resource in another organization', async () => {
    await expect(
      evalAllow({
        action: 'read',
        user: { id: 'u2', org_id: 'o1', roles: ['admin'] },
        resource: { owner_id: 'u1', org_id: 'o2', classification: 'secret' },
      }),
    ).resolves.toBe(false);
  }, 30_000);

  it('still allows an owner reading their own resource', async () => {
    await expect(
      evalAllow({
        action: 'read',
        user: { id: 'u1', org_id: 'o1', roles: [] },
        resource: { owner_id: 'u1', org_id: 'o1' },
      }),
    ).resolves.toBe(true);
  }, 30_000);

  it('still allows an admin within their own organization, secret included', async () => {
    await expect(
      evalAllow({
        action: 'read',
        user: { id: 'u2', org_id: 'o1', roles: ['admin'] },
        resource: { owner_id: 'u1', org_id: 'o1', classification: 'secret' },
      }),
    ).resolves.toBe(true);
  }, 30_000);

  it('still allows a shared resource within the organization', async () => {
    await expect(
      evalAllow({
        action: 'read',
        user: { id: 'u2', org_id: 'o1', roles: [] },
        resource: { owner_id: 'u1', org_id: 'o1', shared: true },
      }),
    ).resolves.toBe(true);
  }, 30_000);
});
