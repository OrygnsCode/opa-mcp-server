/**
 * Wrapper around the optional `conftest` binary (policy testing for
 * configuration files using Rego).
 *
 * Conftest is OPTIONAL -- only the `conftest_*` tools require it. All
 * other tools work without Conftest installed. If absent, conftest tools
 * return a structured `CONFTEST_NOT_FOUND` error with an install hint.
 *
 * Conftest exit codes:
 *   0  -- all tests pass (or no failures, only warnings)
 *   1  -- one or more test failures
 *   2+ -- command error (bad args, policy not found, parse error, etc.)
 *
 * All structured output is obtained via `--output=json`; raw text output
 * is never parsed.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { Config } from '../config.js';
import { rewriteLoadPaths } from './opa-paths.js';
import { runBinary, type SpawnResult } from './subprocess.js';

// ─── Shared output types ──────────────────────────────────────────────────────

/**
 * A single denial or warning message returned by conftest. The `metadata`
 * field carries any structured data attached via the `{"msg": ..., ...}`
 * violation object form -- it is absent when the rule returned a plain string.
 */
export interface ConftestMessage {
  msg: string;
  metadata?: Record<string, unknown>;
}

/**
 * Per-file test result. One entry is emitted for each (filename, namespace)
 * pair that conftest evaluates.
 */
export interface ConftestFileResult {
  filename: string;
  namespace: string;
  successes: number;
  failures: ConftestMessage[];
  warnings: ConftestMessage[];
  skipped: ConftestMessage[];
  exceptions: ConftestMessage[];
}

/**
 * Parse `--output=json` from `conftest test` or `conftest verify` into
 * results whose array fields are always present.
 *
 * conftest marks every array `omitempty`, so a file that passes cleanly
 * arrives as `{filename, namespace, successes}` with no `failures` key at
 * all, and `verify` with no test rules prints the literal `null`. Reading
 * `.failures.length` off that threw on every clean run. Returns null when
 * stdout is not a JSON array (or `null`), which is what a command-level
 * failure looks like.
 */
export function parseConftestResults(stdout: string): ConftestFileResult[] | null {
  const text = stdout.trim();
  if (text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) return null;
  const messages = (v: unknown): ConftestMessage[] =>
    Array.isArray(v)
      ? v.map((m) =>
          m !== null && typeof m === 'object' ? (m as ConftestMessage) : { msg: String(m) },
        )
      : [];
  return parsed.map((item) => {
    const r = (item !== null && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      ...r,
      filename: typeof r['filename'] === 'string' ? r['filename'] : '',
      namespace: typeof r['namespace'] === 'string' ? r['namespace'] : '',
      successes: typeof r['successes'] === 'number' ? r['successes'] : 0,
      failures: messages(r['failures']),
      warnings: messages(r['warnings']),
      skipped: messages(r['skipped']),
      exceptions: messages(r['exceptions']),
    };
  });
}

// ─── Input types ──────────────────────────────────────────────────────────────

/** Input for `conftest test`. */
export interface ConftestTestInput {
  /** Absolute paths to configuration files to evaluate. */
  files?: string[];
  /** Inline configuration content. Mutually exclusive with `files`. */
  inlineConfig?: string;
  /**
   * Parser used for inline config content. Determines the temp file
   * name (yaml -> config.yaml, dockerfile -> Dockerfile, and so on).
   * Defaults to `yaml` when not specified.
   */
  inlineConfigParser?: ConftestParser;
  /**
   * Absolute path to a directory or file containing Rego policies.
   * Defaults to `./policy` (conftest's convention). Mutually exclusive
   * with `inlinePolicy`.
   */
  policy?: string;
  /**
   * Inline Rego policy source. Written to a temp directory and passed as
   * `--policy`. Mutually exclusive with `policy`.
   */
  inlinePolicy?: string;
  /** Namespace to test. Defaults to `main`. */
  namespace?: string;
  /** Test policies in all discovered namespaces. */
  allNamespaces?: boolean;
  /** Absolute paths to data directories for Rego policies. */
  data?: string[];
  /** Combine all config files into a single document before testing. */
  combine?: boolean;
  /** Return exit 1 when only warnings are present (no hard failures). */
  failOnWarn?: boolean;
  /**
   * Force a specific parser for all inputs via conftest's global `--parser`
   * flag, overriding extension-based detection. Use it to parse files whose
   * extension does not match their format (e.g. a `.tfstate` file as `json`).
   */
  parser?: ConftestParser;
}

/** Input for `conftest verify`. */
export interface ConftestVerifyInput {
  /** Absolute path to the policy directory to verify. */
  policy?: string;
  /** Namespace to verify. Defaults to `main`. */
  namespace?: string;
  /** Absolute paths to data directories. */
  data?: string[];
}

/** Input for `conftest pull`. */
export interface ConftestPullInput {
  /** Policy URL to pull from (OCI: `oci://registry/repo:tag`). */
  url: string;
  /** Local directory to store pulled policies. Defaults to `./policy`. */
  policy?: string;
}

/** Input for `conftest push`. */
export interface ConftestPushInput {
  /** OCI repository URL to push policies to. */
  repository: string;
  /** Local directory containing policies to push. Defaults to `./policy`. */
  policy?: string;
}

// ─── Parser names ─────────────────────────────────────────────────────────────

/**
 * The parsers conftest 0.69 accepts for `--parser`, and the only values a
 * caller may pass. The name also chooses the temp file name for inline
 * config, so it must never be free text: a value carrying path separators
 * used to be joined straight into the temp path, and `../` sequences in it
 * walked out of the temp directory to wherever the caller pointed.
 */
export const CONFTEST_PARSERS = [
  'cue',
  'dockerfile',
  'dotenv',
  'edn',
  'hcl1',
  'hcl2',
  'hocon',
  'ignore',
  'ini',
  'json',
  'jsonnet',
  'nginx',
  'properties',
  'spdx',
  'textproto',
  'toml',
  'vcl',
  'xml',
  'yaml',
] as const;

export type ConftestParser = (typeof CONFTEST_PARSERS)[number];

export function isConftestParser(value: string): value is ConftestParser {
  return (CONFTEST_PARSERS as readonly string[]).includes(value);
}

/**
 * Temp file names for inline config. The parser is passed to conftest
 * explicitly, so the name only has to be plausible for a reader of the
 * output; conftest also recognises a Dockerfile by name.
 */
const INLINE_CONFIG_FILENAME: Record<ConftestParser, string> = {
  cue: 'config.cue',
  dockerfile: 'Dockerfile',
  dotenv: 'config.env',
  edn: 'config.edn',
  hcl1: 'config.hcl',
  hcl2: 'config.hcl',
  hocon: 'config.conf',
  ignore: '.gitignore',
  ini: 'config.ini',
  json: 'config.json',
  jsonnet: 'config.jsonnet',
  nginx: 'nginx.conf',
  properties: 'config.properties',
  spdx: 'config.spdx',
  textproto: 'config.textproto',
  toml: 'config.toml',
  vcl: 'config.vcl',
  xml: 'config.xml',
  yaml: 'config.yaml',
};

/**
 * Temp file name for inline config. Throws on anything outside the closed
 * set; the tool layer rejects such input first, so this is the backstop for
 * any other caller.
 */
function inlineConfigFilename(parser: string | undefined): string {
  const name = parser ?? 'yaml';
  if (!isConftestParser(name)) {
    throw new Error(`unsupported conftest parser: ${name}`);
  }
  return INLINE_CONFIG_FILENAME[name];
}

// ─── ConftestCli ──────────────────────────────────────────────────────────────

/**
 * Wrapper around the local `conftest` binary.
 *
 * Methods do not throw on conftest-side errors -- the exit code on the
 * returned `SpawnResult` is the signal. Inline source is written to temp
 * files/directories because conftest does not read from stdin.
 */
/**
 * Split a policy directory into the directory to run from and the name to pass.
 *
 * `conftest pull` and `conftest push` resolve `--policy` against the working
 * directory rather than treating an absolute path as absolute. On Windows pull
 * fails outright, reporting a path of the form `.\\C:\\...`, and push drops the
 * volume and reads from the same path on whichever drive it was started on. The
 * tools resolve the caller's path against the allow-list before handing it over,
 * so it is always absolute and neither command ever addressed the directory
 * asked for. Running from the parent and passing the final component is
 * unambiguous on every platform.
 */
function relativeToParent(
  policy: string | undefined,
): { parent: string; name: string } | undefined {
  if (!policy) return undefined;
  const parent = dirname(policy);
  const name = basename(policy);
  // A root such as `C:\\` or `/` has nothing to descend into.
  if (name.length === 0 || parent === policy) return undefined;
  return { parent, name };
}

/**
 * Pick a working directory on the drive the given paths live on.
 *
 * Conftest loads its policy and data directories through OPA's loader, which
 * splits an absolute path on its first colon and resolves the remainder
 * against the drive the process is on, so `--policy C:...` fails from a
 * working directory on another drive. The configs under test are read by
 * conftest itself and open fine from anywhere, so they are not anchors: an
 * inline config in the temp directory can be tested against a policy on
 * another drive, and an inline policy against a config on another drive.
 * The paths are left exactly as given, since conftest echoes them in its
 * output and the inline temp files are matched there afterwards to redact
 * them.
 */
function anchorDrive(
  args: string[],
  paths: Array<string | undefined>,
): { cwd?: string; conflict?: SpawnResult } {
  const present = paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
  const out = rewriteLoadPaths(args, present, { respell: false });
  if (out.conflict) {
    return {
      conflict: {
        exitCode: 1,
        stdout: '',
        stderr:
          `paths span more than one drive (${out.conflict.drives.join(', ')}). ` +
          'conftest resolves an absolute path against the drive it runs on, so the policy ' +
          'and data directories must be on a single drive.',
        timedOut: false,
        aborted: false,
        durationMs: 0,
      },
    };
  }
  return out.cwd !== undefined ? { cwd: out.cwd } : {};
}

export class ConftestCli {
  constructor(private readonly config: Config) {}

  /**
   * Verify the binary is present and return its version string. Returns
   * null if the binary is unreachable or the version output is malformed.
   */
  async version(signal?: AbortSignal): Promise<string | null> {
    const result = await this.run(['--version'], signal);
    if (result.exitCode !== 0) return null;
    // conftest --version output: "conftest (version: 0.68.2)"
    const match =
      /conftest\s*\(version:\s*([^)]+)\)/i.exec(result.stdout) ??
      /v?(\d+\.\d+\.\d+\S*)/i.exec(result.stdout);
    return match?.[1]?.trim() ?? null;
  }

  /**
   * Run `conftest test` against one or more configuration files. Always
   * uses `--output=json` so output is machine-readable.
   *
   * When `inlineConfig` or `inlinePolicy` are provided, temp files are
   * created and cleaned up automatically. Temp file paths in the JSON
   * output are replaced with `<inline>` before the result is returned so
   * callers never see implementation-internal paths.
   */
  async test(input: ConftestTestInput, signal?: AbortSignal): Promise<SpawnResult> {
    return this.withTempAssets(
      {
        inlineConfig: input.inlineConfig,
        inlineConfigParser: input.inlineConfigParser,
        inlinePolicy: input.inlinePolicy,
      },
      async ({ configPath, policyDir }) => {
        const args = ['test', '--output=json', '--no-color'];

        // Policy source
        const effectivePolicyDir = policyDir ?? input.policy;
        if (effectivePolicyDir) args.push('--policy', effectivePolicyDir);

        // Namespace
        if (input.allNamespaces) {
          args.push('--all-namespaces');
        } else if (input.namespace) {
          args.push('--namespace', input.namespace);
        }

        // Data directories
        for (const d of input.data ?? []) args.push('--data', d);

        // Flags
        if (input.combine) args.push('--combine');
        if (input.failOnWarn) args.push('--fail-on-warn');
        // conftest's --parser overrides extension detection, so inline
        // config names its parser explicitly rather than trusting the temp
        // file's extension. A global `parser` wins when both are given.
        const parser =
          input.parser ?? (configPath ? (input.inlineConfigParser ?? 'yaml') : undefined);
        if (parser) args.push('--parser', parser);

        // Config files (positional args, must come last)
        const effectiveFiles = configPath ? [configPath] : (input.files ?? []);
        args.push(...effectiveFiles);

        // Only the policy and data go through OPA's loader; conftest reads
        // the configs itself, so they may sit on any drive.
        const anchored = anchorDrive(args, [effectivePolicyDir, ...(input.data ?? [])]);
        if (anchored.conflict) return anchored.conflict;
        const result = await this.run(args, signal, anchored.cwd);
        return this.sanitizeOutput(result, configPath, policyDir);
      },
    );
  }

  /**
   * Run `conftest verify` -- executes the `_test.rego` tests inside the
   * policy directory to verify the policies themselves.
   */
  async verify(input: ConftestVerifyInput, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['verify', '--output=json', '--no-color'];
    if (input.policy) args.push('--policy', input.policy);
    if (input.namespace) args.push('--namespace', input.namespace);
    for (const d of input.data ?? []) args.push('--data', d);
    const anchored = anchorDrive(args, [input.policy, ...(input.data ?? [])]);
    if (anchored.conflict) return anchored.conflict;
    return this.run(args, signal, anchored.cwd);
  }

  /**
   * Pull policies from a remote OCI or Git location into a local
   * directory. Stdout is minimal; errors go to stderr.
   */
  async pull(input: ConftestPullInput, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['pull', input.url];
    const target = relativeToParent(input.policy);
    if (target) args.push('--policy', target.name);
    return this.run(args, signal, target?.parent);
  }

  /**
   * Push the local policy bundle to a remote OCI registry. Uses
   * credentials from the host environment (docker login, ORAS, etc.).
   */
  async push(input: ConftestPushInput, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['push', input.repository];
    const target = relativeToParent(input.policy);
    if (target) args.push('--policy', target.name);
    return this.run(args, signal, target?.parent);
  }

  /**
   * Run `conftest` with the given argv. Tools should prefer the typed
   * methods above; this is the escape hatch for unusual invocations.
   */
  async run(args: string[], signal?: AbortSignal, cwd?: string): Promise<SpawnResult> {
    const opts: Parameters<typeof runBinary>[1] = {
      args,
      timeoutMs: this.config.subprocessTimeoutMs,
      maxOutputBytes: this.config.maxSubprocessBytes,
    };
    if (signal !== undefined) opts.signal = signal;
    if (cwd !== undefined) opts.cwd = cwd;
    return runBinary(this.config.conftestBinary, opts);
  }

  // ─── Internal: temp file / directory management ──────────────────────────

  /**
   * Create temp assets for inline inputs, run `fn`, then clean up.
   * Returns whatever `fn` returns.
   */
  private async withTempAssets<T>(
    opts: {
      inlineConfig?: string;
      inlineConfigParser?: ConftestParser;
      inlinePolicy?: string;
    },
    fn: (paths: { configPath?: string; policyDir?: string }) => Promise<T>,
  ): Promise<T> {
    const temps: string[] = [];
    const paths: { configPath?: string; policyDir?: string } = {};

    try {
      if (opts.inlineConfig !== undefined) {
        const basename = inlineConfigFilename(opts.inlineConfigParser);
        // mkdtemp creates the directory atomically (O_CREAT|O_EXCL) -- safe temp file pattern.
        const tmpDir = await mkdtemp(join(tmpdir(), 'orygn-conftest-'));
        temps.push(tmpDir);
        const configPath = join(tmpDir, basename);
        await writeFile(configPath, opts.inlineConfig, 'utf8');
        paths.configPath = configPath;
      }

      if (opts.inlinePolicy !== undefined) {
        // mkdtemp creates the directory atomically (O_CREAT|O_EXCL) -- safe temp file pattern.
        const policyDir = await mkdtemp(join(tmpdir(), 'orygn-conftest-policy-'));
        temps.push(policyDir);
        const policyFile = join(policyDir, 'policy.rego');
        await writeFile(policyFile, opts.inlinePolicy, 'utf8');
        paths.policyDir = policyDir;
      }

      return await fn(paths);
    } finally {
      await Promise.all(temps.map((p) => rm(p, { recursive: true, force: true })));
    }
  }

  /**
   * Replace the temp inline-config path and temp inline-policy directory
   * path in the stdout JSON with `<inline>` so callers never see
   * implementation-internal temp paths.
   *
   * conftest emits paths inside a JSON array, so each backslash in the
   * path is JSON-encoded as `\\`. We match the JSON-encoded form of the
   * path to handle Windows paths correctly (forward slashes need no
   * special treatment).
   */
  private sanitizeOutput(
    result: SpawnResult,
    configPath: string | undefined,
    policyDir: string | undefined,
  ): SpawnResult {
    if (!configPath && !policyDir) return result;
    if (!result.stdout) return result;

    let stdout = result.stdout;

    if (configPath) {
      // JSON.stringify encodes backslashes as \\, so match the encoded form.
      const jsonEncoded = JSON.stringify(configPath).slice(1, -1);
      const escaped = jsonEncoded.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
      stdout = stdout.replace(new RegExp(escaped, 'g'), '<inline>');
    }

    if (policyDir) {
      const jsonEncoded = JSON.stringify(policyDir).slice(1, -1);
      const escaped = jsonEncoded.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
      // Policy dir appears in conftest output as part of file paths.
      // Replace the full dir prefix so the policy filename is preserved.
      stdout = stdout.replace(new RegExp(escaped, 'g'), '<inline-policy>');
    }

    return { ...result, stdout };
  }
}
