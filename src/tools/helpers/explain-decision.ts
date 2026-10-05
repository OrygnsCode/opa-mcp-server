/**
 * `rego_explain_decision` -- run a query with `--explain=full` and return the
 * result, the rules entered and the rules that produced a value, and the trace
 * as readable lines (see `renderTrace`).
 *
 * rego_eval_with_explain returns OPA's raw trace, whose AST nodes put even a
 * one-pod admission request past the response cap; this tool returned that
 * same trace, so on a real policy it came back as a truncation marker.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { fitPrefix } from '../../lib/output.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { renderTrace, type TraceEvent } from '../../lib/trace-render.js';
import { runEval, SharedEvalInput, type RegoEvalOutput } from '../evaluation/_shared.js';

export interface RegoExplainDecisionOutput {
  result: unknown;
  errors?: unknown[];
  /** See `RegoEvalOutput.hint`: set when nothing was loaded for a `data` query. */
  hint?: string;
  rulesFired: string[];
  rulesEvaluated: string[];
  /** The trace as readable lines, backtracking (Redo) events left out. */
  trace: string[];
  summary: {
    totalEvents: number;
    enterEvents: number;
    exitEvents: number;
    failEvents: number;
    redoOmitted: number;
  };
  /** Set when the trace was cut from the end to fit the response cap. */
  traceTruncated?: { shown: number; total: number };
}

function extractRuleName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  return (node as { head?: { name?: string } }).head?.name;
}

function summarizeTrace(trace: TraceEvent[] | undefined): Omit<
  RegoExplainDecisionOutput['summary'],
  'redoOmitted'
> & {
  rulesEvaluated: Set<string>;
  rulesFired: Set<string>;
} {
  const rulesEvaluated = new Set<string>();
  const rulesFired = new Set<string>();
  let enterEvents = 0;
  let exitEvents = 0;
  let failEvents = 0;
  for (const event of trace ?? []) {
    const op = event.Op?.toLowerCase();
    if (op === 'enter') {
      enterEvents += 1;
      const name = extractRuleName(event.Node);
      if (name) rulesEvaluated.add(name);
    } else if (op === 'exit') {
      exitEvents += 1;
      const name = extractRuleName(event.Node);
      if (name) rulesFired.add(name);
    } else if (op === 'fail') {
      failEvents += 1;
    }
  }
  return {
    totalEvents: trace?.length ?? 0,
    enterEvents,
    exitEvents,
    failEvents,
    rulesEvaluated,
    rulesFired,
  };
}

export function registerRegoExplainDecision(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_explain_decision',
    {
      title: 'Explain Rego decision',
      description:
        'Evaluate a Rego query with full tracing and return the result, the rules entered (`rulesEvaluated`) and those that produced a value (`rulesFired`), and the trace as readable lines: location, nesting, operation, the expression in Rego syntax, and the values of the variables it names. Backtracking (Redo) events are left out. Use it to answer "why was this denied?" or "why did this rule not match?": the `Fail` lines name the condition that stopped a rule. A trace too long for the response cap is cut from the end (`traceTruncated`); narrow the query or the input to see the rest.',
      inputSchema: SharedEvalInput,
      annotations: {
        readOnlyHint: false,
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
      },
    },
    async (args, { signal }) => {
      return withToolEnvelope<RegoExplainDecisionOutput>(
        config,
        async () => {
          const evalEnvelope = await runEval(opa, config, args, { explain: 'full' }, signal);
          if (!evalEnvelope.ok) {
            // Re-issue the same error under this tool's output type.
            return err(evalEnvelope.error!.code, evalEnvelope.error!.message, {
              hint: evalEnvelope.error!.hint,
              details: evalEnvelope.error!.details,
            });
          }
          const data = evalEnvelope.data as RegoEvalOutput;

          const trace = (data.explanation ?? []) as TraceEvent[];
          const summary = summarizeTrace(trace);
          const rendered = renderTrace(trace);

          return ok<RegoExplainDecisionOutput>({
            result:
              data.result?.[0] !== undefined
                ? (data.result as Array<{ expressions?: Array<{ value?: unknown }> }>)[0]
                    ?.expressions?.[0]?.value
                : undefined,
            errors: data.errors,
            ...(data.hint !== undefined ? { hint: data.hint } : {}),
            rulesFired: [...summary.rulesFired],
            rulesEvaluated: [...summary.rulesEvaluated],
            trace: rendered.lines,
            summary: {
              totalEvents: summary.totalEvents,
              enterEvents: summary.enterEvents,
              exitEvents: summary.exitEvents,
              failEvents: summary.failEvents,
              redoOmitted: rendered.redoOmitted,
            },
          });
        },
        {
          // Keep the result and the summary; cut trace lines from the end.
          shrink: (data, fits) =>
            fitPrefix(
              data.trace,
              (lines) => ({
                ...data,
                trace: lines,
                traceTruncated: { shown: lines.length, total: data.trace.length },
              }),
              fits,
            ),
        },
      );
    },
  );
}
