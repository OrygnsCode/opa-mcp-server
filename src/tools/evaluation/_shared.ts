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
import { mapSubprocessFailure, tryParseJson, validatePaths } from '../../lib/tool-helpers.js';
import type { ToolEnvelope } from '../../types.js';

/** Common input fields shared across rego_eval and its variants. */
export const SharedEvalInput = {
  query: z.string().min(1).describe('Rego query to evaluate, e.g. "data.example.allow".'),
  source: z
    .string()
    .optional()
    .describe('Inline Rego policy source. Mutually exclusive with `paths`.'),
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
};

export interface RegoEvalOutput {
  result?: unknown[];
  errors?: unknown[];
  metrics?: Record<string, unknown>;
  explanation?: unknown[];
  profile?: unknown[];
  coverage?: unknown;
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
}

interface EvalFlags {
  explain?: 'full' | 'notes' | 'fails' | 'debug';
  profile?: boolean;
  coverage?: boolean;
  metrics?: boolean;
}

/**
 * Validate inputs (paths, input/inputPath conflict), call `opa eval`,
 * and return the structured envelope.
 */
export async function runEval(
  opa: OpaCli,
  config: Config,
  args: EvalArgs,
  flags: EvalFlags,
): Promise<ToolEnvelope<RegoEvalOutput>> {
  if (!args.source && !args.paths?.length) {
    return err(
      'INVALID_INPUT',
      'rego_eval requires either `source` or at least one entry in `paths`.',
    );
  }
  if (args.input !== undefined && args.inputPath) {
    return err('INVALID_INPUT', 'rego_eval accepts either `input` or `inputPath`, not both.');
  }

  const evalInput: EvalInput = { query: args.query };
  if (args.source !== undefined) evalInput.source = args.source;

  if (args.paths?.length) {
    const validation = validatePaths(args.paths, config, { mustExist: true });
    if (!validation.ok) return validation.error;
    evalInput.paths = validation.resolved;
  }

  if (args.input !== undefined) {
    let resolvedInput: unknown = args.input;
    if (typeof resolvedInput === 'string') {
      try {
        resolvedInput = JSON.parse(resolvedInput) as unknown;
      } catch {
        // Not a JSON string -- pass as-is (intentional string input).
      }
    }
    evalInput.input = resolvedInput;
  } else if (args.inputPath) {
    const inputPathValidation = validatePaths([args.inputPath], config, { mustExist: true });
    if (!inputPathValidation.ok) return inputPathValidation.error;
    evalInput.inputPath = inputPathValidation.resolved[0];
  }

  if (args.partial) evalInput.partial = true;
  if (args.unknowns?.length) evalInput.unknowns = args.unknowns;
  if (args.strictBuiltinErrors) evalInput.strictBuiltinErrors = true;

  if (flags.explain) evalInput.explain = flags.explain;
  if (flags.profile) evalInput.profile = true;
  if (flags.coverage) evalInput.coverage = true;
  if (flags.metrics) evalInput.metrics = true;

  const result = await opa.eval(evalInput);

  const subprocessFailure = mapSubprocessFailure(result, 'opa');
  if (subprocessFailure) return subprocessFailure;

  // `opa eval` returns exit code 0 even when the query produces no
  // results or partial results. A non-zero exit means a hard error
  // (parse, type, runtime). Output JSON is on stdout.
  const parsed = tryParseJson<RegoEvalOutput>(result.stdout);

  if (result.exitCode !== 0) {
    return err('EVAL_ERROR', 'opa eval exited with an error.', {
      details: parsed ?? { stderr: result.stderr.trim(), stdout: result.stdout.trim() },
    });
  }

  if (parsed === undefined) {
    return err('UNKNOWN_ERROR', 'opa eval produced no parseable JSON output.', {
      details: { stdout: result.stdout.trim() },
    });
  }
  return ok<RegoEvalOutput>(parsed);
}
