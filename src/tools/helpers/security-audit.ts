/**
 * `rego_security_audit` -- run regal lint filtered to the `bugs` category,
 * plus any custom rules in a `security` category, and return a
 * severity-grouped finding report.
 *
 * This is a focused slice of `rego_lint`. regal ships no security category
 * of its own: its `bugs` rules are the correctness defects most likely to
 * open a policy up, and a `security` category is enabled as the place a
 * project's custom rules can go. Regal 0.31 and later refuse a category no
 * rule defines, so when that happens the sweep runs again with `bugs`
 * alone. The result groups findings by severity
 * with remediation guidance so the agent can prioritize fixes without
 * wading through style and formatting noise.
 *
 * A module that does not parse is left out and named in `unparseable`, and
 * the rest are audited: Regal stops at the first such module, which turned
 * one broken file in a fleet into no audit at all.
 *
 * Requires regal. Returns REGAL_NOT_FOUND if the binary is absent.
 */
import { basename, relative, sep } from 'node:path';

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { RegalCli } from '../../lib/regal-cli.js';
import {
  regalParseError,
  regalParseFailure,
  type RegalParseFailure,
} from '../../lib/regal-errors.js';
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
  /** The Regal rule's documentation. */
  docs?: string;
}

export interface RegoSecurityAuditOutput {
  totalFindings: number;
  highSeverity: number;
  mediumSeverity: number;
  filesScanned: number;
  findings: SecurityFinding[];
  /** Modules left out because they do not parse. */
  unparseable?: Array<{ file: string; row: number; message: string }>;
}

/** Most unparseable modules skipped before the audit gives up; each costs a Regal run. */
const MAX_UNPARSEABLE = 20;

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
    'Two definitions of the rule are identical. Remove one; a duplicate is usually a copy that was meant to check something else.',
  'impossible-not':
    'The negated reference is always defined, typically a multi-value rule such as `deny`, which is an empty set when nothing matches. So `not deny` never holds and the rule containing it never applies. Test the size instead: `count(deny) == 0`.',
  'inconsistent-args':
    'The function is called with a different number of arguments than its definition. The extra or missing argument silently makes the call undefined.',
  'rule-shadows-builtin':
    'A rule is named after an OPA builtin, such as `count` or `contains`, which hides the builtin in this package. Rename the rule.',
  'var-shadows-builtin':
    'A variable is named after an OPA builtin, which hides the builtin in that rule body. Rename the variable.',
  'sprintf-arguments-mismatch':
    'The sprintf format string and the number of arguments do not match. This produces undefined output at runtime.',
};

const DEFAULT_REMEDIATION =
  'Review the Regal documentation for this rule and apply the recommended fix before deploying to production.';

/**
 * Narrow the lint so `file` is left out: drop it when it was a target itself,
 * or add an ignore pattern for it under the directory target that holds it.
 * Returns the new targets, or undefined when `file` is under no target.
 */
function skipModule(file: string, targets: string[], ignore: string[]): string[] | undefined {
  const norm = (p: string) => {
    const joined = p.replace(/[\\/]+/g, sep);
    return process.platform === 'win32' ? joined.toLowerCase() : joined;
  };
  const target = norm(file);
  if (targets.some((t) => norm(t) === target)) {
    return targets.filter((t) => norm(t) !== target);
  }
  const dir = targets.find((t) => target.startsWith(norm(t).replace(/[\\/]*$/, sep)));
  if (dir === undefined) return undefined;
  const rel = relative(dir, file).replace(/\\/g, '/');
  ignore.push(`**/${basename(dir)}/${rel}`);
  return targets;
}

export function registerRegoSecurityAudit(server: McpServer, config: Config): void {
  const regal = new RegalCli(config);

  server.registerTool(
    'rego_security_audit',
    {
      title: 'Rego security audit',
      description:
        'Run regal lint restricted to its `bugs` category plus any custom rules placed in a `security` category, across one or more policy directories, and return the findings grouped by severity (high/medium) with remediation guidance and a link to each rule. Use it for a periodic fleet-wide sweep rather than per-file style review. Modules that do not parse are listed in `unparseable` and the rest are audited. These are lint findings: a policy with none can still let a request through, so probe it with `rego_eval` inputs (absent, null and wrong-typed fields) for that. Requires regal.',
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
        let targets = [...validation.resolved];
        const ignore = [...(ignoreFiles ?? [])];
        const unparseable: RegalParseFailure[] = [];

        let resolvedConfigFile: string | undefined;
        if (configFile) {
          const v = validatePaths([configFile], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedConfigFile = v.resolved[0];
        }

        const sweep = (categories: string[]) =>
          regal.lint(
            {
              paths: targets,
              configFile: resolvedConfigFile,
              ignoreFiles: ignore.length > 0 ? ignore : undefined,
              // Start from zero rules and enable regal's bugs category, plus a
              // security category that regal does not ship but a project's
              // custom rules may populate.
              disableAll: true,
              enableCategory: categories,
              // Fail on errors only; warnings are still surfaced in JSON.
              failLevel: 'error',
            },
            signal,
          );

        let categories = ['security', 'bugs'];
        let result = await sweep(categories);
        let parsed: RegalOutput | undefined;
        for (;;) {
          // Regal 0.31 and later validate category names against the rules they
          // loaded and refuse one that nothing defines, which is the case for
          // `security` in a project without custom rules. 0.30 ignored it.
          if (
            categories.length > 1 &&
            result.exitCode !== null &&
            result.exitCode !== 0 &&
            /unknown categor(?:y|ies)/i.test(result.stderr)
          ) {
            categories = ['bugs'];
            result = await sweep(categories);
            continue;
          }

          const subprocessFailure = mapSubprocessFailure(result, 'regal');
          if (subprocessFailure) return subprocessFailure;

          parsed = tryParseJson<RegalOutput>(result.stdout);
          if (parsed) break;

          const failure = regalParseFailure(result.stderr);
          if (!failure) {
            return err('UNKNOWN_ERROR', 'regal lint produced no parseable JSON output.', {
              details: { stderr: result.stderr.trim(), exitCode: result.exitCode },
            });
          }
          // Leave the module out and audit the rest. A directory target keeps
          // its other modules through an ignore pattern relative to it: Regal
          // matches `**/`-anchored patterns against an absolute target, not
          // absolute paths.
          // A module reported again was not excluded by its pattern; stop
          // rather than run Regal for nothing.
          const again = unparseable.some((u) => u.file === failure.file);
          const skipped = again ? undefined : skipModule(failure.file, targets, ignore);
          if (skipped === undefined || unparseable.length >= MAX_UNPARSEABLE) {
            return regalParseError(failure);
          }
          targets = skipped;
          unparseable.push(failure);
          if (targets.length === 0) return regalParseError(failure);
          result = await sweep(categories);
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
            ...(v.related_resources?.[0]?.ref ? { docs: v.related_resources[0].ref } : {}),
          };
        });

        // Sort high severity first, then by file path for stable ordering.
        findings.sort((a, b) => {
          if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
          return a.file.localeCompare(b.file);
        });

        const warnings: string[] = [];
        if (unparseable.length > 0) {
          warnings.push(
            `${unparseable.length} module(s) do not parse and were not audited: ${unparseable.map((u) => `${u.file}:${u.row}`).join(', ')}.`,
          );
        }
        if (findings.length === 0) {
          warnings.push(
            'No lint findings. That does not show the policy cannot be bypassed: probe it with rego_eval inputs that leave fields out or give them the wrong type.',
          );
        }
        return ok<RegoSecurityAuditOutput>(
          {
            totalFindings: findings.length,
            highSeverity: findings.filter((f) => f.severity === 'high').length,
            mediumSeverity: findings.filter((f) => f.severity === 'medium').length,
            filesScanned,
            findings,
            ...(unparseable.length > 0
              ? {
                  unparseable: unparseable.map((u) => ({
                    file: u.file,
                    row: u.row,
                    message: u.message,
                  })),
                }
              : {}),
          },
          warnings,
        );
      });
    },
  );
}
