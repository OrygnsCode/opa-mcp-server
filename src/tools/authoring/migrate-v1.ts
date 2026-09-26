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
 *      against each one, and every rule of the package is compared.
 *
 * Returns the migrated source even when check finds remaining issues so the
 * caller can inspect the diff and decide how to resolve them.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { packageQuery, planV0Migration, type MigrationRewrite } from '../../lib/rego-migrate.js';
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

/** How many rule-level differences are reported. */
const MAX_DIFFERENCES = 20;

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
      `Up to ${MAX_INPUTS} input documents to check the migration against. The original is evaluated as Rego v0 and the migrated policy as Rego v1 against each one, every rule of the package is compared by value and by type, and \`equivalence\` reports any that differ.`,
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
  original: Outcome;
  migrated: Outcome;
}

export interface MigrationEquivalence {
  /** Inputs compared. */
  compared: number;
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
  /** Present when `inputs` was given and the migrated source is valid. */
  equivalence?: MigrationEquivalence;
}

interface FmtError {
  line: number;
  code: string;
  message: string;
}

/** `opa fmt` prints plain text, one `<file>:<line>: <code>: <message>` per error. */
function parseFmtErrors(stderr: string): FmtError[] {
  return [...stderr.matchAll(/:(\d+): (rego_[a-z_]+): ([^\r\n]*)/g)].map((m) => ({
    line: Number(m[1]),
    code: m[2]!,
    message: m[3]!.trim(),
  }));
}

/** Each input's package document and the type of each of its rules. */
interface SideResult {
  doc?: Record<string, unknown>;
  types?: Record<string, string>;
  error?: string;
}

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
    signal: AbortSignal | undefined,
  ): Promise<SideResult[] | ToolEnvelope<never>> => {
    const batch = await opa.eval(
      {
        source,
        query: `r := [[d, t] | some i; x := input[i]; d := ${query} with input as x; t := {k: type_name(v) | v := d[k]}]`,
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
            query: `d := ${query}; t := {k: type_name(v) | v := d[k]}`,
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
  ): MigrationEquivalence => {
    const differences: MigrationDifference[] = [];
    let total = 0;
    // Rule names are looked up as own keys only: `constructor` is a Rego name
    // as good as any, and also a key of every plain object.
    const forward = new Map(Object.entries(renamed));
    const back = new Map(Object.entries(renamed).map(([from, to]) => [to, from]));
    for (const [input, a] of original.entries()) {
      const b = migrated[input]!;
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
    return { compared: original.length, identical: total === 0, differences };
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
        "Migrate Rego v0 source to Rego v1. First renames what v1 reserves (a rule called `contains`, `every`, `if` or `in`, and every reference to it in the module) and replaces built-ins v1 removed: `re_match` and `net.cidr_overlap` by their v1 names, and `all`, `any`, `set_diff` and the `cast_*` family by a helper function appended to the module that returns exactly what the built-in did, so behaviour does not change. Then `opa fmt --rego-v1` converts the syntax (`if`, `contains`, `import rego.v1`) and `opa check` validates the result. `rewrites` lists each change by line and `notes` says why; a renamed rule must also be renamed in any other module that uses it. Pass `inputs` to evaluate the original as v0 and the result as v1 against each and compare every rule of the package; `equivalence` reports any difference. Returns the migrated source even when check finds remaining errors. A source that is already Rego v1 is returned unchanged. If the source parses as neither, returns `INVALID_REGO` with opa's own message.",
      inputSchema: RegoMigrateV1Input,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source, inputs }, { signal }) => {
      return withToolEnvelope<RegoMigrateV1Output>(config, async () => {
        if (inputs !== undefined && (inputs.length === 0 || inputs.length > MAX_INPUTS)) {
          return err(
            'INVALID_INPUT',
            `\`inputs\` must hold between 1 and ${MAX_INPUTS} documents; it holds ${inputs.length}.`,
          );
        }

        // Step 1: find what the formatter would refuse.
        let parseResult = await opa.parse(
          { source, includeLocations: true, v0Compatible: true },
          signal,
        );
        if (
          parseResult.exitCode !== 0 &&
          /unknown flag: --v0-compatible/.test(parseResult.stderr)
        ) {
          // OPA before 1.0 reads v0 by default and has no flag to ask for it.
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
              ['The source is already Rego v1, so nothing was changed.'],
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
          const errors = parseFmtErrors(stderr);
          const first = errors[0];
          const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
          return err(
            'INVALID_REGO',
            first
              ? `opa fmt --rego-v1 could not convert line ${first.line}: ${first.message}${more}.`
              : 'opa fmt --rego-v1 could not convert the source.',
            {
              hint: 'These lines need changing by hand before the source converts. Line numbers are those of the original.',
              details: { errors, rewrites, ...(errors.length === 0 ? { stderr } : {}) },
            },
          );
        }

        const migrated = fmtResult.stdout;
        const report = await checkAndReport(source, migrated, rewrites, notes, signal);
        if (!report.ok || inputs === undefined || !report.data!.valid) return report;

        // Step 4: compare the two on the inputs given.
        const query = ast !== undefined ? packageQuery(ast) : undefined;
        if (query === undefined) {
          report.data!.notes.push(
            'The package path could not be read, so `inputs` were not compared.',
          );
          return report;
        }
        const before = await evaluateSide(source, query, inputs, true, signal);
        if (!Array.isArray(before)) return before;
        const after = await evaluateSide(migrated, query, inputs, false, signal);
        if (!Array.isArray(after)) return after;
        report.data!.equivalence = compare(before, after, plan?.renamedRules ?? {});
        return report;
      });
    },
  );
}
