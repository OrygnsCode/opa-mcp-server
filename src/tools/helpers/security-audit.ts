/**
 * `rego_security_audit` -- run regal lint filtered to the `bugs` category,
 * plus any custom rules in a `security` category, and return a
 * severity-grouped finding report.
 *
 * This is a focused slice of `rego_lint`. regal ships no security category
 * of its own: its `bugs` rules are the correctness defects most likely to
 * open a policy up, and a `security` category stays enabled as the place a
 * project's custom rules can go. The result groups findings by severity
 * with remediation guidance so the agent can prioritize fixes without
 * wading through style and formatting noise.
 *
 * Requires regal. Returns REGAL_NOT_FOUND if the binary is absent.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { RegalCli } from '../../lib/regal-cli.js';
import { err, ok } from '../../lib/errors.js';
import {
  mapSubprocessFailure,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';

const RegoSecurityAuditInput = {
  paths: z
    .array(z.string())
    .min(1)
    .describe(
      'Policy directories or files to audit. Each must be inside an allowed root (OPA_MCP_ALLOWED_PATHS). Pass the root of your policy fleet to scan everything at once.',
    ),
  configFile: z
    .string()
    .optional()
    .describe('Path to a Regal config file. Useful when your repo has custom rule configuration.'),
  ignoreFiles: z.array(z.string()).optional().describe('Glob patterns to exclude from the audit.'),
};

interface RegalViolation {
  title?: string;
  description?: string;
  category?: string;
  level?: string;
  location?: {
    file?: string;
    row?: number;
    col?: number;
    text?: string;
  };
  related_resources?: Array<{ description?: string; ref?: string }>;
}

interface RegalOutput {
  violations?: RegalViolation[];
  notices?: unknown[];
  summary?: {
    files_scanned?: number;
    rules_skipped?: number;
    num_violations?: number;
  };
}

export interface SecurityFinding {
  title: string;
  description: string;
  category: string;
  severity: 'high' | 'medium';
  file: string;
  row?: number;
  col?: number;
  remediation: string;
}

export interface RegoSecurityAuditOutput {
  totalFindings: number;
  highSeverity: number;
  mediumSeverity: number;
  filesScanned: number;
  findings: SecurityFinding[];
}

/**
 * Remediation hints keyed by Regal rule title. The values give a
 * specific, actionable fix rather than repeating the violation message.
 */
// Hints for the rules the sweep can report: regal's bugs category. Keys for
// rules regal does not ship, or ships in categories the sweep does not
// enable, were removed rather than left to suggest the sweep knew about them.
const REMEDIATION_HINTS: Record<string, string> = {
  'constant-condition':
    'The condition is always true or always false; remove it or fix the logic so the rule body reflects a real runtime check.',
  'deprecated-builtin':
    'Replace the deprecated builtin with its current equivalent before upgrading OPA, where deprecated functions may be removed.',
  'duplicate-rule':
    'Remove the duplicate rule definition. Multiple conflicting definitions cause non-deterministic evaluation and can mask security gaps.',
  'impossible-not':
    'The negation is of a condition that is always false, so not(...) is always true. Review whether the rule is overly permissive.',
  'inconsistent-args':
    'The function is called with a different number of arguments than its definition. The extra or missing argument silently makes the call undefined.',
  'rule-shadows-builtin':
    'Rename the local variable to avoid shadowing the OPA builtin. Shadowed builtins silently change semantics.',
  'sprintf-arguments-mismatch':
    'The sprintf format string and the number of arguments do not match. This produces undefined output at runtime.',
};

const DEFAULT_REMEDIATION =
  'Review the Regal documentation for this rule and apply the recommended fix before deploying to production.';

export function registerRegoSecurityAudit(server: McpServer, config: Config): void {
  const regal = new RegalCli(config);

  server.registerTool(
    'rego_security_audit',
    {
      title: 'Rego security audit',
      description:
        'Run regal lint restricted to its `bugs` category, the correctness rules whose defects most often turn into policy bypasses, plus any custom rules placed in a `security` category, across one or more policy directories. Returns findings grouped by severity (high/medium) with remediation guidance. Use this for a periodic fleet-wide sweep rather than per-file style review. Requires regal.',
      inputSchema: RegoSecurityAuditInput,
      annotations: {
        readOnlyHint: false,
        // Runs a project's custom Regal rules, which are Rego with the network built-ins.
        openWorldHint: true,
      },
    },
    async ({ paths, configFile, ignoreFiles }, { signal }) => {
      return withToolEnvelope<RegoSecurityAuditOutput>(config, async () => {
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        let resolvedConfigFile: string | undefined;
        if (configFile) {
          const v = validatePaths([configFile], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedConfigFile = v.resolved[0];
        }

        const result = await regal.lint(
          {
            paths: validation.resolved,
            configFile: resolvedConfigFile,
            ignoreFiles,
            // Start from zero rules and enable regal's bugs category, plus a
            // security category that regal does not ship but a project's
            // custom rules may populate.
            disableAll: true,
            enableCategory: ['security', 'bugs'],
            // Fail on errors only; warnings are still surfaced in JSON.
            failLevel: 'error',
          },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'regal');
        if (subprocessFailure) return subprocessFailure;

        const parsed = tryParseJson<RegalOutput>(result.stdout);
        if (!parsed) {
          return err('UNKNOWN_ERROR', 'regal lint produced no parseable JSON output.', {
            details: { stderr: result.stderr.trim(), exitCode: result.exitCode },
          });
        }

        const rawViolations = parsed.violations ?? [];
        const filesScanned = parsed.summary?.files_scanned ?? 0;

        const findings: SecurityFinding[] = rawViolations.map((v) => {
          const title = v.title ?? '';
          const severity: 'high' | 'medium' = v.level === 'error' ? 'high' : 'medium';
          const remediation = REMEDIATION_HINTS[title] ?? DEFAULT_REMEDIATION;
          return {
            title,
            description: v.description ?? '',
            category: v.category ?? '',
            severity,
            file: v.location?.file ?? '',
            row: v.location?.row,
            col: v.location?.col,
            remediation,
          };
        });

        // Sort high severity first, then by file path for stable ordering.
        findings.sort((a, b) => {
          if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
          return a.file.localeCompare(b.file);
        });

        return ok<RegoSecurityAuditOutput>({
          totalFindings: findings.length,
          highSeverity: findings.filter((f) => f.severity === 'high').length,
          mediumSeverity: findings.filter((f) => f.severity === 'medium').length,
          filesScanned,
          findings,
        });
      });
    },
  );
}
