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
 *   0     -- all tests pass (ok: true, passed: true)
 *   1     -- one or more failures (ok: true, passed: false)
 *   2+    -- command error (bad args, policy not found, etc.)
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
};

export interface ConftestTestOutput {
  /** `true` when conftest exited 0: no failures, and no warnings if `failOnWarn` was set. */
  passed: boolean;
  /** One entry per (file, namespace) pair conftest evaluated, arrays always present. */
  results: ConftestFileResult[];
  summary: {
    /** Distinct files with no failure in any namespace. */
    passed: number;
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
        'Policies are executed by conftest and can call OPA built-ins such as http.send.',
      inputSchema: ConftestTestInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
        const result = await conftest.test(
          {
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
          },
          signal,
        );

        // ── Map universal subprocess failures ────────────────────────────
        const subprocessFailure = mapSubprocessFailure(result, 'conftest');
        if (subprocessFailure) return subprocessFailure;

        // ── Exit code 0 / 1: parse JSON results ─────────────────────────
        // Exit 0 = all pass, exit 1 = failures present.
        // Both produce valid JSON on stdout.
        if (result.exitCode === 0 || result.exitCode === 1) {
          const results = parseConftestResults(result.stdout);
          if (results === null) {
            return err('UNKNOWN_ERROR', 'conftest test produced no parseable JSON output.', {
              details: { stderr: result.stderr.trim(), exitCode: result.exitCode },
            });
          }

          return ok<ConftestTestOutput>({
            passed: result.exitCode === 0,
            results,
            summary: buildSummary(results),
          });
        }

        // ── Exit code 2+: command-level error ────────────────────────────
        // Examples: policy directory not found, malformed Rego syntax,
        // unknown --parser value, etc.
        const detail = result.stderr.trim() || result.stdout.trim();
        return err(
          'UNKNOWN_ERROR',
          `conftest test failed with exit code ${result.exitCode}: ${detail}`,
          { details: { exitCode: result.exitCode, stderr: result.stderr.trim() } },
        );
      });
    },
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSummary(results: ConftestFileResult[]): ConftestTestOutput['summary'] {
  // conftest emits one entry per (file, namespace); with --all-namespaces a
  // file appears once per namespace, so files are counted by name.
  const failedFiles = new Set<string>();
  const allFiles = new Set<string>();
  let warnings = 0;
  let skipped = 0;
  let successes = 0;
  let failures = 0;

  for (const r of results) {
    allFiles.add(r.filename);
    if (r.failures.length > 0) failedFiles.add(r.filename);
    warnings += r.warnings.length;
    skipped += r.skipped.length;
    successes += r.successes;
    failures += r.failures.length;
  }

  return {
    passed: allFiles.size - failedFiles.size,
    failed: failedFiles.size,
    warnings,
    skipped,
    successes,
    failures,
  };
}
