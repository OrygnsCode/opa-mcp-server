/**
 * Shared helpers for the evaluation tool category.
 *
 * `rego_eval` and its three trace/profile/coverage variants all share
 * the same input/output shape and error handling -- only the OPA flags
 * differ. The shared `runEval` helper takes the resolved EvalInput and
 * returns an envelope; each tool's handler is a thin adapter that
 * preps inputs and forwards.
 */
import { z } from 'zod';

import type { Config } from '../../config.js';
import { err, ok } from '../../lib/errors.js';
import type { OpaCli, EvalInput } from '../../lib/opa-cli.js';
import {
  mapSubprocessFailure,
  sanitizeInlinePathsDeep,
  tryParseJson,
  validatePaths,
} from '../../lib/tool-helpers.js';
import type { ToolEnvelope } from '../../types.js';
import { mentionsPreV1, PRE_V1_HINT, v0CompatibleField } from '../_rego-version.js';

/** Common input fields shared across rego_eval and its variants. */
export const SharedEvalInput = {
  query: z.string().min(1).describe('Rego query to evaluate, e.g. "data.example.allow".'),
  source: z
    .string()
    .optional()
    .describe(
      'Inline Rego policy source. Optional: without `source` or `paths` the query runs on its own, which is enough to try a built-in or an expression.',
    ),
  paths: z
    .array(z.string())
    .optional()
    .describe('Policy / data file or directory paths. Each must be inside an allowed root.'),
  input: z.unknown().optional().describe('Inline input document.'),
  inputPath: z
    .string()
    .optional()
    .describe('Path to a JSON input file. Mutually exclusive with `input`.'),
  unknowns: z
    .array(z.string())
    .optional()
    .describe('Refs to treat as unknown during partial evaluation.'),
  partial: z.boolean().optional().describe('Run partial evaluation rather than full evaluation.'),
  strictBuiltinErrors: z
    .boolean()
    .optional()
    .describe('Treat builtin errors as fatal instead of returning undefined.'),
  v0Compatible: v0CompatibleField,
};

export interface RegoEvalOutput {
  /**
   * Whether the query produced a value. Absent for a partial evaluation. An
   * undefined result is not `false`: a rule with no `default` that matched
   * nothing is undefined, which opa reports as an empty object.
   */
  defined?: boolean;
  result?: unknown[];
  /** The residual of a partial evaluation, in place of `result`. */
  partial?: unknown;
  errors?: unknown[];
  metrics?: Record<string, unknown>;
  explanation?: unknown[];
  profile?: unknown[];
  coverage?: unknown;
  /** Lines the policy wrote with `print()`, which opa sends to stderr. */
  printed?: string[];
  /**
   * Present when the query came back undefined, referred to `data`, and no
   * policy or data was loaded: the undefined result then says nothing about
   * any policy.
   */
  hint?: string;
}

/** Whether a query refers to the data document, outside its string literals. */
function readsData(query: string): boolean {
  const code = query.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""');
  // `input.data` is a field of the input, not the data document.
  return /(?<![.\w])data\b/.test(code);
}

interface EvalArgs {
  query: string;
  source?: string;
  paths?: string[];
  input?: unknown;
  inputPath?: string;
  unknowns?: string[];
  partial?: boolean;
  strictBuiltinErrors?: boolean;
  v0Compatible?: boolean;
}

interface EvalFlags {
  explain?: 'full' | 'notes' | 'fails' | 'debug';
  profile?: boolean;
  coverage?: boolean;
  metrics?: boolean;
}

/**
 * Validate inputs (paths, input/inputPath conflict) and build the arguments
 * for `opa eval`, or return the error envelope for the first problem.
 */
function prepareEval(
  config: Config,
  args: EvalArgs,
  flags: EvalFlags,
): { ok: true; evalInput: EvalInput } | { ok: false; error: ToolEnvelope<never> } {
  if (args.input !== undefined && args.inputPath) {
    return {
      ok: false,
      error: err('INVALID_INPUT', 'rego_eval accepts either `input` or `inputPath`, not both.'),
    };
  }

  const evalInput: EvalInput = { query: args.query };
  // An empty `source` is no policy, as it was before a policy became
  // optional; handed to opa it fails as an `empty module`.
  if (args.source !== undefined && args.source.trim() !== '') evalInput.source = args.source;

  if (args.paths?.length) {
    const validation = validatePaths(args.paths, config, { mustExist: true });
    if (!validation.ok) return validation;
    evalInput.paths = validation.resolved;
  }

  if (args.input !== undefined) {
    // Passed through as given. A JSON object or array that arrived as a string
    // is repaired at the opa-cli boundary by coerceJsonArg, the same way for
    // every tool; parsing it here as well retyped a string such as "42" or
    // "true" into a number or boolean, and the policy saw a different input.
    evalInput.input = args.input;
  } else if (args.inputPath) {
    const inputPathValidation = validatePaths([args.inputPath], config, { mustExist: true });
    if (!inputPathValidation.ok) return inputPathValidation;
    evalInput.inputPath = inputPathValidation.resolved[0];
  }

  if (args.partial) evalInput.partial = true;
  if (args.unknowns?.length) evalInput.unknowns = args.unknowns;
  if (args.strictBuiltinErrors) evalInput.strictBuiltinErrors = true;
  if (args.v0Compatible) evalInput.v0Compatible = true;

  if (flags.explain) evalInput.explain = flags.explain;
  if (flags.profile) evalInput.profile = true;
  if (flags.coverage) evalInput.coverage = true;
  if (flags.metrics) evalInput.metrics = true;

  return { ok: true, evalInput };
}

/** Call `opa eval` and turn its output into the structured envelope. */
async function executeEval(
  opa: OpaCli,
  evalInput: EvalInput,
  signal?: AbortSignal,
): Promise<ToolEnvelope<RegoEvalOutput>> {
  const result = await opa.eval(evalInput, signal);

  const subprocessFailure = mapSubprocessFailure(result, 'opa');
  if (subprocessFailure) return subprocessFailure;

  // `opa eval` returns exit code 0 even when the query produces no
  // results or partial results. A non-zero exit means a hard error
  // (parse, type, runtime). Output JSON is on stdout.
  const parsed = tryParseJson<RegoEvalOutput>(result.stdout);

  if (result.exitCode !== 0) {
    // The diagnostics name the temp file the inline source was written to;
    // the success path already hides it, and the failure path must too.
    const details = sanitizeInlinePathsDeep(
      parsed ?? { stderr: result.stderr.trim(), stdout: result.stdout.trim() },
    );
    const errors = (parsed as { errors?: Array<{ code?: unknown; message?: unknown }> } | undefined)
      ?.errors;
    // A policy or query that does not compile is the caller's Rego to fix, as
    // opa_exec and the conftest tools report it; EVAL_ERROR stays for a
    // failure at evaluation time.
    const compile =
      Array.isArray(errors) &&
      errors.length > 0 &&
      errors.every((e) => typeof e.code === 'string' && e.code.startsWith('rego_'));
    const preV1 =
      !evalInput.v0Compatible &&
      mentionsPreV1(...(errors ?? []).map((e) => e.message), result.stderr);
    return err(
      compile ? 'INVALID_REGO' : 'EVAL_ERROR',
      compile ? 'The policy or query does not compile.' : 'opa eval exited with an error.',
      { ...(preV1 ? { hint: PRE_V1_HINT } : {}), details },
    );
  }

  if (parsed === undefined) {
    return err('UNKNOWN_ERROR', 'opa eval produced no parseable JSON output.', {
      details: sanitizeInlinePathsDeep({ stdout: result.stdout.trim() }),
    });
  }

  // OPA references the temp file it wrote inline source to in trace, coverage,
  // and profile output. Normalize those paths to <inline> for consistency with
  // rego_check and to avoid exposing the temp directory layout.
  if (parsed.explanation) {
    parsed.explanation = sanitizeInlinePathsDeep(parsed.explanation) as unknown[];
  }
  if (parsed.coverage !== undefined) {
    parsed.coverage = sanitizeInlinePathsDeep(parsed.coverage);
  }
  if (parsed.profile) {
    parsed.profile = sanitizeInlinePathsDeep(parsed.profile) as unknown[];
  }

  // `print()` writes to stderr on a successful run; dropping it hid the one
  // debugging aid Rego has.
  const printed = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (printed.length > 0) parsed.printed = sanitizeInlinePathsDeep(printed) as string[];
  if (!evalInput.partial) parsed.defined = (parsed.result?.length ?? 0) > 0;

  // A query run with nothing loaded is how a built-in or an expression gets
  // tried out. The same call naming a rule is almost always a forgotten
  // `source`, and its undefined result would otherwise read as the policy
  // denying. A partial evaluation is undefined when no residual query is left.
  const nothingLoaded = evalInput.source === undefined && !evalInput.paths?.length;
  const cameBackUndefined = evalInput.partial
    ? !(parsed.partial as { queries?: unknown[] } | undefined)?.queries?.length
    : !parsed.result?.length;
  if (nothingLoaded && cameBackUndefined && readsData(evalInput.query)) {
    parsed.hint =
      'No policy or data was loaded (neither `source` nor `paths` was given), so every `data` reference in the query is undefined.';
  }

  return ok<RegoEvalOutput>(parsed);
}

/**
 * Validate inputs, call `opa eval`, and return the structured envelope.
 */
export async function runEval(
  opa: OpaCli,
  config: Config,
  args: EvalArgs,
  flags: EvalFlags,
  signal?: AbortSignal,
): Promise<ToolEnvelope<RegoEvalOutput>> {
  const prepared = prepareEval(config, args, flags);
  if (!prepared.ok) return prepared.error;
  return executeEval(opa, prepared.evalInput, signal);
}

/** Most inputs one `rego_eval` call evaluates. */
export const MAX_BATCH_INPUTS = 50;

/** How many `opa eval` processes a batch runs at once. */
const BATCH_CONCURRENCY = 4;

export interface RegoEvalBatchEntry {
  /** Position of this input in `inputs`. */
  index: number;
  /** Whether the query produced a value for this input. Absent for a partial evaluation. */
  defined?: boolean;
  /** OPA's result for this input. Empty when the query was undefined for it. */
  result?: unknown[];
  /** Lines the policy wrote with `print()` for this input. */
  printed?: string[];
  /** For a partial evaluation, the residual for this input, in place of `result`. */
  partial?: unknown;
  /**
   * Set instead of `result` when OPA could not evaluate this input. The code
   * is `NOT_EVALUATED` for an input the batch stopped before reaching.
   */
  error?: { code: string; message: string; hint?: string; details?: unknown };
}

export interface RegoEvalBatchOutput {
  /** One entry per element of `inputs`, in the same order. */
  batch: RegoEvalBatchEntry[];
  /** Inputs with an `error`, those not evaluated included. */
  errorCount: number;
  /** See `RegoEvalOutput.hint`. */
  hint?: string;
}

/**
 * Whether a failure is the same whatever the input, so the call fails once
 * instead of once per input. Only a runtime error belongs to an input: an
 * EVAL_ERROR whose every error carries one of OPA's `eval_*` codes. Anything
 * else fails the same way for every input: cancellation, a missing binary, a
 * policy or query that does not compile (`rego_*`), and a data file that does
 * not load, which OPA reports with no code at all.
 */
function failsBatch(error: { code: string; details?: unknown }): boolean {
  if (['CANCELLED', 'OPA_BINARY_NOT_FOUND', 'INVALID_REGO'].includes(error.code)) return true;
  if (error.code !== 'EVAL_ERROR') return false;
  const errors = (error.details as { errors?: Array<{ code?: unknown }> } | undefined)?.errors;
  const runtime =
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((e) => typeof e.code === 'string' && e.code.startsWith('eval_'));
  return !runtime;
}

/**
 * A timeout or an outside kill may belong to one large input, so it is
 * reported against that input; but the next inputs would likely wait out the
 * same limit, one round at a time, so none are started after it.
 */
const stopsBatch = (code: string): boolean => code === 'TIMEOUT' || code === 'SUBPROCESS_KILLED';

/**
 * Evaluate the same query once per input document.
 *
 * One `opa eval` per input. Wrapping the caller's query in a comprehension
 * under `with input as` would evaluate them all in one process, but only for
 * a single-expression query, and a runtime error raised by one input (a rule
 * conflict) would then fail every input. Here an input that fails at runtime
 * is reported in its own entry and the rest still run; see `failsBatch` and
 * `stopsBatch` for the failures that end it.
 */
export async function runEvalBatch(
  opa: OpaCli,
  config: Config,
  args: EvalArgs,
  inputs: unknown[],
  signal?: AbortSignal,
): Promise<ToolEnvelope<RegoEvalBatchOutput>> {
  if (args.input !== undefined || args.inputPath) {
    return err('INVALID_INPUT', 'rego_eval accepts `inputs` or `input`/`inputPath`, not both.');
  }
  if (inputs.length === 0 || inputs.length > MAX_BATCH_INPUTS) {
    return err(
      'INVALID_INPUT',
      `\`inputs\` must hold between 1 and ${MAX_BATCH_INPUTS} documents; it holds ${inputs.length}.`,
    );
  }
  if (args.partial && (!args.unknowns?.length || args.unknowns.some((u) => u.trim() === 'input'))) {
    return err(
      'INVALID_INPUT',
      'With `partial` and the whole of `input` unknown, which is also what no `unknowns` means, opa ignores each input document, so every entry would get the same residual.',
      { hint: 'Name the part that stays unknown, for example `unknowns: ["input.region"]`.' },
    );
  }
  const prepared = prepareEval(config, args, {});
  if (!prepared.ok) return prepared.error;
  const base = prepared.evalInput;

  const entries = new Array<RegoEvalBatchEntry>(inputs.length);
  let fatal: ToolEnvelope<never> | undefined;
  let stoppedAt: { index: number; code: string } | undefined;
  let hint: string | undefined;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (fatal === undefined && stoppedAt === undefined && next < inputs.length) {
      const index = next++;
      let envelope: ToolEnvelope<RegoEvalOutput>;
      try {
        envelope = await executeEval(opa, { ...base, input: inputs[index] }, signal);
      } catch (e) {
        // Stop the other workers too, rather than let them keep spawning.
        fatal ??= err('UNKNOWN_ERROR', e instanceof Error ? e.message : String(e));
        return;
      }
      if (envelope.ok) {
        const data = envelope.data!;
        entries[index] =
          data.partial !== undefined
            ? { index, partial: data.partial }
            : { index, defined: data.defined ?? false, result: data.result ?? [] };
        if (data.printed !== undefined) entries[index].printed = data.printed;
        hint ??= data.hint;
        continue;
      }
      const e = envelope.error!;
      if (failsBatch(e)) {
        fatal ??= err(e.code, e.message, { hint: e.hint, details: e.details });
        return;
      }
      entries[index] = {
        index,
        error: {
          code: e.code,
          message: e.message,
          ...(e.hint !== undefined ? { hint: e.hint } : {}),
          ...(e.details !== undefined ? { details: e.details } : {}),
        },
      };
      if (stopsBatch(e.code)) stoppedAt ??= { index, code: e.code };
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, inputs.length) }, () => worker()),
  );
  if (fatal !== undefined) return fatal;

  if (stoppedAt !== undefined) {
    const cause = stoppedAt.code === 'TIMEOUT' ? 'timed out' : 'was killed';
    for (let index = 0; index < inputs.length; index++) {
      entries[index] ??= {
        index,
        error: {
          code: 'NOT_EVALUATED',
          message: `Not evaluated: the batch stopped when input ${stoppedAt.index} ${cause}.`,
        },
      };
    }
  }

  return ok<RegoEvalBatchOutput>({
    batch: entries,
    errorCount: entries.filter((e) => e.error !== undefined).length,
    ...(hint !== undefined ? { hint } : {}),
  });
}
