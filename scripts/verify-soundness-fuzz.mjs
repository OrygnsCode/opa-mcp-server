/**
 * Generative soundness fuzzer for rego_verify.
 *
 * Builds policies combinatorially across the dimensions that actually broke:
 * defaults, head values, clause count, body operators, helper references, and
 * constructs the encoder is expected to refuse. Ground truth for every policy
 * comes from the real OPA binary, so a verdict that contradicts OPA is unsound
 * regardless of what the engine believes internally.
 *
 * Exit code is the number of unsound verdicts, capped at 250.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ground truth comes from this binary, so picking the wrong one silently
 * invalidates the entire run. Prefer the bundled platform binary over whatever
 * `opa` happens to be on PATH, which on a dev machine is often an old build.
 */
function resolveOpa() {
  if (process.env.OPA_BINARY) return process.env.OPA_BINARY;
  const exe = process.platform === 'win32' ? 'opa.exe' : 'opa';
  const bundled = join(
    root,
    'node_modules',
    `@orygn/opa-mcp-${process.platform}-${process.arch}`,
    exe,
  );
  return existsSync(bundled) ? bundled : 'opa';
}

const OPA = resolveOpa();

/**
 * Refuse a pre-1.0 OPA. Rego v1 is the syntax every generated policy uses, and
 * an old binary rejects it wholesale: every policy would "fail" identically and
 * the run would report a clean sweep while checking nothing.
 */
{
  const v = spawnSync(OPA, ['version'], { encoding: 'utf8', windowsHide: true });
  if (v.status !== 0) {
    console.error(`cannot run OPA at ${OPA}. Set OPA_BINARY to a 1.x binary.`);
    process.exit(255);
  }
  const major = Number(/Version:\s*v?(\d+)\./.exec(v.stdout)?.[1] ?? -1);
  if (!(major >= 1)) {
    console.error(
      [
        `OPA at ${OPA} reports: ${v.stdout.trim().split('\n')[0]}`,
        'This fuzzer needs OPA 1.x; it is the oracle, and a pre-1.0 binary cannot parse Rego v1.',
        'Set OPA_BINARY to a 1.x binary.',
      ].join('\n'),
    );
    process.exit(255);
  }
  console.log(`oracle: ${OPA} (v${major}.x)`);
}

const dir = mkdtempSync(join(tmpdir(), 'vgen-'));
const enginePath = join(root, 'dist', 'lib', 'rego-verify-engine.js');
if (!existsSync(enginePath)) {
  console.error('dist/ not built. Run `npm run build` first.');
  process.exit(255);
}
const { runVerify } = await import(pathToFileURL(enginePath).href);

const DOMAIN = [
  {},
  { x: 'a' },
  { x: 'b' },
  { x: '' },
  { x: null },
  { x: 1 },
  { x: true },
  { n: 0 },
  { n: 1 },
  { n: 5 },
  { n: -1 },
  { n: 0.5 },
  { n: 2.5 },
  { n: -0.5 },
  { n: null },
  { f: true },
  { f: false },
  { f: null },
  { s: 'prefix-y' },
  { s: 'y-suffix' },
  { s: 'mid' },
  { s: '' },
  { x: 'a', n: 1 },
  { x: 'b', n: 5 },
  { x: 'a', f: true },
  { n: 1, f: false },
  { x: 'a', n: 0.5, f: true, s: 'prefix-z' },
];

// ── policy generation ─────────────────────────────────────────────────────
const BODIES = [
  ['input.x == "a"', 'eq_str'],
  ['input.x != "a"', 'neq_str'],
  ['input.n > 5', 'gt'],
  ['input.n < 1', 'lt'],
  ['input.n >= 0', 'gte'],
  ['input.n == 1', 'eq_num'],
  ['input.n == 0.5', 'eq_frac'],
  ['input.f', 'bool_check'],
  ['startswith(input.s, "prefix")', 'startswith'],
  ['endswith(input.s, "suffix")', 'endswith'],
  ['true', 'lit_true'],
  ['false', 'lit_false'],
  ['input.x == null', 'eq_null'],
  ['input.n > 0\n\tinput.n < 1', 'frac_range'],
  ['input.x == "a"\n\tinput.x == "b"', 'contradiction'],
  ['x := input.x\n\tx == "a"', 'local'],
];
const DEFAULTS = [null, 'true', 'false'];
const HEADS = [null, 'true', 'false', '"deny"', '3'];

function gen() {
  const out = [];
  let id = 0;

  // Single-clause: every default x head x body combination.
  for (const d of DEFAULTS) {
    for (const h of HEADS) {
      for (const [body, bname] of BODIES) {
        const head = h === null ? 'allow' : `allow := ${h}`;
        const def = d === null ? '' : `default allow := ${d}\n\n`;
        out.push({
          name: `s${id++}_d${d ?? 'none'}_h${h ?? 'none'}_${bname}`,
          src: `package t\n\n${def}${head} if {\n\t${body}\n}\n`,
          rule: 'allow',
        });
      }
    }
  }

  // Two clauses, exercising OR plus mixed head values.
  for (const d of DEFAULTS) {
    for (const [b1, n1] of BODIES.slice(0, 8)) {
      for (const h2 of ['true', 'false']) {
        const def = d === null ? '' : `default allow := ${d}\n\n`;
        out.push({
          name: `m${id++}_d${d ?? 'none'}_${n1}_h2${h2}`,
          src:
            `package t\n\n${def}allow if {\n\t${b1}\n}\n\n` +
            `allow := ${h2} if {\n\tinput.n == 5\n}\n`,
          rule: 'allow',
        });
      }
    }
  }

  // Helper references, with and without a default on the helper.
  for (const hd of [null, 'true', 'false']) {
    for (const hh of ['true', 'false']) {
      for (const [body, bname] of BODIES.slice(0, 6)) {
        const def = hd === null ? '' : `default helper := ${hd}\n\n`;
        out.push({
          name: `h${id++}_hd${hd ?? 'none'}_hh${hh}_${bname}`,
          src:
            `package t\n\nallow if {\n\thelper\n}\n\n${def}` +
            `helper := ${hh} if {\n\t${body}\n}\n`,
          rule: 'allow',
        });
      }
    }
  }

  // Shapes the encoder must refuse rather than guess about.
  out.push(
    {
      name: 'partial_set',
      src: 'package t\n\ndeny contains "x" if {\n\tinput.n == 1\n}\n',
      rule: 'deny',
    },
    {
      name: 'partial_obj',
      src: 'package t\n\nperms["a"] := "r" if {\n\tinput.n == 1\n}\n',
      rule: 'perms',
    },
    {
      name: 'else_chain',
      src: 'package t\n\nallow if {\n\tinput.n == 1\n} else := false\n',
      rule: 'allow',
    },
    { name: 'naf', src: 'package t\n\nallow if {\n\tnot input.f\n}\n', rule: 'allow' },
    {
      name: 'comprehension',
      src: 'package t\n\nallow if {\n\tcount([1 | input.n > 0]) > 0\n}\n',
      rule: 'allow',
    },
    { name: 'default_only_true', src: 'package t\n\ndefault allow := true\n', rule: 'allow' },
    { name: 'default_only_false', src: 'package t\n\ndefault allow := false\n', rule: 'allow' },
    { name: 'missing_rule', src: 'package t\n\nother if {\n\tinput.n == 1\n}\n', rule: 'allow' },
  );

  return out;
}

// ── ground truth ──────────────────────────────────────────────────────────
const pfile = join(dir, 'p.rego');

function evalRule(src, rule, input) {
  writeFileSync(pfile, src);
  const r = spawnSync(OPA, ['eval', '-d', pfile, '-I', '--format', 'json', `data.t.${rule}`], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) return { err: true };
  try {
    const e = JSON.parse(r.stdout).result?.[0]?.expressions;
    return { value: e && e.length ? e[0].value : undefined };
  } catch {
    return { err: true };
  }
}

function parse(src) {
  writeFileSync(pfile, src);
  const r = spawnSync(OPA, ['parse', pfile, '--format', 'json'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// ── run ───────────────────────────────────────────────────────────────────
const policies = gen();
console.log(`  generated ${policies.length} policies, ${policies.length * 3} verdicts to check`);

let total = 0,
  inconc = 0,
  unsound = 0,
  skipped = 0;
const bad = [];
let done = 0;

for (const p of policies) {
  const ast = parse(p.src);
  if (!ast) {
    skipped++;
    continue;
  }

  const trueOn = [];
  let evalBroken = false;
  for (const inp of DOMAIN) {
    const { value, err } = evalRule(p.src, p.rule, inp);
    if (err) {
      evalBroken = true;
      break;
    }
    if (value === true) trueOn.push(inp);
  }
  if (evalBroken) {
    skipped++;
    continue;
  }
  const anyTrue = trueOn.length > 0;
  const allTrue = trueOn.length === DOMAIN.length;

  for (const kind of ['always_true', 'never_true', 'satisfiable']) {
    total++;
    let res;
    try {
      res = await runVerify(ast, { kind, ruleName: p.rule });
    } catch (e) {
      unsound++;
      bad.push([p.name, kind, 'THREW', String(e).slice(0, 60)]);
      continue;
    }
    const v = res.verdict;
    if (v === 'inconclusive') {
      inconc++;
      continue;
    }

    let why = '';
    if (kind === 'always_true' && v === 'proven' && !allTrue) {
      why = `PROVEN always_true but false on ${DOMAIN.length - trueOn.length} probes`;
    } else if (kind === 'never_true' && v === 'proven' && anyTrue) {
      why = `PROVEN never_true but true on ${JSON.stringify(trueOn[0])}`;
    } else if (kind === 'satisfiable' && v === 'unsatisfiable' && anyTrue) {
      why = `UNSATISFIABLE but true on ${JSON.stringify(trueOn[0])}`;
    } else if (v === 'counterexample' && res.counterexample) {
      const { value } = evalRule(p.src, p.rule, res.counterexample);
      if (kind === 'always_true' && value === true) {
        why = `counterexample ${JSON.stringify(res.counterexample)} does not falsify`;
      } else if (kind === 'never_true' && value !== true) {
        why = `counterexample ${JSON.stringify(res.counterexample)} does not satisfy`;
      }
    }
    if (why) {
      unsound++;
      bad.push([p.name, kind, v, why]);
    }
  }

  if (++done % 25 === 0) process.stdout.write(`  ...${done}/${policies.length} policies\n`);
}

console.log(`\n  policies: ${policies.length}  skipped: ${skipped}`);
console.log(`  verdicts: ${total}  inconclusive: ${inconc}  UNSOUND: ${unsound}`);
if (bad.length) {
  console.log('\n  unsound:');
  for (const [n, k, v, w] of bad.slice(0, 40)) {
    console.log(`    ${n.slice(0, 34).padEnd(36)} ${k.padEnd(13)} ${String(v).padEnd(15)} ${w}`);
  }
  if (bad.length > 40) console.log(`    ...and ${bad.length - 40} more`);
}
rmSync(dir, { recursive: true, force: true });
process.exit(Math.min(unsound, 250));
