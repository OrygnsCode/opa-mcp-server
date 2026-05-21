/**
 * `rego_suggest_fix` -- propose mechanical fixes for common Rego
 * compile errors and Regal lint findings.
 *
 * The tool is deliberately rule-based -- it doesn't call out to an LLM.
 * Common error codes have well-known mechanical fixes; we surface
 * those, and for everything else we hand back a structured "no
 * automated fix available, here's what we know" envelope so the agent
 * can reason on it.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { ok } from '../../lib/errors.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';

const RegoSuggestFixInput = {
  diagnostics: z
    .array(
      z.object({
        code: z.string().describe('Diagnostic code (e.g. "rego_unsafe_var_error").'),
        message: z.string().describe('Diagnostic message.'),
        location: z
          .object({
            file: z.string().optional(),
            row: z.number().optional(),
            col: z.number().optional(),
          })
          .optional(),
        title: z.string().optional().describe('Title (Regal violations).'),
        category: z.string().optional().describe('Category (Regal violations).'),
      }),
    )
    .min(1)
    .describe('Diagnostics from rego_check or rego_lint.'),
};

interface FixSuggestion {
  code: string;
  message: string;
  suggestion: string;
  confidence: 'high' | 'medium' | 'low';
  patch?: string;
}

const KNOWN_FIXES: Array<{
  match: (code: string, message: string) => boolean;
  suggest: (message: string) => Omit<FixSuggestion, 'code' | 'message'>;
}> = [
  {
    match: (code) => code === 'rego_unsafe_var_error',
    suggest: (message) => {
      const varMatch = /var (\S+) is unsafe/.exec(message);
      const varName = varMatch?.[1];
      return {
        suggestion: varName
          ? `The variable \`${varName}\` is referenced but never bound. Add a clause that defines it (assignment, comprehension, or pattern match) before it is used.`
          : 'A variable is referenced before being bound. Add a binding clause earlier in the rule body.',
        confidence: 'high',
      };
    },
  },
  {
    match: (code) => code === 'rego_parse_error',
    suggest: () => ({
      suggestion:
        'The source did not parse. Run `rego_format` to confirm the syntax is well-formed, then `rego_check` for the precise location.',
      confidence: 'medium',
    }),
  },
  {
    match: (code) => code === 'rego_type_error',
    suggest: (message) => ({
      suggestion: `Type mismatch: ${message.replace(/^rego_type_error:\s*/, '')}. Reconcile the operand types -- most often this is comparing a string with a number, or indexing a value with the wrong key shape.`,
      confidence: 'medium',
    }),
  },
  {
    match: (code) => code === 'rego_recursion_error',
    suggest: () => ({
      suggestion:
        'A rule references itself directly or indirectly. Restructure so each rule depends only on documents lower in the DAG, or introduce an intermediate rule that breaks the cycle.',
      confidence: 'high',
    }),
  },
  {
    match: (code) => code === 'rego_compile_error',
    suggest: () => ({
      suggestion:
        'A compile error occurred. Run `rego_check` for the structured diagnostic -- the message text usually points at the precise issue (often an unresolved import or capabilities mismatch).',
      confidence: 'low',
    }),
  },
  // Regal style/idiom suggestions
  {
    match: (code) => code === 'print-or-trace-call',
    suggest: () => ({
      suggestion:
        'Remove the `print(...)` or `trace(...)` call before shipping -- it slows evaluation and is rarely intended in production policy.',
      confidence: 'high',
    }),
  },
  {
    match: (code) => code === 'directory-package-mismatch',
    suggest: () => ({
      suggestion:
        'The Rego file lives in a directory that does not match its `package` declaration. Move the file or rename the package so they agree (e.g., `package foo.bar` belongs in `foo/bar/`).',
      confidence: 'high',
    }),
  },
];

export interface RegoSuggestFixOutput {
  suggestions: FixSuggestion[];
}

export function registerRegoSuggestFix(server: McpServer, config: Config): void {
  server.registerTool(
    'rego_suggest_fix',
    {
      title: 'Suggest fix for Rego diagnostics',
      description:
        'Map common Rego compile errors and Regal lint findings to mechanical fix suggestions. Pass diagnostics from `rego_check` or `rego_lint`. Returns one suggestion per input diagnostic; confidence is `high` for well-known patterns, `medium` for partial matches, `low` for everything else.',
      inputSchema: RegoSuggestFixInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ diagnostics }) => {
      return withToolEnvelope<RegoSuggestFixOutput>(config, () => {
        const suggestions: FixSuggestion[] = diagnostics.map((diag) => {
          const code = diag.code || diag.title || '';
          const matched = KNOWN_FIXES.find((f) => f.match(code, diag.message));
          if (matched) {
            const partial = matched.suggest(diag.message);
            return {
              code,
              message: diag.message,
              ...partial,
            };
          }
          return {
            code,
            message: diag.message,
            suggestion:
              'No automated suggestion available for this diagnostic. Read the message text and the location for context -- most Rego errors have an obvious mechanical fix once the trigger is identified.',
            confidence: 'low' as const,
          };
        });
        return Promise.resolve(ok<RegoSuggestFixOutput>({ suggestions }));
      });
    },
  );
}
