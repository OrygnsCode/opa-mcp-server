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
import { REMEDIATION_HINTS } from './security-audit.js';

// rego_check errors carry `code` and `message`; Regal violations, as
// rego_lint returns them, carry `title` and `description` instead. Both are
// taken as they come: requiring `code` and `message` refused rego_lint's own
// output.
const RegoSuggestFixInput = {
  diagnostics: z
    .array(
      z
        .object({
          code: z
            .string()
            .optional()
            .describe('Error code from rego_check, e.g. "rego_unsafe_var_error".'),
          message: z.string().optional().describe('Error message from rego_check.'),
          title: z
            .string()
            .optional()
            .describe('Rule name of a rego_lint violation, e.g. "not-equals-in-loop".'),
          description: z.string().optional().describe('Description of a rego_lint violation.'),
          category: z.string().optional().describe('Category of a rego_lint violation.'),
          level: z.string().optional().describe('Level of a rego_lint violation.'),
          location: z
            .object({
              file: z.string().optional(),
              row: z.number().optional(),
              col: z.number().optional(),
              text: z.string().optional(),
            })
            .optional(),
          related_resources: z
            .array(z.object({ description: z.string().optional(), ref: z.string().optional() }))
            .optional()
            .describe('Documentation links of a rego_lint violation.'),
        })
        .refine((d) => d.code !== undefined || d.title !== undefined, {
          message:
            'Each diagnostic needs a `code` (from rego_check) or a `title` (from rego_lint).',
        }),
    )
    .min(1)
    .describe(
      'Diagnostics as rego_check or rego_lint return them: `errors` or `violations`, unchanged.',
    ),
};

interface FixSuggestion {
  code: string;
  message: string;
  suggestion: string;
  confidence: 'high' | 'medium' | 'low';
  patch?: string;
  /** The Regal rule's documentation, for a lint violation. */
  docs?: string;
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
        'The Rego file lives in a directory that does not match its `package` declaration (`package foo.bar` belongs in `foo/bar/`). If the layout is intentional, disable the rule (`disable: ["directory-package-mismatch"]`) rather than moving files that other tooling may expect where they are.',
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
        "Map common Rego compile errors and Regal lint findings to fix suggestions. Pass `errors` from `rego_check` or `violations` from `rego_lint` unchanged. Returns one suggestion per diagnostic; confidence is `high` for well-known patterns, `medium` where the answer is the rule's documentation (`docs`), `low` for everything else.",
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
          const message = diag.message || diag.description || '';
          const docs = diag.related_resources?.find((r) => r.ref)?.ref;
          const linked = docs !== undefined ? { docs } : {};
          const matched = KNOWN_FIXES.find((f) => f.match(code, message));
          if (matched) return { code, message, ...matched.suggest(message), ...linked };
          // A Regal rule in the bugs category: the audit's remediation text.
          const remediation = REMEDIATION_HINTS[code];
          if (remediation !== undefined) {
            return {
              code,
              message,
              suggestion: remediation,
              confidence: 'high' as const,
              ...linked,
            };
          }
          if (docs !== undefined) {
            return {
              code,
              message,
              suggestion: `Regal's documentation for \`${code}\` shows the problem and the fix: ${docs}. rego_fix corrects some rules automatically; run it with \`dryRun: true\` to see which.`,
              confidence: 'medium' as const,
              docs,
            };
          }
          return {
            code,
            message,
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
