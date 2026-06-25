/**
 * `rego_explain_undefined` -- determine why a Rego query produces no
 * value by combining a plain eval, a full-trace eval, and per-condition
 * AST analysis.
 *
 * Three information sources are fused:
 *  1. Plain `opa eval` -- determines whether the result is defined at all.
 *  2. `opa eval --explain=full` -- captures which rule bodies OPA entered
 *     and which expressions failed at runtime.
 *  3. `opa parse --json-include locations,-comments` -- supplies
 *     base64-encoded expression text and row numbers for conditions that
 *     OPA's indexer eliminated before entering the rule body (the most
 *     common case for equality checks on `input.*`).
 *
 * For rules that appear in the trace (OPA entered them), the blocking
 * condition is identified by matching Fail-event rows against body-
 * expression rows from the AST. For rules that do not appear in the trace
 * (indexed out), each body expression is evaluated as a standalone query
 * to determine which one is not satisfied.
 */
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Config } from '../../config.js';
import { err, ok } from '../../lib/errors.js';
import { OpaCli } from '../../lib/opa-cli.js';
import {
  mapSubprocessFailure,
  sanitizeInlinePath,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';

// ─── Input schema ───────────────────────────────────────────────────────────

const RegoExplainUndefinedInput = {
  query: z
    .string()
    .min(1)
    .describe(
      'Fully-qualified rule reference to explain, e.g. "data.authz.allow". ' +
        'Must match the path you would pass to rego_eval.',
    ),
  source: z
    .string()
    .optional()
    .describe('Inline Rego source to analyse. Mutually exclusive with paths.'),
  paths: z
    .array(z.string())
    .optional()
    .describe('Policy .rego file paths to load. Mutually exclusive with source.'),
  input: z.unknown().optional().describe('Input document (JSON value) for the query.'),
  inputPath: z.string().optional().describe('Path to an input JSON file.'),
};

// ─── OPA AST types (subset) ─────────────────────────────────────────────────

interface AstLoc {
  file?: string;
  row?: number;
  col?: number;
  text?: string; // base64-encoded source text when includeLocations: true
}

interface AstHead {
  name?: string;
  ref?: Array<{ value?: unknown }>;
  value?: { value?: unknown };
}

interface AstExpr {
  terms?: unknown;
  location?: AstLoc;
}

interface AstRule {
  head?: AstHead;
  body?: AstExpr[];
  location?: AstLoc;
  default?: boolean;
}

interface OpaAst {
  package?: { path?: Array<{ value?: string }> };
  rules?: AstRule[];
}

// ─── Trace event types ──────────────────────────────────────────────────────

interface TraceEvent {
  Op?: string;
  Node?: { head?: AstHead; location?: AstLoc };
  Location?: AstLoc;
  QueryID?: number;
  Message?: string;
}

// ─── Output types ───────────────────────────────────────────────────────────

export interface ConditionResult {
  /** Zero-based index of this expression in the rule body. */
  index: number;
  /** Decoded source text of the expression, or "<expression>" if unavailable. */
  text: string;
  /** Source line number. */
  row: number;
  /** Source column number. */
  col: number;
  /** Evaluation outcome for this condition. */
  result: 'true' | 'false' | 'unevaluable';
  /** Additional context when result is "unevaluable". */
  note?: string;
}

export interface RuleAnalysis {
  /** Zero-based index of this rule among all matched rules. */
  ruleIndex: number;
  /** Whether this is a default rule (default allow := false). */
  isDefault: boolean;
  /** Source location of the rule head. */
  location: { file: string; row: number; col: number };
  /** Per-condition results for each body expression. */
  conditions: ConditionResult[];
  /** First condition that is not satisfied, or null if undetermined. */
  blockingCondition: ConditionResult | null;
  /** How the conditions were determined. */
  source: 'trace' | 'standalone-eval';
}

export interface RegoExplainUndefinedOutput {
  /** Whether the query produced a value or not. */
  queryResult: 'undefined' | 'defined';
  /** Present only when queryResult is "defined". */
  value?: unknown;
  /** Human-readable explanation. */
  summary: string;
  /** Number of non-default rule definitions matched. */
  rulesFound: number;
  /** Value from the default rule, if one was found. */
  defaultValue?: unknown;
  /** Per-rule breakdown. */
  rules: RuleAnalysis[];
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function decodeBase64Text(b64: string | undefined): string | undefined {
  if (!b64) return undefined;
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function extractPackagePath(ast: OpaAst): string {
  return (ast.package?.path ?? []).map((p) => String(p.value ?? '')).join('.');
}

function extractRuleHeadName(head: AstHead | undefined): string | undefined {
  if (!head) return undefined;
  if (head.name) return head.name;
  if (Array.isArray(head.ref) && head.ref.length > 0) {
    const v = head.ref[0]!.value;
    return typeof v === 'string' ? v : '';
  }
  return undefined;
}

function queryToPackageAndRule(query: string): { packagePath: string; ruleName: string } | null {
  const parts = query.split('.');
  if (parts.length < 2) return null;
  return {
    ruleName: parts[parts.length - 1]!,
    packagePath: parts.slice(0, -1).join('.'),
  };
}

function ruleAppearsInTrace(
  ruleName: string,
  ruleRow: number | undefined,
  trace: TraceEvent[],
): boolean {
  return trace.some((ev) => {
    if (ev.Op?.toLowerCase() !== 'enter') return false;
    if (!ev.Node) return false;
    if (extractRuleHeadName(ev.Node.head) !== ruleName) return false;
    // When we have source row information, use it to disambiguate incremental rules.
    if (ruleRow !== undefined && ev.Node.location?.row !== undefined) {
      return ev.Node.location.row === ruleRow;
    }
    return true;
  });
}

function findBlockingRowFromTrace(rule: AstRule, trace: TraceEvent[]): number | undefined {
  const ruleName = extractRuleHeadName(rule.head);
  const ruleRow = rule.location?.row;
  const bodyRows = new Set(
    (rule.body ?? []).map((e) => e.location?.row).filter((r): r is number => r !== undefined),
  );
  if (bodyRows.size === 0) return undefined;

  // Locate the Enter event for this specific rule definition.
  const enterIdx = trace.findIndex((ev) => {
    if (ev.Op?.toLowerCase() !== 'enter') return false;
    if (extractRuleHeadName(ev.Node?.head) !== ruleName) return false;
    if (ruleRow !== undefined && ev.Node?.location?.row !== undefined) {
      return ev.Node.location.row === ruleRow;
    }
    return true;
  });
  if (enterIdx < 0) return undefined;

  // Find the first Fail event after the Enter that falls on a body expression row.
  for (let i = enterIdx + 1; i < trace.length; i++) {
    const ev = trace[i]!;
    // Stop when we enter or exit the same-named rule at a different row (sibling).
    if (
      (ev.Op?.toLowerCase() === 'enter' || ev.Op?.toLowerCase() === 'exit') &&
      extractRuleHeadName(ev.Node?.head) === ruleName &&
      ruleRow !== undefined &&
      ev.Node?.location?.row !== ruleRow
    ) {
      break;
    }
    if (ev.Op?.toLowerCase() === 'fail' && ev.Location?.row !== undefined) {
      if (bodyRows.has(ev.Location.row)) return ev.Location.row;
    }
  }
  return undefined;
}

async function evalConditionStandalone(
  exprText: string,
  evalBase: {
    source?: string;
    paths?: string[];
    input?: unknown;
    inputPath?: string;
  },
  opa: OpaCli,
  signal: AbortSignal | undefined,
): Promise<Pick<ConditionResult, 'result' | 'note'>> {
  const result = await opa.eval(
    {
      query: exprText,
      source: evalBase.source,
      paths: evalBase.paths,
      input: evalBase.input,
      inputPath: evalBase.inputPath,
    },
    signal,
  );

  if (result.exitCode === null || result.exitCode !== 0) {
    const firstLine =
      (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? 'unknown error';
    return { result: 'unevaluable', note: `Standalone eval failed: ${firstLine}` };
  }

  // OPA returns a result row for a body expression even when it evaluates to a
  // false value -- e.g. `input.user.tier == "premium"` against tier "free"
  // yields a row whose expression value is `false`, not an empty result. A
  // condition is satisfied only when it produces a solution whose expressions
  // are all defined and not `false`, so inspect the expression values rather
  // than merely the presence of a row (which would mark every comparison true).
  const parsed = tryParseJson<{
    result?: Array<{ expressions?: Array<{ value?: unknown }> }>;
  }>(result.stdout);
  const satisfied = (parsed?.result ?? []).some((row) => {
    const exprs = row.expressions ?? [];
    return exprs.length > 0 && exprs.every((e) => e.value !== undefined && e.value !== false);
  });
  return satisfied ? { result: 'true' } : { result: 'false' };
}

function buildSummary(query: string, rules: RuleAnalysis[], defaultValue: unknown): string {
  const lines: string[] = [];

  if (rules.length === 0) {
    lines.push(`${query} is undefined: no matching rules found in the analysed source.`);
  } else {
    const count = rules.length;
    lines.push(
      `${query} is undefined. ${count} rule definition${count !== 1 ? 's' : ''} analysed:`,
    );
    for (const r of rules) {
      const loc = r.location.row > 0 ? ` (row ${r.location.row})` : '';
      const bc = r.blockingCondition;
      if (bc) {
        const how = r.source === 'trace' ? 'trace' : 'standalone eval';
        lines.push(
          `  Rule ${r.ruleIndex}${loc}: blocked by condition ${bc.index + 1} -- ` +
            `\`${bc.text}\` (row ${bc.row}) is not satisfied [via ${how}].`,
        );
      } else if (r.conditions.length === 0) {
        lines.push(`  Rule ${r.ruleIndex}${loc}: no analysable body conditions.`);
      } else {
        const unevalCount = r.conditions.filter((c) => c.result === 'unevaluable').length;
        lines.push(
          `  Rule ${r.ruleIndex}${loc}: blocking condition could not be determined ` +
            `(${unevalCount} unevaluable expression${unevalCount !== 1 ? 's' : ''}).`,
        );
      }
    }
  }

  if (defaultValue !== undefined) {
    lines.push(`Default value: ${JSON.stringify(defaultValue)}.`);
  }

  return lines.join('\n');
}

// ─── Tool registration ──────────────────────────────────────────────────────

export function registerRegoExplainUndefined(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_explain_undefined',
    {
      title: 'Explain why a Rego query is undefined',
      description:
        'Diagnose why a fully-qualified Rego query (e.g. "data.authz.allow") produces no ' +
        'value. Combines a plain eval, a full-trace eval, and per-condition AST analysis to ' +
        'identify the exact body expression blocking each rule. Handles both runtime failures ' +
        '(trace-based) and indexer elimination (standalone condition eval). Returns a structured ' +
        'breakdown of which conditions blocked each rule plus a human-readable summary.',
      inputSchema: RegoExplainUndefinedInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, { signal }) => {
      return withToolEnvelope<RegoExplainUndefinedOutput>(config, async () => {
        // ── Path validation ───────────────────────────────────────────────
        let resolvedPaths: string[] = [];
        if (args.paths?.length) {
          const pv = validatePaths(args.paths, config, { mustExist: true });
          if (!pv.ok) return pv.error;
          resolvedPaths = pv.resolved;
        }
        if (args.inputPath) {
          const iv = validatePaths([args.inputPath], config, { mustExist: true });
          if (!iv.ok) return iv.error;
        }

        const evalBase = {
          query: args.query,
          source: args.source,
          paths: resolvedPaths.length > 0 ? resolvedPaths : undefined,
          input: args.input,
          inputPath: args.inputPath,
        };

        // ── Step 1: plain eval ────────────────────────────────────────────
        const plainResult = await opa.eval(evalBase, signal);
        const spawnErr = mapSubprocessFailure(plainResult, 'opa');
        if (spawnErr) return spawnErr;

        if (plainResult.exitCode !== 0) {
          const detail =
            tryParseJson<{ errors?: unknown }>(plainResult.stderr) ??
            tryParseJson(plainResult.stdout) ??
            plainResult.stderr;
          return err('EVAL_ERROR', 'OPA evaluation failed.', {
            details: { opaOutput: detail },
            hint: 'Check for syntax errors or undefined references in the query or policy.',
          });
        }

        const plainJson = tryParseJson<{ result?: unknown[] }>(plainResult.stdout);
        const isDefined = (plainJson?.result?.length ?? 0) > 0;

        if (isDefined) {
          const value = (
            plainJson!.result as Array<{ expressions?: Array<{ value?: unknown }> }>
          )[0]?.expressions?.[0]?.value;
          return ok<RegoExplainUndefinedOutput>({
            queryResult: 'defined',
            value,
            summary: `${args.query} is defined with value: ${JSON.stringify(value)}.`,
            rulesFound: 0,
            rules: [],
          });
        }

        // ── Step 2: eval with --explain=full ──────────────────────────────
        const traceResult = await opa.eval({ ...evalBase, explain: 'full' }, signal);
        const traceSpawnErr = mapSubprocessFailure(traceResult, 'opa');
        if (traceSpawnErr) return traceSpawnErr;

        const traceJson = tryParseJson<{ explanation?: TraceEvent[] }>(traceResult.stdout);
        const trace = traceJson?.explanation ?? [];

        // ── Step 3: parse AST(s) ──────────────────────────────────────────
        const asts: OpaAst[] = [];

        if (args.source) {
          const pr = await opa.parse({ source: args.source, includeLocations: true }, signal);
          if (pr.exitCode === 0) {
            const ast = tryParseJson<OpaAst>(pr.stdout);
            if (ast) asts.push(ast);
          }
        } else if (resolvedPaths.length > 0) {
          const regoFiles = resolvedPaths.filter((p) => p.endsWith('.rego'));
          for (const filePath of regoFiles) {
            try {
              const src = await readFile(filePath, 'utf8');
              const pr = await opa.parse({ source: src, includeLocations: true }, signal);
              if (pr.exitCode === 0) {
                const ast = tryParseJson<OpaAst>(pr.stdout);
                if (ast) asts.push(ast);
              }
            } catch {
              // Unreadable file; still usable for eval
            }
          }
        }

        // ── Step 4: find matching rules ───────────────────────────────────
        const queryParsed = queryToPackageAndRule(args.query);
        const matchedRules: AstRule[] = [];

        for (const ast of asts) {
          const pkgPath = extractPackagePath(ast);
          if (queryParsed && pkgPath !== queryParsed.packagePath) continue;
          for (const rule of ast.rules ?? []) {
            const name = extractRuleHeadName(rule.head);
            if (!queryParsed || name === queryParsed.ruleName) {
              matchedRules.push(rule);
            }
          }
        }

        // ── Step 5: analyse each rule ─────────────────────────────────────
        let defaultValue: unknown;
        const rules: RuleAnalysis[] = [];

        for (let ruleIndex = 0; ruleIndex < matchedRules.length; ruleIndex++) {
          const rule = matchedRules[ruleIndex]!;
          const location = {
            file: sanitizeInlinePath(rule.location?.file ?? ''),
            row: rule.location?.row ?? 0,
            col: rule.location?.col ?? 0,
          };

          if (rule.default) {
            defaultValue = rule.head?.value?.value;
            rules.push({
              ruleIndex,
              isDefault: true,
              location,
              conditions: [],
              blockingCondition: null,
              source: 'trace',
            });
            continue;
          }

          const ruleName = extractRuleHeadName(rule.head) ?? '';
          const bodyExprs = rule.body ?? [];

          const conditions: ConditionResult[] = bodyExprs.map((expr, i) => ({
            index: i,
            text: decodeBase64Text(expr.location?.text) ?? '<expression>',
            row: expr.location?.row ?? 0,
            col: expr.location?.col ?? 0,
            result: 'unevaluable' as const,
          }));

          const inTrace = ruleAppearsInTrace(ruleName, rule.location?.row, trace);

          if (inTrace) {
            // Trace-based: find first Fail event that hits a body row.
            const blockingRow = findBlockingRowFromTrace(rule, trace);
            let seenBlocking = false;
            for (const cond of conditions) {
              if (!seenBlocking && blockingRow !== undefined && cond.row === blockingRow) {
                cond.result = 'false';
                seenBlocking = true;
              } else if (!seenBlocking && cond.row > 0 && blockingRow !== undefined) {
                // Conditions before the blocking one successfully passed.
                cond.result = 'true';
              }
            }
            const blockingCondition = conditions.find((c) => c.result === 'false') ?? null;
            rules.push({
              ruleIndex,
              isDefault: false,
              location,
              conditions,
              blockingCondition,
              source: 'trace',
            });
          } else {
            // Standalone eval: OPA's indexer eliminated this rule before
            // entering its body. Evaluate each condition independently.
            for (const cond of conditions) {
              if (cond.text === '<expression>') {
                cond.note = 'No location text available; cannot evaluate standalone.';
                continue;
              }
              const evalOut = await evalConditionStandalone(cond.text, evalBase, opa, signal);
              cond.result = evalOut.result;
              if (evalOut.note) cond.note = evalOut.note;
            }
            const blockingCondition = conditions.find((c) => c.result !== 'true') ?? null;
            rules.push({
              ruleIndex,
              isDefault: false,
              location,
              conditions,
              blockingCondition,
              source: 'standalone-eval',
            });
          }
        }

        const nonDefaultRules = rules.filter((r) => !r.isDefault);
        const summary = buildSummary(args.query, nonDefaultRules, defaultValue);

        return ok<RegoExplainUndefinedOutput>({
          queryResult: 'undefined',
          summary,
          rulesFound: nonDefaultRules.length,
          defaultValue,
          rules,
        });
      });
    },
  );
}
