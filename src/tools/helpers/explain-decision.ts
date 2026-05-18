/**
 * `rego_explain_decision` -- run a query with `--explain=full` and
 * return a structured trace plus a per-rule summary an agent can
 * narrate.
 *
 * The actual rego_eval_with_explain returns OPA's raw trace; this
 * tool digests it slightly: counts the events per rule, surfaces the
 * final result, and lists the rules that fired vs the rules that
 * matched but evaluated to false.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';
import { runEval, SharedEvalInput, type RegoEvalOutput } from '../evaluation/_shared.js';

interface TraceEvent {
  op?: string;
  type?: string;
  query_id?: number;
  parent_id?: number;
  message?: string;
  location?: { file?: string; row?: number; col?: number };
  node?: unknown;
}

export interface RegoExplainDecisionOutput {
  result: unknown;
  errors?: unknown[];
  rulesFired: string[];
  rulesEvaluated: string[];
  trace: TraceEvent[];
  summary: {
    totalEvents: number;
    enterEvents: number;
    exitEvents: number;
    failEvents: number;
  };
}

function summarizeTrace(trace: TraceEvent[] | undefined): RegoExplainDecisionOutput['summary'] & {
  rulesEvaluated: Set<string>;
  rulesFired: Set<string>;
} {
  const rulesEvaluated = new Set<string>();
  const rulesFired = new Set<string>();
  let enterEvents = 0;
  let exitEvents = 0;
  let failEvents = 0;
  for (const event of trace ?? []) {
    if (event.op === 'enter') {
      enterEvents += 1;
      const ruleMatch = event.message ? /^(?:eval|enter)\s+(.+)$/i.exec(event.message) : null;
      if (ruleMatch?.[1]) rulesEvaluated.add(ruleMatch[1]);
    } else if (event.op === 'exit') {
      exitEvents += 1;
      const ruleMatch = event.message ? /^(?:exit|matched)\s+(.+)$/i.exec(event.message) : null;
      if (ruleMatch?.[1]) rulesFired.add(ruleMatch[1]);
    } else if (event.op === 'fail') {
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
        'Evaluate a Rego query with full tracing and return a structured trace plus per-rule fired/not-fired summary. Use this when you need to answer "why was this denied?" -- the agent reads the structured trace and narrates the cause without re-implementing the trace parser.',
      inputSchema: SharedEvalInput,
    },
    async (args) => {
      return withToolEnvelope<RegoExplainDecisionOutput>(config, async () => {
        const evalEnvelope = await runEval(opa, config, args, { explain: 'full' });
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

        return ok<RegoExplainDecisionOutput>({
          result:
            data.result?.[0] !== undefined
              ? (data.result as Array<{ expressions?: Array<{ value?: unknown }> }>)[0]
                  ?.expressions?.[0]?.value
              : undefined,
          errors: data.errors,
          rulesFired: [...summary.rulesFired],
          rulesEvaluated: [...summary.rulesEvaluated],
          trace,
          summary: {
            totalEvents: summary.totalEvents,
            enterEvents: summary.enterEvents,
            exitEvents: summary.exitEvents,
            failEvents: summary.failEvents,
          },
        });
      });
    },
  );
}
