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
import { join } from 'node:path';

import type { Config } from '../config.js';
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
  exceptions: string[];
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
   * extension (yaml → .yaml, json → .json, dockerfile → Dockerfile, etc.).
   * Defaults to `yaml` when not specified.
   */
  inlineConfigParser?: string;
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
  parser?: string;
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

// ─── Parser → file extension map ─────────────────────────────────────────────

const PARSER_TO_EXT: Record<string, string> = {
  yaml: '.yaml',
  json: '.json',
  toml: '.toml',
  hcl1: '.hcl',
  hcl2: '.hcl',
  ini: '.ini',
  xml: '.xml',
  dotenv: '.env',
  cue: '.cue',
  jsonnet: '.jsonnet',
  properties: '.properties',
  edn: '.edn',
  hocon: '.conf',
  // Dockerfile is a special case -- conftest detects by filename
  dockerfile: '',
};

function parserToExt(parser: string): string {
  return PARSER_TO_EXT[parser.toLowerCase()] ?? `.${parser.toLowerCase()}`;
}

// ─── ConftestCli ──────────────────────────────────────────────────────────────

/**
 * Wrapper around the local `conftest` binary.
 *
 * Methods do not throw on conftest-side errors -- the exit code on the
 * returned `SpawnResult` is the signal. Inline source is written to temp
 * files/directories because conftest does not read from stdin.
 */
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
        if (input.parser) args.push('--parser', input.parser);

        // Config files (positional args, must come last)
        const effectiveFiles = configPath ? [configPath] : (input.files ?? []);
        args.push(...effectiveFiles);

        const result = await this.run(args, signal);
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
    return this.run(args, signal);
  }

  /**
   * Pull policies from a remote OCI or Git location into a local
   * directory. Stdout is minimal; errors go to stderr.
   */
  async pull(input: ConftestPullInput, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['pull', input.url];
    if (input.policy) args.push('--policy', input.policy);
    return this.run(args, signal);
  }

  /**
   * Push the local policy bundle to a remote OCI registry. Uses
   * credentials from the host environment (docker login, ORAS, etc.).
   */
  async push(input: ConftestPushInput, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['push', input.repository];
    if (input.policy) args.push('--policy', input.policy);
    return this.run(args, signal);
  }

  /**
   * Run `conftest` with the given argv. Tools should prefer the typed
   * methods above; this is the escape hatch for unusual invocations.
   */
  async run(args: string[], signal?: AbortSignal): Promise<SpawnResult> {
    const opts: Parameters<typeof runBinary>[1] = {
      args,
      timeoutMs: this.config.subprocessTimeoutMs,
    };
    if (signal !== undefined) opts.signal = signal;
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
      inlineConfigParser?: string;
      inlinePolicy?: string;
    },
    fn: (paths: { configPath?: string; policyDir?: string }) => Promise<T>,
  ): Promise<T> {
    const temps: string[] = [];
    const paths: { configPath?: string; policyDir?: string } = {};

    try {
      if (opts.inlineConfig !== undefined) {
        const ext =
          opts.inlineConfigParser === 'dockerfile'
            ? ''
            : parserToExt(opts.inlineConfigParser ?? 'yaml');
        const basename = opts.inlineConfigParser === 'dockerfile' ? 'Dockerfile' : `config${ext}`;
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
