/**
 * `rego_security_audit` -- run regal lint filtered to the security
 * and bugs categories and return a severity-grouped finding report.
 *
 * This is a focused slice of `rego_lint`: only the rules most relevant
 * to security and correctness are enabled. The result groups findings
 * by severity with remediation guidance so the agent can prioritize
 * fixes without wading through style and formatting noise.
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
const REMEDIATION_HINTS: Record<string, string> = {
  'credentials-in-body':
    'Remove credentials from the HTTP request body literal. Use OPA environment variables or a data bundle to inject secrets at runtime.',
  'http-send-using-http':
    'Replace the http:// URL with https:// to prevent credentials or tokens from being transmitted in plaintext.',
  'jwt-credentials-in-source':
    'Move JWT tokens and signing keys out of policy source into data bundles or OPA environment variables.',
  'no-defined-entrypoint':
    'Add an @entrypoint annotation to the rule that serves as the policy decision point so automated analysis can identify the entry.',
  'constant-condition':
    'The condition is always true or always false; remove it or fix the logic so the rule body reflects a real runtime check.',
  'deprecated-builtin':
    'Replace the deprecated builtin with its current equivalent before upgrading OPA, where deprecated functions may be removed.',
  'duplicate-definition':
    'Remove the duplicate rule definition. Multiple conflicting definitions cause non-deterministic evaluation and can mask security gaps.',
  'impossible-if':
    'The rule condition can never be satisfied; it will never contribute to the decision. Review the logic for a typo or inverted condition.',
  'impossible-not':
    'The negation is of a condition that is always false, so not(...) is always true. Review whether the rule is overly permissive.',
  'inconsistent-args':
    'The function is called with a different number of arguments than its definition. The extra or missing argument silently makes the call undefined.',
  'unresolved-import':
    'The import path does not match any package in the bundle. Remove or fix the import to ensure the policy loads correctly.',
  'unreachable-rule':
    'The rule can never be evaluated given the existing rules. It may represent dead code that masks a missing test case.',
  'shadowing-builtin':
    'Rename the local variable to avoid shadowing the OPA builtin. Shadowed builtins silently change semantics.',
  'sprintf-formatting':
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
        'Run regal lint restricted to the security and bugs categories across one or more policy directories. Returns findings grouped by severity (high/medium) with remediation guidance. Use this for a periodic fleet-wide security sweep rather than per-file style review. Requires regal.',
      inputSchema: RegoSecurityAuditInput,
    },
    async ({ paths, configFile, ignoreFiles }) => {
      return withToolEnvelope<RegoSecurityAuditOutput>(config, async () => {
        const validation = validatePaths(paths, config, { mustExist: true });
        if (!validation.ok) return validation.error;

        const result = await regal.lint({
          paths: validation.resolved,
          configFile,
          ignoreFiles,
          // Start from zero rules and enable only security + bugs.
          disableAll: true,
          enableCategory: ['security', 'bugs'],
          // Fail on errors only; warnings are still surfaced in JSON.
          failLevel: 'error',
        });

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
