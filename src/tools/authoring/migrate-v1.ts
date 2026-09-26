/**
 * `rego_migrate_v1` -- migrate Rego v0 source to Rego v1 syntax.
 *
 * Four steps:
 *   1. `opa parse --v0-compatible` locates every rule named with a word v1
 *      reserves and every call to a built-in v1 removed; see
 *      lib/rego-migrate.ts for how each is rewritten.
 *   2. `opa fmt --rego-v1` converts the rewritten source: `if`, `contains`,
 *      `:=` for rule values, `import rego.v1`.
 *   3. `opa check` validates the result as Rego v1.
 *   4. Given `inputs`, the original is evaluated as v0 and the result as v1
 *      against each one, and every rule of the package is compared, along
 *      with any `queries`, which is how functions get compared.
 *
 * Returns the migrated source even when check finds remaining issues so the
 * caller can inspect the diff and decide how to resolve them.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import {
  calledNames,
  documentRules,
  functionRules,
  packageQuery,
  planV0Migration,
  renameRuleRefs,
  type MigrationRewrite,
} from '../../lib/rego-migrate.js';
import {
  mapSubprocessFailure,
  sanitizeInlinePath,
  sanitizeInlinePathsDeep,
  sanitizeInlineText,
  tryParseJson,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';
import type { ToolEnvelope } from '../../types.js';

/** Most inputs one migration is checked against. */
const MAX_INPUTS = 20;

/** Most expressions compared besides the package's rules. */
const MAX_QUERIES = 10;

/**
 * Built-ins that can return a different value each time a policy is
 * evaluated. `time.now_ns` is not here: both sides get the same clock.
 */
const UNSTABLE_BUILTINS = [
  'http.send',
  'io.jwt.decode_verify',
  'io.jwt.encode_sign',
  'io.jwt.encode_sign_raw',
  'net.lookup_ip_addr',
  'rand.intn',
  'uuid.rfc4122',
];

/** How many rule-level differences are reported. */
const MAX_DIFFERENCES = 20;

/**
 * Most single-rule evaluations spent pinning down inputs whose whole package
 * failed to evaluate, two per rule per input.
 */
const MAX_RULE_EVALS = 200;

const RegoMigrateV1Input = {
  source: z
    .string()
    .min(1)
    .describe(
      'Rego v0 source to migrate to Rego v1 syntax. Rules named with a word v1 reserves are renamed and built-ins v1 removed are replaced before `opa fmt --rego-v1` converts the syntax; any remaining issues are returned in `errors` so you can resolve them manually.',
    ),
  inputs: z
    .array(z.unknown())
    .min(1)
    .max(MAX_INPUTS)
    .optional()
    .describe(
      `Up to ${MAX_INPUTS} input documents to check the migration against. The original is evaluated as Rego v0 and the migrated policy as Rego v1 against each one, every rule of the package that is not a function is compared by value and by type, and \`equivalence\` reports any that differ.`,
    ),
  queries: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_QUERIES)
    .optional()
    .describe(
      `Up to ${MAX_QUERIES} Rego expressions to compare on each of \`inputs\` as well. A function has no value without arguments, so this is how functions are compared: \`data.lib.names.label_ok(input.name, input.label)\`. An expression that names a rule this tool renames, as \`data.<package>.<rule>\`, reaches it under its new name on the migrated side.`,
    ),
};

interface CheckErrorRecord {
  message?: string;
  code?: string;
  location?: { file?: string; row?: number; col?: number };
}

/** One side's outcome for one rule and one input. */
type Outcome = { value: unknown; type: string } | { undefined: true } | { error: string };

export interface MigrationDifference {
  /** Index into `inputs`. */
  input: number;
  /** The rule that differs, by its original name. Absent when a whole evaluation failed on one side. */
  rule?: string;
  /** The expression from `queries` that differs. */
  query?: string;
  original: Outcome;
  migrated: Outcome;
}

export interface MigrationEquivalence {
  /** Inputs compared. */
  compared: number;
  /** The rules compared on each input, by their original name; functions are compared only through `queries`. */
  rules: string[];
  /** True when every rule gave the same value, of the same type, for every input. */
  identical: boolean;
  /** The differences found, up to 20. */
  differences: MigrationDifference[];
}

export interface RegoMigrateV1Output {
  /** The source as provided -- returned for side-by-side comparison. */
  original: string;
  /** The migrated source. Identical to `original` when no changes were needed. */
  migrated: string;
  /** Whether migration changed anything. */
  changed: boolean;
  /** Whether `opa check` found no errors in the migrated source. */
  valid: boolean;
  /** Structured errors from `opa check`. Empty when `valid` is true. */
  errors: CheckErrorRecord[];
  /** Names changed before formatting, by line of the original. */
  rewrites: MigrationRewrite[];
  /** What was renamed or added, and anything else to check, one sentence each. */
  notes: string[];
  /** Present when `inputs` was given, the source was migrated, and the result is valid. */
  equivalence?: MigrationEquivalence;
}

interface FmtError {
  line: number;
  /**
   * What `line` counts: the original source, a helper function appended to
   * it, or the formatter's own output, which has `import rego.v1` added and so
   * no line-for-line match with the original.
   */
  in: 'original' | 'added helper' | 'formatted output';
  code: string;
  message: string;
  /** The text of that line. */
  text?: string;
}

/**
 * `opa fmt` prints plain text, one `<file>:<line>: <code>: <message>` per
 * error. When it formatted the source but the result does not parse, the file
 * is named `formatted` and the line is one of its output.
 */
function parseFmtErrors(stderr: string): Array<Omit<FmtError, 'in'> & { output: boolean }> {
  return [...stderr.matchAll(/(formatted)?:(\d+): (rego_[a-z_]+): ([^\r\n]*)/g)].map((m) => ({
    output: m[1] !== undefined,
    line: Number(m[2]),
    code: m[3]!,
    message: m[4]!.trim(),
  }));
}

/** Each input's package document and the type of each of its rules. */
interface SideResult {
  doc?: Record<string, unknown>;
  types?: Record<string, string>;
  error?: string;
  /**
   * When the whole document failed on either side, each rule evaluated on
   * its own, keyed by its name in the original.
   */
  rules?: Map<string, Outcome>;
}

/** Both sides failing is the same outcome, whatever the wording of each error. */
const bothErrors = (a: Outcome, b: Outcome): boolean => 'error' in a && 'error' in b;

/** One expression's outcome on both sides for every input. */
interface QueryComparison {
  expr: string;
  original: Outcome[];
  migrated: Outcome[];
}

/** An expression's values for one input, from its `[value, type]` pairs. */
const queryOutcome = (pairs: Array<[unknown, string]>): Outcome =>
  pairs.length === 0
    ? { undefined: true }
    : pairs.length === 1
      ? { value: pairs[0]![0], type: pairs[0]![1] }
      : { value: pairs.map(([v]) => v), type: `${pairs.length} values` };

const PER_INPUT_CONCURRENCY = 4;

export function registerRegoMigrateV1(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  /** The first error message in an `opa eval` failure, without temp paths. */
  const evalError = (stdout: string, stderr: string): string => {
    const parsed = tryParseJson<{ errors?: Array<{ message?: string }> }>(stdout);
    const message = parsed?.errors?.[0]?.message ?? (stderr.trim() || 'opa eval failed');
    return sanitizeInlineText(message);
  };

  /**
   * Evaluate the package document for every input on one side. One process
   * evaluates them all under `with input as`; when that fails, because some
   * input raises a runtime error such as a rule conflict, each input is
   * evaluated alone so the failure is pinned to the inputs that cause it.
   */
  const evaluateSide = async (
    source: string,
    query: string,
    inputs: unknown[],
    v0Compatible: boolean,
    mocks: string,
    signal: AbortSignal | undefined,
  ): Promise<SideResult[] | ToolEnvelope<never>> => {
    const batch = await opa.eval(
      {
        source,
        query: `r := [[d, t] | some i; x := input[i]; d := ${query} with input as x${mocks}; t := {k: type_name(v) | v := d[k]}]`,
        input: inputs,
        v0Compatible,
      },
      signal,
    );
    const failure = mapSubprocessFailure(batch, 'opa');
    if (failure) return failure;
    if (batch.exitCode === 0) {
      const parsed = tryParseJson<{
        result?: Array<{
          bindings?: { r?: Array<[Record<string, unknown>, Record<string, string>]> };
        }>;
      }>(batch.stdout);
      const rows = parsed?.result?.[0]?.bindings?.r;
      if (rows?.length === inputs.length) {
        return rows.map(([doc, types]) => ({ doc, types }));
      }
    }

    const results = new Array<SideResult>(inputs.length);
    let next = 0;
    let fatal: ToolEnvelope<never> | undefined;
    const worker = async (): Promise<void> => {
      while (fatal === undefined && next < inputs.length) {
        const index = next++;
        const one = await opa.eval(
          {
            source,
            query: `d := ${query}${mocks}; t := {k: type_name(v) | v := d[k]}`,
            input: inputs[index],
            v0Compatible,
          },
          signal,
        );
        const oneFailure = mapSubprocessFailure(one, 'opa');
        if (oneFailure) {
          fatal = oneFailure;
          return;
        }
        if (one.exitCode !== 0) {
          results[index] = { error: evalError(one.stdout, one.stderr) };
          continue;
        }
        const parsed = tryParseJson<{
          result?: Array<{
            bindings?: { d?: Record<string, unknown>; t?: Record<string, string> };
          }>;
        }>(one.stdout);
        const bindings = parsed?.result?.[0]?.bindings;
        results[index] = bindings?.d
          ? { doc: bindings.d, types: bindings.t ?? {} }
          : { error: 'the package document was undefined' };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PER_INPUT_CONCURRENCY, inputs.length) }, () => worker()),
    );
    return fatal ?? results;
  };

  /** One rule's value and type for one input, or its error. */
  const evaluateRule = async (
    source: string,
    query: string,
    rule: string,
    input: unknown,
    v0Compatible: boolean,
    mocks: string,
    signal: AbortSignal | undefined,
  ): Promise<{ outcome: Outcome } | { fatal: ToolEnvelope<never> }> => {
    const one = await opa.eval(
      {
        source,
        query: `d := ${query}[${JSON.stringify(rule)}]${mocks}; t := type_name(d)`,
        input,
        v0Compatible,
      },
      signal,
    );
    const failure = mapSubprocessFailure(one, 'opa');
    if (failure) return { fatal: failure };
    if (one.exitCode !== 0) return { outcome: { error: evalError(one.stdout, one.stderr) } };
    const bindings = tryParseJson<{
      result?: Array<{ bindings?: { d?: unknown; t?: string } }>;
    }>(one.stdout)?.result?.[0]?.bindings;
    return {
      outcome:
        bindings?.t !== undefined ? { value: bindings.d, type: bindings.t } : { undefined: true },
    };
  };

  /**
   * One expression's outcome for every input on one side. One process
   * evaluates them all; when that fails at runtime, each input is evaluated
   * alone. An expression that does not compile fails alike for every input,
   * and comes back as `compileError`.
   */
  const evaluateQuery = async (
    source: string,
    expr: string,
    inputs: unknown[],
    v0Compatible: boolean,
    mocks: string,
    signal: AbortSignal | undefined,
  ): Promise<{ outcomes: Outcome[] } | { compileError: string } | ToolEnvelope<never>> => {
    // The wrapper's variables carry a prefix, so a variable the expression
    // leaves free, such as `x` in `data.p.deny[x]`, cannot unify with one.
    const batch = await opa.eval(
      {
        source,
        query: `q__r := {[q__i, q__v, type_name(q__v)] | some q__i; q__in := input[q__i]; q__v := (${expr}) with input as q__in${mocks}}`,
        input: inputs,
        v0Compatible,
      },
      signal,
    );
    const failure = mapSubprocessFailure(batch, 'opa');
    if (failure) return failure;
    if (batch.exitCode === 0) {
      const rows =
        tryParseJson<{
          result?: Array<{ bindings?: { q__r?: Array<[number, unknown, string]> } }>;
        }>(batch.stdout)?.result?.[0]?.bindings?.q__r ?? [];
      const byInput = inputs.map((): Array<[unknown, string]> => []);
      for (const [i, value, type] of rows) byInput[i]?.push([value, type]);
      return { outcomes: byInput.map(queryOutcome) };
    }
    const errors = tryParseJson<{ errors?: Array<{ code?: string }> }>(batch.stdout)?.errors ?? [];
    if (errors.length > 0 && errors.every((e) => e.code?.startsWith('rego_'))) {
      return { compileError: evalError(batch.stdout, batch.stderr) };
    }

    const outcomes = new Array<Outcome>(inputs.length);
    let next = 0;
    let fatal: ToolEnvelope<never> | undefined;
    const worker = async (): Promise<void> => {
      while (fatal === undefined && next < inputs.length) {
        const index = next++;
        const one = await opa.eval(
          {
            source,
            query: `q__r := {[q__v, type_name(q__v)] | q__v := (${expr})${mocks}}`,
            input: inputs[index],
            v0Compatible,
          },
          signal,
        );
        const oneFailure = mapSubprocessFailure(one, 'opa');
        if (oneFailure) {
          fatal = oneFailure;
          return;
        }
        outcomes[index] =
          one.exitCode !== 0
            ? { error: evalError(one.stdout, one.stderr) }
            : queryOutcome(
                tryParseJson<{
                  result?: Array<{ bindings?: { q__r?: Array<[unknown, string]> } }>;
                }>(one.stdout)?.result?.[0]?.bindings?.q__r ?? [],
              );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PER_INPUT_CONCURRENCY, inputs.length) }, () => worker()),
    );
    return fatal ?? { outcomes };
  };

  /**
   * For each input whose whole package failed on either side, evaluate every
   * document rule on its own on both sides, so one rule's conflict does not
   * hide a difference in another. Returns how many such inputs were left
   * whole for want of budget, or a failure that ends the call.
   */
  const pinDownFailures = async (
    original: string,
    migrated: string,
    query: string,
    rules: string[],
    renamed: Map<string, string>,
    inputs: unknown[],
    before: SideResult[],
    after: SideResult[],
    v0Flag: boolean,
    mocks: string,
    signal: AbortSignal | undefined,
  ): Promise<number | ToolEnvelope<never>> => {
    const failing = inputs
      .map((_, i) => i)
      .filter((i) => before[i]!.error !== undefined || after[i]!.error !== undefined);
    const perInput = Math.max(1, rules.length * 2);
    const affordable = rules.length === 0 ? 0 : Math.floor(MAX_RULE_EVALS / perInput);
    const chosen = failing.slice(0, affordable);

    const jobs = chosen.flatMap((i) =>
      rules.flatMap((rule) => [
        { i, rule, side: before, source: original, name: rule, v0: v0Flag },
        { i, rule, side: after, source: migrated, name: renamed.get(rule) ?? rule, v0: false },
      ]),
    );
    for (const i of chosen) {
      before[i]!.rules = new Map();
      after[i]!.rules = new Map();
    }
    let next = 0;
    let fatal: ToolEnvelope<never> | undefined;
    const worker = async (): Promise<void> => {
      while (fatal === undefined && next < jobs.length) {
        const job = jobs[next++]!;
        const result = await evaluateRule(
          job.source,
          query,
          job.name,
          inputs[job.i],
          job.v0,
          mocks,
          signal,
        );
        if ('fatal' in result) {
          fatal = result.fatal;
          return;
        }
        job.side[job.i]!.rules!.set(job.rule, result.outcome);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PER_INPUT_CONCURRENCY, jobs.length) }, () => worker()),
    );
    return fatal ?? (rules.length === 0 ? 0 : failing.length - chosen.length);
  };

  const outcome = (side: SideResult, rule: string): Outcome => {
    if (side.error !== undefined) return { error: side.error };
    if (!side.doc || !Object.hasOwn(side.doc, rule)) return { undefined: true };
    return { value: side.doc[rule], type: side.types?.[rule] ?? 'unknown' };
  };

  /** Order-independent JSON for comparing two values. */
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, v: unknown) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    );

  const compare = (
    original: SideResult[],
    migrated: SideResult[],
    renamed: Record<string, string>,
    rules: string[],
    queries: QueryComparison[],
  ): MigrationEquivalence => {
    const differences: MigrationDifference[] = [];
    let total = 0;
    // Rule names are looked up as own keys only: `constructor` is a Rego name
    // as good as any, and also a key of every plain object.
    const forward = new Map(Object.entries(renamed));
    const back = new Map(Object.entries(renamed).map(([from, to]) => [to, from]));
    for (const [input, a] of original.entries()) {
      const b = migrated[input]!;
      for (const { expr, original: before, migrated: after } of queries) {
        const left = before[input]!;
        const right = after[input]!;
        if (bothErrors(left, right) || canonical(left) === canonical(right)) continue;
        total++;
        if (differences.length < MAX_DIFFERENCES) {
          differences.push({ input, query: expr, original: left, migrated: right });
        }
      }
      if (a.rules && b.rules) {
        for (const [rule, left] of a.rules) {
          const right = b.rules.get(rule) ?? { undefined: true };
          if (bothErrors(left, right) || canonical(left) === canonical(right)) continue;
          total++;
          if (differences.length < MAX_DIFFERENCES) {
            differences.push({ input, rule, original: left, migrated: right });
          }
        }
        continue;
      }
      if (a.error !== undefined || b.error !== undefined) {
        // Both failing is the same outcome: a conflict the original raised
        // is one a faithful migration raises too.
        if (a.error === undefined || b.error === undefined) {
          total++;
          if (differences.length < MAX_DIFFERENCES) {
            differences.push({
              input,
              original:
                a.error !== undefined ? { error: a.error } : { value: a.doc, type: 'object' },
              migrated:
                b.error !== undefined ? { error: b.error } : { value: b.doc, type: 'object' },
            });
          }
        }
        continue;
      }
      const rules = new Set([
        ...Object.keys(a.doc ?? {}),
        ...Object.keys(b.doc ?? {}).map((k) => back.get(k) ?? k),
      ]);
      for (const rule of [...rules].sort()) {
        const left = outcome(a, rule);
        const right = outcome(b, forward.get(rule) ?? rule);
        if (canonical(left) === canonical(right)) continue;
        total++;
        if (differences.length < MAX_DIFFERENCES) {
          differences.push({ input, rule, original: left, migrated: right });
        }
      }
    }
    return { compared: original.length, rules, identical: total === 0, differences };
  };

  /** Step 3: validate the result as Rego v1 and build the report. */
  const checkAndReport = async (
    original: string,
    migrated: string,
    rewrites: MigrationRewrite[],
    notes: string[],
    signal: AbortSignal | undefined,
  ): Promise<ToolEnvelope<RegoMigrateV1Output>> => {
    const checkResult = await opa.check({ source: migrated, v1Compatible: true }, signal);
    const checkFailure = mapSubprocessFailure(checkResult, 'opa');
    if (checkFailure) return checkFailure;

    const base = { original, migrated, changed: migrated !== original, rewrites, notes };
    if (checkResult.exitCode === 0) {
      return ok<RegoMigrateV1Output>({ ...base, valid: true, errors: [] });
    }

    // Check found remaining issues -- return them alongside the partial migration.
    const parsed = tryParseJson<{ errors?: CheckErrorRecord[] }>(checkResult.stderr);
    const errors = (parsed?.errors ?? []).map((e) =>
      e.location?.file
        ? { ...e, location: { ...e.location, file: sanitizeInlinePath(e.location.file) } }
        : e,
    );
    return ok<RegoMigrateV1Output>({ ...base, valid: false, errors });
  };

  server.registerTool(
    'rego_migrate_v1',
    {
      title: 'Migrate Rego to v1 syntax',
      description:
        "Migrate Rego v0 source to Rego v1. First renames what v1 reserves (a rule called `contains`, `every`, `if` or `in`, and every reference to it in the module) and replaces built-ins v1 removed: `re_match` and `net.cidr_overlap` by their v1 names, and `all`, `any`, `set_diff` and the `cast_*` family by a helper function appended to the module that returns exactly what the built-in did, so behaviour does not change. `re_match` and `net.cidr_overlap` get such a helper too where the rename would change behaviour: the module mocks one spelling with `with` while calling both, or binds `regex` or `net` itself. Then `opa fmt --rego-v1` converts the syntax (`if`, `contains`, `import rego.v1`) and `opa check` validates the result. `rewrites` lists each change by line and `notes` says why; a renamed rule must also be renamed in any other module that uses it. Pass `inputs` to evaluate the original as v0 and the result as v1 against each and compare every rule of the package, and `queries` to compare expressions too, such as calls to its functions; `equivalence` reports any difference. Evaluating runs the policy, `http.send` included. Returns the migrated source even when check finds remaining errors. A source that parses only as Rego v1 is returned unchanged; one that parses as both, such as v1 that imports `rego.v1`, is reformatted like any other. If the source parses as neither, returns `INVALID_REGO` with opa's own message.",
      inputSchema: RegoMigrateV1Input,
      annotations: {
        readOnlyHint: false,
        // With `inputs` it runs the policy, and a policy can reach the network through http.send.
        openWorldHint: true,
      },
    },
    async ({ source, inputs, queries }, { signal }) => {
      return withToolEnvelope<RegoMigrateV1Output>(config, async () => {
        if (inputs !== undefined && (inputs.length === 0 || inputs.length > MAX_INPUTS)) {
          return err(
            'INVALID_INPUT',
            `\`inputs\` must hold between 1 and ${MAX_INPUTS} documents; it holds ${inputs.length}.`,
          );
        }
        if (queries !== undefined) {
          if (queries.length === 0 || queries.length > MAX_QUERIES) {
            return err(
              'INVALID_INPUT',
              `\`queries\` must hold between 1 and ${MAX_QUERIES} expressions; it holds ${queries.length}.`,
            );
          }
          if (inputs === undefined) {
            return err(
              'INVALID_INPUT',
              '`queries` are compared on each of `inputs`; pass those too.',
              {
                hint: 'For expressions that read no input, pass `inputs: [{}]`.',
              },
            );
          }
        }

        // Step 1: find what the formatter would refuse. OPA before 1.0 reads
        // v0 by default and has no flag to ask for it, so the flag is dropped
        // for every call that reads the original.
        let v0Flag = true;
        let parseResult = await opa.parse(
          { source, includeLocations: true, v0Compatible: true },
          signal,
        );
        if (
          parseResult.exitCode !== 0 &&
          /unknown flag: --v0-compatible/.test(parseResult.stderr)
        ) {
          v0Flag = false;
          parseResult = await opa.parse({ source, includeLocations: true }, signal);
        }
        const parseFailure = mapSubprocessFailure(parseResult, 'opa');
        if (parseFailure) return parseFailure;

        if (parseResult.exitCode !== 0) {
          // Not v0. If it is already v1 there is nothing to migrate.
          const asV1 = await opa.parse({ source }, signal);
          const v1Failure = mapSubprocessFailure(asV1, 'opa');
          if (v1Failure) return v1Failure;
          if (asV1.exitCode === 0) {
            return checkAndReport(
              source,
              source,
              [],
              [
                inputs === undefined
                  ? 'The source is already Rego v1, so nothing was changed.'
                  : 'The source is already Rego v1, so nothing was changed and there was nothing to compare `inputs` against.',
              ],
              signal,
            );
          }
          // opa parse writes its error report to stderr.
          const parsedErrors = (
            tryParseJson<{ errors?: CheckErrorRecord[] }>(parseResult.stderr) ??
            tryParseJson<{ errors?: CheckErrorRecord[] }>(parseResult.stdout)
          )?.errors;
          const first = parsedErrors?.[0];
          return err(
            'INVALID_REGO',
            `The source parses as neither Rego v0 nor Rego v1${first?.message ? `: ${first.message}` : ''}${first?.location?.row ? ` (line ${first.location.row})` : ''}.`,
            {
              hint: 'Fix the syntax at the line given, then migrate again.',
              details: sanitizeInlinePathsDeep(
                parsedErrors ? { errors: parsedErrors } : { stderr: parseResult.stderr.trim() },
              ),
            },
          );
        }

        const ast = tryParseJson(parseResult.stdout);
        const plan = ast !== undefined ? planV0Migration(source, ast) : undefined;
        const notes = plan
          ? [...plan.notes]
          : [
              'The locations opa reported did not match the source, so no rule was renamed and no built-in replaced; the source went to the formatter as written.',
            ];
        const rewritten = plan?.source ?? source;
        const rewrites = plan?.rewrites ?? [];

        // Step 2: convert the syntax.
        const fmtResult = await opa.fmt({ source: rewritten, regoV1: true }, signal);
        const fmtFailure = mapSubprocessFailure(fmtResult, 'opa');
        if (fmtFailure) return fmtFailure;

        if (fmtResult.exitCode !== 0) {
          const stderr = sanitizeInlineText(fmtResult.stderr.trim());
          const parsed = parseFmtErrors(stderr);
          // A line of the formatter's output has no match in the original, so
          // the output is fetched to quote it.
          let output: string[] = [];
          if (parsed.some((e) => e.output)) {
            const unchecked = await opa.fmt(
              { source: rewritten, regoV1: true, checkResult: false },
              signal,
            );
            if (unchecked.exitCode === 0) output = unchecked.stdout.split('\n');
          }
          const originalLines = source.split('\n').length;
          const rewrittenLines = rewritten.split('\n');
          const errors: FmtError[] = parsed.map(({ output: inOutput, ...e }) => {
            const where: FmtError['in'] = inOutput
              ? 'formatted output'
              : e.line > originalLines
                ? 'added helper'
                : 'original';
            const text = (inOutput ? output[e.line - 1] : rewrittenLines[e.line - 1])?.trim();
            return { ...e, in: where, ...(text ? { text } : {}) };
          });
          const first = errors[0];
          const place = first
            ? first.in === 'original'
              ? `line ${first.line}`
              : `line ${first.line} of the ${first.in}${first.text ? ` (\`${first.text}\`)` : ''}`
            : '';
          const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
          return err(
            'INVALID_REGO',
            first
              ? `opa fmt --rego-v1 could not convert ${place}: ${first.message}${more}.`
              : 'opa fmt --rego-v1 could not convert the source.',
            {
              hint: 'Change what is named by hand, then migrate again. Each error says whether its line is one of the original, of a helper added to it, or of the formatted output.',
              details: {
                errors,
                rewrites,
                notes,
                ...(errors.length === 0 ? { stderr } : {}),
              },
            },
          );
        }

        const migrated = fmtResult.stdout;
        const report = await checkAndReport(source, migrated, rewrites, notes, signal);
        if (!report.ok || inputs === undefined) return report;
        if (!report.data!.valid) {
          report.data!.notes.push(
            'The migrated source does not pass `opa check`, so `inputs` were not compared.',
          );
          return report;
        }

        // Step 4: compare the two on the inputs given.
        const query = ast !== undefined ? packageQuery(ast) : undefined;
        if (query === undefined) {
          report.data!.notes.push(
            'The package path could not be read, so `inputs` were not compared.',
          );
          return report;
        }
        // Each side is its own opa process, so a clock read on each would
        // differ; both get the same time.
        const called = calledNames(ast);
        const mocks = called.has('time.now_ns') ? ` with time.now_ns as ${Date.now()}000000` : '';
        const rules = documentRules(ast);
        const renamedRules = plan?.renamedRules ?? {};

        const before = await evaluateSide(source, query, inputs, v0Flag, mocks, signal);
        if (!Array.isArray(before)) return before;
        const after = await evaluateSide(migrated, query, inputs, false, mocks, signal);
        if (!Array.isArray(after)) return after;
        const left = await pinDownFailures(
          source,
          migrated,
          query,
          rules,
          new Map(Object.entries(renamedRules)),
          inputs,
          before,
          after,
          v0Flag,
          mocks,
          signal,
        );
        if (typeof left !== 'number') return left;

        const compared: QueryComparison[] = [];
        for (const [i, expr] of (queries ?? []).entries()) {
          const a = await evaluateQuery(source, expr, inputs, v0Flag, mocks, signal);
          if ('ok' in a) return a;
          const migratedExpr = renameRuleRefs(expr, ast, renamedRules);
          const b = await evaluateQuery(migrated, migratedExpr, inputs, false, mocks, signal);
          if ('ok' in b) return b;
          if ('compileError' in a && 'compileError' in b) {
            return err('INVALID_INPUT', `\`queries[${i}]\` does not compile: ${a.compileError}`, {
              hint: "Give an expression, such as a call to one of the package's functions, that names the package by its full path: `data.<package>.<rule>`.",
            });
          }
          const outcomes = (r: typeof a): Outcome[] =>
            'compileError' in r ? inputs.map(() => ({ error: r.compileError })) : r.outcomes;
          compared.push({ expr, original: outcomes(a), migrated: outcomes(b) });
        }

        const reportNotes = report.data!.notes;
        if (left > 0) {
          reportNotes.push(
            `${left} input(s) raised an error on at least one side and were compared as a whole package, not rule by rule, so an error on both sides there counts as agreement.`,
          );
        }
        const functions = functionRules(ast);
        if (functions.length > 0 && queries === undefined) {
          reportNotes.push(
            `${rules.length === 0 ? 'Nothing was compared: ' : ''}the functions ${functions.map((f) => `\`${f}\``).join(', ')} have no value without arguments; pass \`queries\` that call them to compare them.`,
          );
        } else if (rules.length === 0 && queries === undefined) {
          reportNotes.push('The package defines no rules, so nothing was compared.');
        }
        if (mocks) {
          reportNotes.push(
            '`time.now_ns()` gave both sides the same time, so rules that read the clock were compared.',
          );
        }
        const unstable = UNSTABLE_BUILTINS.filter((b) => called.has(b));
        if (unstable.length > 0) {
          reportNotes.push(
            `${unstable.map((b) => `\`${b}\``).join(', ')} can return something different each time the policy is evaluated, and each side is evaluated separately, so a difference in a rule that depends on it need not come from the migration.`,
          );
        }
        report.data!.equivalence = compare(before, after, renamedRules, rules, compared);
        return report;
      });
    },
  );
}
