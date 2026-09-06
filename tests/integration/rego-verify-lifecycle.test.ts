/**
 * The Z3 lifecycle under load, against the real engine.
 *
 * As shipped, 1500 solves in one process grew it from 59 MB to 950 MB, and a
 * collection forced mid-run crashed it inside a hundred solves: z3-solver's
 * finalizers ran on the main thread while the worker solved over the same
 * memory. Both are pinned here: memory stays bounded across many solves, and
 * collections forced between solves, the pattern that crashed, are survived.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';

import type { OpaModule } from '../../src/lib/rego-ast-types.js';
import { runVerify } from '../../src/lib/rego-verify-engine.js';
import { getZ3, markZ3Unusable } from '../../src/lib/rego-z3.js';

const OPA = process.env['OPA_BINARY'] ?? 'opa';
const workDir = mkdtempSync(join(tmpdir(), 'orygn-verify-lifecycle-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const SOURCES = [
  'package t\n\nallow if {\n\tinput.user.role == "admin"\n\tinput.n > 5\n}\n',
  'package t\n\nallow if {\n\tstartswith(input.s, "prefix")\n\tinput.x != "a"\n}\n',
  'package t\n\ndefault allow := false\n\nallow if {\n\tinput.a.b == "x"\n\tinput.a.c == "y"\n}\n',
  'package t\n\nallow if {\n\thelper\n}\n\ndefault helper := true\n\nhelper := false if {\n\tinput.o == "q"\n\tinput.o.p == "q"\n}\n',
];
const KINDS = ['always_true', 'never_true', 'satisfiable'] as const;

function parse(src: string, i: number): OpaModule {
  const file = join(workDir, `p${i}.rego`);
  writeFileSync(file, src);
  return JSON.parse(
    execFileSync(OPA, ['parse', '--format=json', file], { encoding: 'utf8' }),
  ) as OpaModule;
}

/** Z3's own figure for its live allocations, in MB; independent of the process. */
async function z3MemoryMb(): Promise<number> {
  const Z3 = await getZ3();
  const solver = new Z3.Solver();
  solver.add(Z3.Bool.const('probe'));
  await solver.check();
  const value = Number(solver.statistics().get('memory'));
  solver.release();
  return value;
}

describe('rego_verify lifecycle', () => {
  const asts = SOURCES.map(parse);

  it('keeps Z3 memory bounded across many solves', async () => {
    const before = await z3MemoryMb();
    for (let i = 0; i < 300; i++) {
      const res = await runVerify(asts[i % asts.length]!, {
        kind: KINDS[i % 3]!,
        ruleName: 'allow',
      });
      expect(res.verdict, res.message).not.toBe('inconclusive');
    }
    const after = await z3MemoryMb();
    // As shipped this grew by roughly half a megabyte per solve.
    expect(after - before, `Z3 memory grew from ${before} to ${after} MB`).toBeLessThan(48);
  }, 120_000);

  it('survives collections forced between solves', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    for (let i = 0; i < 200; i++) {
      const res = await runVerify(asts[i % asts.length]!, {
        kind: KINDS[i % 3]!,
        ruleName: 'allow',
      });
      expect(res.verdict, res.message).not.toBe('inconclusive');
      // No settling: the finalizers this schedules must not touch Z3 while
      // the next solve runs. As shipped this crashed inside a hundred solves.
      if (i % 5 === 0) gc();
    }
  }, 120_000);

  it('answers the call after a fault from a fresh module', async () => {
    markZ3Unusable('simulated fault');
    const res = await runVerify(asts[0]!, { kind: 'satisfiable', ruleName: 'allow' });
    expect(res.verdict).toBe('proven');
  }, 60_000);
});
