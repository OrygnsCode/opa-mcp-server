/**
 * `opa_exec` -- batch-evaluate a policy decision against multiple input
 * files using `opa exec`.
 *
 * Unlike `rego_eval` (single input document), `opa exec` evaluates the
 * same decision for every file in a directory or explicit list. This is
 * the standard CI pattern for teams that gate deployments by checking
 * each config file independently: pass the configs directory, get back
 * a per-file allow/deny without writing a shell loop.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import type { SpawnResult } from '../../lib/subprocess.js';
import type { ToolEnvelope } from '../../types.js';
import {
  mapSubprocessFailure,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';
import { PRE_V1_SYNTAX, v0CompatibleField } from '../_rego-version.js';

const OpaExecInput = {
  inputPaths: z
    .array(z.string())
    .min(1)
    .describe(
      'One or more JSON/YAML input file paths, or a directory containing input files. OPA evaluates each file independently. Every path must be inside an allowed root.',
    ),
  decision: z
    .string()
    .min(1)
    .describe(
      'The policy entrypoint to evaluate for each input, e.g. `"authz/allow"`. `opa exec` names a decision by slash-separated path with no `data.` prefix; the Rego reference forms (`data.authz.allow`, `authz.allow`) are accepted here and converted, because passing one straight through leaves every file undefined.',
    ),
  bundle: z
    .string()
    .optional()
    .describe(
      'Path to an OPA bundle directory or `.tar.gz` archive to load as the policy source. Mutually exclusive with `dataPaths`.',
    ),
  dataPaths: z
    .array(z.string())
    .optional()
    .describe(
      'Policy and data files or directories, loaded the way `opa eval --data` loads them: a `.rego` file as a module, a JSON or YAML file merged into the data root, a directory recursively, so every JSON and YAML file in it is data and must parse. One difference: a bundle archive (`.tar.gz`) inside a directory is not loaded, and `warnings` names it. A bundle given here directly (an archive, or a directory holding a `.manifest`) is loaded as a bundle; bundles and plain paths cannot be mixed. To load a directory as a bundle, reading only its `.rego` files and those named data.json, data.yaml or data.yml, pass it as `bundle`. Mutually exclusive with `bundle`.',
    ),
  fail: z
    .boolean()
    .optional()
    .describe(
      'CI gate: report `failed: true` when any decision is undefined or errors. Mutually exclusive with `failDefined` and `failNonEmpty`.',
    ),
  failDefined: z
    .boolean()
    .optional()
    .describe(
      'CI gate: report `failed: true` when any decision is defined or errors. Use when a defined result means a violation. Mutually exclusive with `fail` and `failNonEmpty`.',
    ),
  failNonEmpty: z
    .boolean()
    .optional()
    .describe(
      'CI gate: report `failed: true` when any decision result is non-empty or errors. Mutually exclusive with `fail` and `failDefined`.',
    ),
  timeout: z
    .string()
    .optional()
    .describe(
      'Per-exec evaluation timeout as a Go duration, e.g. `"30s"` or `"5m"`. Still bounded by the server subprocess timeout (OPA_MCP_TIMEOUT_MS).',
    ),
  v1Compatible: z
    .boolean()
    .optional()
    .describe('Opt in to OPA v1.0-compatible behaviors (`--v1-compatible`).'),
  v0Compatible: v0CompatibleField,
};

interface ExecResultEntry {
  path: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

interface OpaExecJsonOutput {
  result?: ExecResultEntry[];
}

export interface OpaExecOutput {
  /** Per-file evaluation results. */
  results: ExecResultEntry[];
  /** Total number of input files processed. */
  count: number;
  /** Number of files that produced a result without error. */
  successCount: number;
  /** Number of files that produced an evaluation error. */
  errorCount: number;
  /**
   * True when a `--fail*` gate fired (opa exec exited non-zero). Always
   * false when no gate flag is set.
   */
  failed: boolean;
  /**
   * Present only when every input left the decision undefined. That happens
   * both when no rule matched and when the decision names nothing at all, and
   * the two are indistinguishable in the per-file results.
   */
  hint?: string;
}

/**
 * A bundle archive, whatever its name (a gzip file, as `opa build` writes
 * one), or a directory holding a bundle `.manifest`.
 */
async function isBundlePath(path: string): Promise<boolean> {
  // Opened once and inspected through the handle, so what is read is what
  // was classified. Windows refuses to open a directory at all.
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch {
    return existsSync(join(path, '.manifest'));
  }
  try {
    if ((await file.stat()).isDirectory()) return existsSync(join(path, '.manifest'));
    const head = Buffer.alloc(2);
    const { bytesRead } = await file.read(head, 0, 2, 0);
    return bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

/**
 * Bundle archives inside the plain `dataPaths` directories. `opa eval --data`
 * loads a `.tar.gz` it finds in a directory; `opa build`, which loads the
 * plain paths here, skips it, so each one found is named rather than dropped
 * without a word.
 */
async function archivesWithin(paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    let entries: string[];
    try {
      if (!(await stat(path)).isDirectory()) continue;
      entries = await readdir(path, { recursive: true });
    } catch {
      // Unreadable here is unreadable to opa build too, which says so.
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.tar.gz')) found.push(join(path, entry));
    }
  }
  return found;
}

/** The bundle a directory is loaded as reads these, and nothing else, as data. */
const BUNDLE_HINT =
  'To load a directory as a bundle instead, which reads only its `.rego` files and the files named data.json, data.yaml or data.yml, pass it as `bundle`.';

/**
 * The first thing `opa build` names as wrong, and a hint that fits it. It
 * prints errors on stdout, as `error: <summary>` and, when there are several,
 * one line per error after a summary that ends in a colon, such as `3 errors
 * occurred during loading:`.
 */
function describeBuildFailure(
  build: SpawnResult,
  v0Compatible: boolean | undefined,
): { reason: string; hint: string } {
  const lines = `${build.stdout}\n${build.stderr}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const at = Math.max(
    0,
    lines.findIndex((l) => l.startsWith('error:')),
  );
  const summary = (lines[at] ?? '').replace(/^error:\s*/, '');
  const reason = summary.endsWith(':') && lines[at + 1] ? lines[at + 1]! : summary;
  const all = lines.join('\n');

  let hint: string;
  if (/merge error/.test(all)) {
    hint = `Paths load as \`opa eval --data\` loads them: every JSON and YAML file is merged into the data root at its directory, so two files setting the same key conflict. Test fixtures kept beside a policy are the usual cause. ${BUNDLE_HINT}`;
  } else if (!v0Compatible && PRE_V1_SYNTAX.test(all)) {
    hint =
      'The policy looks like pre-1.0 Rego (rules without `if`). Set `v0Compatible`, or migrate it with rego_migrate_v1.';
  } else if (/rego_[a-z_]+_error/.test(all)) {
    hint = 'Fix the policy at the file and line named.';
  } else if (/\.(json|ya?ml)\b/i.test(all)) {
    hint = `Paths load as \`opa eval --data\` loads them, so every JSON and YAML file under a directory must parse as data, editor settings and chart templates included. ${BUNDLE_HINT}`;
  } else {
    hint = 'Check that every path is one opa can load.';
  }
  return { reason, hint };
}

/**
 * Why `opa exec` failed before evaluating anything. It logs JSON lines on
 * stderr, and the first at level `error` names the cause, such as a bundle
 * that did not load or activate.
 */
function execFailure(result: SpawnResult, v0Compatible: boolean | undefined): ToolEnvelope<never> {
  let reason: string | undefined;
  for (const line of result.stderr.split(/\r?\n/)) {
    const entry = tryParseJson<{ level?: unknown; msg?: unknown; err?: unknown }>(line);
    if (entry?.level !== 'error') continue;
    // A failure at run time logs a generic `msg` and its cause in `err`.
    const text =
      typeof entry.msg === 'string' && entry.msg !== 'Unexpected error.' ? entry.msg : entry.err;
    if (typeof text !== 'string') continue;
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // `N errors occurred:` names only a count; the first error follows it.
    reason = lines[0]!.endsWith(':') && lines[1] ? `${lines[0]} ${lines[1]}` : lines[0];
    break;
  }
  const details = { stderr: result.stderr.trim(), stdout: result.stdout.trim() };
  if (reason !== undefined && /rego_[a-z_]+_error/.test(reason)) {
    return err('INVALID_REGO', `The policy did not load: ${reason}`, {
      hint:
        !v0Compatible && PRE_V1_SYNTAX.test(reason)
          ? 'The policy looks like pre-1.0 Rego (rules without `if`). Set `v0Compatible`, or migrate it with rego_migrate_v1.'
          : 'Fix the policy at the file and line named. A path in it is the one inside the bundle opa loaded.',
      details,
    });
  }
  return err(
    'EVAL_ERROR',
    reason !== undefined ? `opa exec failed: ${reason}` : 'opa exec exited with a non-zero status.',
    { details },
  );
}

/** Turn what `opa exec` printed into the tool's result. */
function readExecResult(
  result: SpawnResult,
  gateFlagSet: boolean,
  decisionPath: string,
  v0Compatible: boolean | undefined,
  warnings: string[],
): ToolEnvelope<OpaExecOutput> {
  const subprocessFailure = mapSubprocessFailure(result, 'opa');
  if (subprocessFailure) return subprocessFailure;

  // Without a gate flag, opa exec exits non-zero only on an operational
  // failure (unloadable bundle, unreadable input). With a gate flag set,
  // a non-zero exit is the gate firing on purpose: opa still prints the
  // per-file JSON to stdout, so parse it and report `failed: true`.
  if (result.exitCode !== 0 && !gateFlagSet) return execFailure(result, v0Compatible);

  const parsed = tryParseJson<OpaExecJsonOutput>(result.stdout);
  if (!parsed) {
    // A gate flag that exits non-zero with no JSON is a real failure
    // (e.g. the policy did not compile), not a decision outcome.
    if (result.exitCode !== 0) return execFailure(result, v0Compatible);
    return err('UNKNOWN_ERROR', 'opa exec produced no parseable JSON output.', {
      details: { stdout: result.stdout.trim() },
    });
  }

  const results: ExecResultEntry[] = parsed.result ?? [];
  const successCount = results.filter((r) => r.error === undefined).length;
  const errorCount = results.filter((r) => r.error !== undefined).length;

  // A decision naming nothing is reported per file as an undefined
  // decision, indistinguishable from every input legitimately matching no
  // rule. Both read as a pass under a `deny`-style policy, so say so.
  const allUndefined =
    results.length > 0 && results.every((r) => r.error?.code === 'opa_undefined_error');

  return ok<OpaExecOutput>(
    {
      results,
      count: results.length,
      successCount,
      errorCount,
      failed: result.exitCode !== 0,
      ...(allUndefined
        ? {
            hint: `Every input left \`${decisionPath}\` undefined. That is the expected outcome when no rule matched any of them, and it is also what a decision naming nothing in the loaded policy looks like. Confirm the rule exists at that path before reading this as a pass.`,
          }
        : {}),
    },
    warnings,
  );
}

/**
 * Convert a decision reference to the path `opa exec --decision` expects.
 *
 * `opa exec` names a decision by slash-separated path with no `data.` prefix.
 * Every other spelling, including the `data.authz.allow` this tool used to
 * document, is accepted by the flag and then resolves to nothing, so each input
 * file comes back with `opa_undefined_error` and the call looks like a policy
 * result rather than a mistake. Returns undefined when nothing is left to name.
 */
export function toDecisionPath(decision: string): string | undefined {
  const trimmed = decision.trim().replace(/^[/]+/, '').replace(/[/]+$/, '');
  // Drop a leading `data.` or `data/` root, but not a package named `database`.
  const withoutRoot = trimmed.replace(/^data(?=$|[./])[./]?/, '');
  if (withoutRoot.length === 0) return undefined;
  const segments = withoutRoot.includes('/') ? withoutRoot.split('/') : withoutRoot.split('.');
  if (segments.some((seg) => seg.length === 0)) return undefined;
  return segments.join('/');
}

export function registerOpaExec(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'opa_exec',
    {
      title: 'Batch-evaluate OPA policy against input files',
      description:
        'Evaluate a policy decision against one or more input files using `opa exec --format=json`. Unlike `rego_eval` (single input), `opa exec` processes every file independently and returns a per-file result -- ideal for CI pipelines that check many config files against a policy in one call. Supply `bundle` for a bundle, or `dataPaths` for plain `.rego`, JSON and YAML files and directories, which are loaded as `opa eval --data` loads them; the two are mutually exclusive. Each file that fails evaluation appears in `results` with an `error` field rather than a `result` field. Set one of `fail`/`failDefined`/`failNonEmpty` to turn the call into a CI gate: the result then reports `failed: true` (instead of erroring) when the gate condition is met.',
      inputSchema: OpaExecInput,
      annotations: {
        readOnlyHint: false,
        // Runs Rego supplied by the caller; a policy can reach the network through http.send.
        openWorldHint: true,
      },
    },
    async (
      {
        inputPaths,
        decision,
        bundle,
        dataPaths,
        fail,
        failDefined,
        failNonEmpty,
        timeout,
        v1Compatible,
        v0Compatible,
      },
      { signal },
    ) => {
      return withToolEnvelope<OpaExecOutput>(config, async () => {
        if (v0Compatible && v1Compatible) {
          return err(
            'INVALID_INPUT',
            '`v0Compatible` and `v1Compatible` ask for opposite Rego versions; set one.',
          );
        }

        if (bundle && dataPaths?.length) {
          return err(
            'INVALID_INPUT',
            'opa_exec accepts either `bundle` or `dataPaths`, not both. Choose one policy source.',
          );
        }

        if ([fail, failDefined, failNonEmpty].filter(Boolean).length > 1) {
          return err(
            'INVALID_INPUT',
            'opa_exec accepts at most one of `fail`, `failDefined`, or `failNonEmpty`.',
          );
        }

        const decisionPath = toDecisionPath(decision);
        if (decisionPath === undefined) {
          return err(
            'INVALID_INPUT',
            '`decision` must name a rule, for example "authz/allow" or "data.authz.allow".',
          );
        }

        // Validate input file paths.
        const inputValidation = validatePaths(inputPaths, config, { mustExist: true });
        if (!inputValidation.ok) return inputValidation.error;

        // Validate bundle path.
        let resolvedBundle: string | undefined;
        if (bundle) {
          const v = validatePaths([bundle], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedBundle = v.resolved[0];
        }

        // Validate data paths.
        let resolvedDataPaths: string[] | undefined;
        if (dataPaths?.length) {
          const v = validatePaths(dataPaths, config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedDataPaths = v.resolved;
        }

        // `opa exec` loads policy only through --bundle, which takes an archive
        // or a bundle directory: a .rego file there fails as "gzip: invalid
        // header", two plain directories fail as bundles with overlapping
        // roots, and a data file not named data.json, data.yaml or data.yml is
        // skipped.
        // Plain paths are therefore built into one bundle first by `opa
        // build`, which loads them as `opa eval --data` does. Real bundles
        // still go straight to --bundle.
        const bundles = resolvedBundle ? [resolvedBundle] : [];
        let plain: string[] = [];
        if (resolvedDataPaths) {
          const isBundle = await Promise.all(resolvedDataPaths.map(isBundlePath));
          bundles.push(...resolvedDataPaths.filter((_, i) => isBundle[i]));
          plain = resolvedDataPaths.filter((_, i) => !isBundle[i]);
          if (plain.length > 0 && bundles.length > 0) {
            return err(
              'INVALID_INPUT',
              '`dataPaths` mixes bundles with plain policy or data paths, which opa cannot load together: the plain ones form a bundle whose root overlaps every other bundle.',
              {
                hint: 'Pass the bundles on their own, or add the plain files to a bundle with opa_bundle_build.',
                details: { bundles, plain },
              },
            );
          }
        }

        const warnings = (await archivesWithin(plain)).map(
          (archive) =>
            `${archive} was not loaded: it is a bundle archive inside a \`dataPaths\` directory, which \`opa eval --data\` would load and the bundle built from plain paths leaves out. Pass it as \`bundle\` on its own, or its unpacked files in \`dataPaths\`.`,
        );
        const gateFlagSet = fail === true || failDefined === true || failNonEmpty === true;
        const workDir =
          plain.length > 0 ? await mkdtemp(join(tmpdir(), 'orygn-opa-mcp-exec-')) : undefined;
        try {
          if (workDir !== undefined) {
            const built = join(workDir, 'policy.tar.gz');
            const build = await opa.build(
              { paths: plain, output: built, v0Compatible, v1Compatible },
              signal,
            );
            const buildFailure = mapSubprocessFailure(build, 'opa');
            if (buildFailure) return buildFailure;
            if (/load paths span more than one drive/.test(build.stderr)) {
              return err('INVALID_INPUT', build.stderr.trim(), {
                hint: 'Put every path in `dataPaths` on one drive.',
              });
            }
            if (build.exitCode !== 0) {
              const { reason, hint } = describeBuildFailure(build, v0Compatible);
              return err(
                'INVALID_REGO',
                `The policy and data in \`dataPaths\` did not load${reason ? `: ${reason}` : '.'}`,
                {
                  hint,
                  details: { stdout: build.stdout.trim(), stderr: build.stderr.trim() },
                },
              );
            }
            bundles.push(built);
          }

          const result = await opa.exec(
            {
              inputPaths: inputValidation.resolved,
              decision: decisionPath,
              bundles,
              fail,
              failDefined,
              failNonEmpty,
              timeout,
              v1Compatible,
              v0Compatible,
            },
            signal,
          );
          return readExecResult(result, gateFlagSet, decisionPath, v0Compatible, warnings);
        } finally {
          // A scanner still holding the new archive must not turn a finished
          // evaluation into an error; the directory is in the temp root.
          if (workDir !== undefined) {
            await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      });
    },
  );
}
