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
import { v0CompatibleField } from '../_rego-version.js';

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
  result?: unknown[];
  errors?: unknown[];
  metrics?: Record<string, unknown>;
  explanation?: unknown[];
  profile?: unknown[];
  coverage?: unknown;
  /**
   * Present when the query came back undefined, referred to `data`, and no
   * policy or data was loaded: the undefined result then says nothing about
   * any policy.
   */
  hint?: string;
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
  if (args.source !== undefined) evalInput.source = args.source;

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
    return err('EVAL_ERROR', 'opa eval exited with an error.', {
      details: sanitizeInlinePathsDeep(
        parsed ?? { stderr: result.stderr.trim(), stdout: result.stdout.trim() },
      ),
    });
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

  // A query run with nothing loaded is how a built-in or an expression gets
  // tried out. The same call naming a rule is almost always a forgotten
  // `source`, and its undefined result would otherwise read as the policy
  // denying. `input.data` is a field of the input, not the data document.
  const nothingLoaded = evalInput.source === undefined && !evalInput.paths?.length;
  if (nothingLoaded && !parsed.result?.length && /(?<![.\w])data\b/.test(evalInput.query)) {
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
  /** OPA's result for this input. Empty when the query was undefined for it. */
  result?: unknown[];
  /** Set instead of `result` when OPA could not evaluate this input. */
  error?: { code: string; message: string; details?: unknown };
}

export interface RegoEvalBatchOutput {
  /** One entry per element of `inputs`, in the same order. */
  batch: RegoEvalBatchEntry[];
  /** Inputs whose evaluation failed, each carrying `error`. */
  errorCount: number;
  /** See `RegoEvalOutput.hint`. */
  hint?: string;
}

/**
 * Evaluate the same query once per input document.
 *
 * One `opa eval` per input. Wrapping the caller's query in a comprehension
 * under `with input as` would evaluate them all in one process, but only for
 * a single-expression query, and a runtime error raised by one input (a rule
 * conflict) would then fail every input. Here an input that fails is reported
 * in its own entry and the rest still run. Cancellation and a missing binary
 * end the whole call, since no later input could fare better.
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
  const prepared = prepareEval(config, args, {});
  if (!prepared.ok) return prepared.error;
  const base = prepared.evalInput;

  const entries = new Array<RegoEvalBatchEntry>(inputs.length);
  let fatal: ToolEnvelope<never> | undefined;
  let hint: string | undefined;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (fatal === undefined && next < inputs.length) {
      const index = next++;
      const envelope = await executeEval(opa, { ...base, input: inputs[index] }, signal);
      if (envelope.ok) {
        const data = envelope.data!;
        entries[index] = { index, result: data.result ?? [] };
        hint ??= data.hint;
        continue;
      }
      const e = envelope.error!;
      if (e.code === 'CANCELLED' || e.code === 'OPA_BINARY_NOT_FOUND') {
        fatal ??= err(e.code, e.message, { hint: e.hint, details: e.details });
        return;
      }
      entries[index] = {
        index,
        error: {
          code: e.code,
          message: e.message,
          ...(e.details !== undefined ? { details: e.details } : {}),
        },
      };
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, inputs.length) }, () => worker()),
  );
  if (fatal !== undefined) return fatal;

  return ok<RegoEvalBatchOutput>({
    batch: entries,
    errorCount: entries.filter((e) => e.error !== undefined).length,
    ...(hint !== undefined ? { hint } : {}),
  });
}
