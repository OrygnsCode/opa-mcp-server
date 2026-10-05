/**
 * `conftest_test` -- evaluate configuration files against Rego policies
 * using the `conftest test` command.
 *
 * Conftest is the standard CLI for policy-as-code testing of Kubernetes
 * manifests, Terraform plans, Dockerfiles, Helm charts, and any other
 * structured configuration. This tool surfaces pass/fail/warn results
 * per file and per namespace so an LLM can explain exactly which policies
 * fired and why.
 *
 * Exit code mapping:
 *   null  -- conftest binary not found → CONFTEST_NOT_FOUND
 *   0     -- all tests pass (ok: true, passed: true), unless no rule was
 *            evaluated at all (passed: false, nothingEvaluated: true)
 *   1     -- one or more failures, or a command error (bad args, policy not
 *            found): the two are told apart by whether stdout holds results
 *   2     -- failures together with warnings under --fail-on-warn
 * Measured with conftest 0.69.0: a denial alone exits 1, a denial with
 * --fail-on-warn exits 2, and both print the full result JSON. Any exit code
 * with parseable results is an outcome, not a malfunction.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import {
  CONFTEST_PARSERS,
  ConftestCli,
  isConftestParser,
  parseConftestResults,
  type ConftestFileResult,
} from '../../lib/conftest-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';
import { conftestFailure } from './_failure.js';

const PARSER_LIST = CONFTEST_PARSERS.join(', ');

const ConftestTestInput = {
  files: z
    .array(z.string())
    .optional()
    .describe(
      'Filesystem paths to configuration files to evaluate (YAML, JSON, HCL, Dockerfile, etc.). ' +
        'Each path must be inside an allowed root (OPA_MCP_ALLOWED_PATHS). ' +
        'Mutually exclusive with `inlineConfig`.',
    ),
  inlineConfig: z
    .string()
    .optional()
    .describe(
      'Inline configuration content to evaluate (e.g. a Kubernetes manifest as a YAML string). ' +
        'Mutually exclusive with `files`. Defaults to YAML format; set `inlineConfigParser` to override.',
    ),
  inlineConfigParser: z
    .enum(CONFTEST_PARSERS)
    .optional()
    .describe(
      `Parser to use for \`inlineConfig\`. One of: ${PARSER_LIST}. Defaults to yaml. ` +
        "Ignored when `files` is used (conftest infers the parser from each file's extension, " +
        'unless `parser` is set).',
    ),
  parser: z
    .enum(CONFTEST_PARSERS)
    .optional()
    .describe(
      "Force a specific parser for all input `files` via conftest's global `--parser` flag, " +
        'overriding extension-based detection. Useful for files whose extension does not match ' +
        `their format (e.g. parse a \`.tfstate\` file as \`json\`). One of: ${PARSER_LIST}. ` +
        'For `inlineConfig`, prefer `inlineConfigParser`.',
    ),
  policy: z
    .string()
    .optional()
    .describe(
      'Path to a directory or file containing Rego policies. ' +
        'Must be inside an allowed root (OPA_MCP_ALLOWED_PATHS). ' +
        'Mutually exclusive with `inlinePolicy`. ' +
        'Omit to let conftest use its default `./policy` directory.',
    ),
  inlinePolicy: z
    .string()
    .optional()
    .describe(
      'Inline Rego policy source. Written to a temporary directory and passed as `--policy`. ' +
        'The policy should declare `package main` (or match the `namespace` parameter). ' +
        'Mutually exclusive with `policy`.',
    ),
  namespace: z
    .string()
    .optional()
    .describe(
      'Rego namespace (package name) to test against. Defaults to `main`. ' +
        'Use `allNamespaces: true` to test all discovered namespaces instead.',
    ),
  allNamespaces: z
    .boolean()
    .optional()
    .describe('Test policies found in all discovered namespaces. Overrides `namespace`.'),
  data: z
    .array(z.string())
    .optional()
    .describe(
      'Paths to directories from which additional data will be loaded for the Rego policies. ' +
        'Each path must be inside an allowed root.',
    ),
  combine: z
    .boolean()
    .optional()
    .describe(
      'Combine all configuration files into a single input document before evaluating. ' +
        'Useful when policies need to inspect relationships across multiple files.',
    ),
  failOnWarn: z
    .boolean()
    .optional()
    .describe('Return `passed: false` even when only warnings (no hard failures) are present.'),
  v0Compatible: z
    .boolean()
    .optional()
    .describe(
      'Read the policies as Rego v0 (`--rego-version v0`), the syntax before OPA 1.0: rules without `if`, `deny[msg] { ... }`. conftest reads v1 by default and refuses such a policy.',
    ),
};

export interface ConftestTestOutput {
  /**
   * `true` when conftest exited 0 (no failures, and no warnings if `failOnWarn`
   * was set) and at least one rule was evaluated.
   */
  passed: boolean;
  /**
   * Set when conftest evaluated no rule at all: the namespace holds no
   * `deny`, `violation` or `warn` rule, so every file "passed" unchecked.
   * conftest itself exits 0 and prints `0 tests` for that.
   */
  nothingEvaluated?: boolean;
  /** With `nothingEvaluated`: the namespaces that do hold rules, from `--all-namespaces`. */
  namespacesWithRules?: string[];
  /** One entry per (file, namespace) pair conftest evaluated, arrays always present. */
  results: ConftestFileResult[];
  summary: {
    /** Distinct files with at least one rule evaluated and no failure in any namespace. */
    passed: number;
    /** Distinct files no rule was evaluated against. */
    unchecked: number;
    /** Distinct files with at least one failure in any namespace. */
    failed: number;
    /** Warning messages across all entries. */
    warnings: number;
    /** Skipped-rule messages across all entries. */
    skipped: number;
    /** Rule evaluations that passed across all entries (conftest's `successes`). */
    successes: number;
    /** Failure messages across all entries. */
    failures: number;
  };
}

export function registerConftestTest(server: McpServer, config: Config): void {
  const conftest = new ConftestCli(config);

  server.registerTool(
    'conftest_test',
    {
      title: 'Conftest test',
      description:
        'Evaluate configuration files (Kubernetes manifests, Terraform plans, Dockerfiles, Helm ' +
        'charts, or any YAML/JSON/HCL/TOML/INI) against Rego policies using `conftest test`. ' +
        'Returns per-file, per-namespace pass/fail/warn results so you can pinpoint exactly which ' +
        'policy rules fired. Requires `conftest` on PATH or `CONFTEST_BINARY` set; returns ' +
        'CONFTEST_NOT_FOUND otherwise. ' +
        'Provide config via `files` (disk paths) or `inlineConfig` (inline string). ' +
        'Provide policy via `policy` (disk path) or `inlinePolicy` (inline Rego source). ' +
        "Omit `policy` and `inlinePolicy` to use conftest's default `./policy` directory. " +
        'Policies are executed by conftest and can call OPA built-ins such as http.send. ' +
        'A run in which no rule was evaluated (wrong `namespace`, or no `deny`/`violation`/`warn` ' +
        'rules) is reported as `passed: false` with `nothingEvaluated: true` and the namespaces ' +
        'that do hold rules, where conftest itself would exit 0.',
      inputSchema: ConftestTestInput,
      annotations: {
        // Runs Rego supplied by the caller; a policy can reach, and write to, a remote system through http.send.
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async (input, { signal }) => {
      return withToolEnvelope<ConftestTestOutput>(config, async () => {
        // ── Mutual exclusion checks ──────────────────────────────────────
        if (input.files?.length && input.inlineConfig !== undefined) {
          return err('INVALID_INPUT', '`files` and `inlineConfig` are mutually exclusive.');
        }
        if (!input.files?.length && input.inlineConfig === undefined) {
          return err(
            'INVALID_INPUT',
            'Provide either `files` (array of config file paths) or `inlineConfig` (inline config string).',
          );
        }
        if (input.policy !== undefined && input.inlinePolicy !== undefined) {
          return err('INVALID_INPUT', '`policy` and `inlinePolicy` are mutually exclusive.');
        }

        // The schema restricts parser names to the closed set, and the
        // check is repeated here because the name becomes part of a temp
        // file path: this handler must never see free text there, whatever
        // path it was reached by.
        for (const [field, value] of [
          ['inlineConfigParser', input.inlineConfigParser],
          ['parser', input.parser],
        ] as const) {
          if (value !== undefined && !isConftestParser(value)) {
            return err('INVALID_INPUT', `\`${field}\` must be one of: ${PARSER_LIST}.`, {
              details: { [field]: value },
            });
          }
        }

        // ── Path validation ──────────────────────────────────────────────
        if (input.files?.length) {
          const v = validatePaths(input.files, config, { mustExist: true });
          if (!v.ok) return v.error;
          input = { ...input, files: v.resolved };
        }

        if (input.policy !== undefined) {
          const v = validatePaths([input.policy], config, { mustExist: true });
          if (!v.ok) return v.error;
          input = { ...input, policy: v.resolved[0] };
        }

        if (input.data?.length) {
          const v = validatePaths(input.data, config, { mustExist: true });
          if (!v.ok) return v.error;
          input = { ...input, data: v.resolved };
        }

        // ── Run conftest ─────────────────────────────────────────────────
        const testArgs = {
          files: input.files,
          inlineConfig: input.inlineConfig,
          inlineConfigParser: input.inlineConfigParser,
          parser: input.parser,
          policy: input.policy,
          inlinePolicy: input.inlinePolicy,
          namespace: input.namespace,
          allNamespaces: input.allNamespaces,
          data: input.data,
          combine: input.combine,
          failOnWarn: input.failOnWarn,
          regoV0: input.v0Compatible,
        };
        const result = await conftest.test(testArgs, signal);

        // ── Map universal subprocess failures ────────────────────────────
        const subprocessFailure = mapSubprocessFailure(result, 'conftest');
        if (subprocessFailure) return subprocessFailure;

        // ── Results on stdout: an outcome, whatever the exit code ────────
        // Exit 0 is a pass; 1 and 2 carry failures (2 when --fail-on-warn
        // adds warnings to them). Routing 2 to the error branch reported a
        // real denial as a broken tool.
        const results = parseConftestResults(result.stdout);
        if (results !== null) {
          const summary = buildSummary(results);
          if (evaluatedNothing(results)) {
            const namespaces = input.allNamespaces
              ? []
              : await namespacesWithRules(conftest, testArgs, signal);
            const where = input.allNamespaces
              ? 'in any namespace'
              : `in namespace \`${input.namespace ?? 'main'}\``;
            return ok<ConftestTestOutput>(
              {
                passed: false,
                nothingEvaluated: true,
                ...(namespaces !== undefined ? { namespacesWithRules: namespaces } : {}),
                results,
                summary,
              },
              [
                `No rule was evaluated ${where}: conftest found no \`deny\`, \`violation\` or \`warn\` rule there, so no file was checked. ` +
                  (namespaces?.length
                    ? `Namespaces with rules: ${namespaces.join(', ')}. Pass one as \`namespace\`, or set \`allNamespaces: true\`.`
                    : 'Check that the policy declares those rules as sets of strings or of objects with a `msg`.'),
              ],
            );
          }
          return ok<ConftestTestOutput>({
            passed: result.exitCode === 0,
            results,
            summary,
          });
        }

        // ── No results: a command-level error ────────────────────────────
        // Examples: policy directory not found, malformed Rego syntax,
        // unknown --parser value, etc.
        return conftestFailure(
          'test',
          result.exitCode,
          result.stdout,
          result.stderr,
          input.v0Compatible,
        );
      });
    },
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Whether conftest evaluated no rule for any file: `0 tests` in its own summary. */
function evaluatedNothing(results: ConftestFileResult[]): boolean {
  return results.every(
    (r) =>
      r.successes +
        r.failures.length +
        r.warnings.length +
        r.exceptions.length +
        r.skipped.length ===
      0,
  );
}

/**
 * The namespaces that hold rules, found by running the same test with
 * `--all-namespaces`. Undefined when that run fails, so the caller can still
 * report the empty run.
 */
async function namespacesWithRules(
  conftest: ConftestCli,
  input: Parameters<ConftestCli['test']>[0],
  signal: AbortSignal,
): Promise<string[] | undefined> {
  let results: ConftestFileResult[] | null;
  try {
    const probe = await conftest.test(
      { ...input, namespace: undefined, allNamespaces: true, failOnWarn: false },
      signal,
    );
    results = parseConftestResults(probe.stdout ?? '');
  } catch {
    return undefined;
  }
  if (results === null) return undefined;
  const found = new Set<string>();
  for (const r of results) {
    const checks = r.successes + r.failures.length + r.warnings.length + r.exceptions.length;
    if (checks > 0) found.add(r.namespace);
  }
  return [...found].sort();
}

function buildSummary(results: ConftestFileResult[]): ConftestTestOutput['summary'] {
  // conftest emits one entry per (file, namespace); with --all-namespaces a
  // file appears once per namespace, so files are counted by name.
  const failedFiles = new Set<string>();
  const checkedFiles = new Set<string>();
  const allFiles = new Set<string>();
  let warnings = 0;
  let skipped = 0;
  let successes = 0;
  let failures = 0;

  for (const r of results) {
    allFiles.add(r.filename);
    if (r.failures.length > 0) failedFiles.add(r.filename);
    if (r.successes + r.failures.length + r.warnings.length + r.exceptions.length > 0) {
      checkedFiles.add(r.filename);
    }
    warnings += r.warnings.length;
    skipped += r.skipped.length;
    successes += r.successes;
    failures += r.failures.length;
  }

  return {
    passed: [...checkedFiles].filter((f) => !failedFiles.has(f)).length,
    unchecked: allFiles.size - checkedFiles.size,
    failed: failedFiles.size,
    warnings,
    skipped,
    successes,
    failures,
  };
}
