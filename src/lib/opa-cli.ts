/**
 * Wrapper around the local `opa` binary.
 *
 * Tool implementations call into this module rather than spawning
 * subprocesses directly. Every method here builds argv with the flags
 * `opa` actually expects so each tool above can ignore CLI minutiae and
 * just describe its inputs.
 *
 * Inline Rego source is always written to a temp file before invocation.
 * The `-` (read-from-stdin) convention some opa subcommands document is
 * unreliable on Windows, where `-` is treated as a literal filename.
 *
 * The methods do not parse stdout into typed result objects -- different
 * tools need different shapes of the same output and a one-size parser
 * would force conversions both ways. Stdout is JSON whenever
 * `--format=json` is set, and tools call `JSON.parse` on it themselves.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../config.js';
import { runBinary, type SpawnResult } from './subprocess.js';

/** Input for the formatter. */
export interface FmtInput {
  /** Rego source code to format. */
  source: string;
  /** Format for compatibility with both Rego v1 and the current OPA version (`opa fmt --rego-v1`). */
  regoV1?: boolean;
}

/** Input for `opa fmt --list` / `opa fmt --write` (file-based formatting). */
export interface FmtWriteInput {
  /** Policy files or directories to format. */
  paths: string[];
  /** Format module(s) to be compatible with both Rego v1 and the current OPA version. */
  regoV1?: boolean;
  /** Opt-in to OPA behaviors prior to the v1.0 release. */
  v0Compatible?: boolean;
  /** Opt-in to OPA v1.0-compatible behaviors. */
  v1Compatible?: boolean;
}

/** Input for `opa check`. */
export interface CheckInput {
  /** Inline Rego source. Mutually exclusive with `paths`. */
  source?: string;
  /** File or directory paths to check. */
  paths?: string[];
  /** Path to a capabilities JSON file (restrict allowed builtins). */
  capabilities?: string;
  /** Run in strict mode (fail on unused vars, deprecated builtins, etc.). */
  strict?: boolean;
  /** Schema directory for input/data validation. */
  schemaDir?: string;
  /** Opt-in to OPA v1.0-compatible behaviors (`opa check --v1-compatible`). */
  v1Compatible?: boolean;
  /** Opt-in to OPA behaviors prior to the v1.0 release (`opa check --v0-compatible`). */
  v0Compatible?: boolean;
}

/** Input for `opa parse`. */
export interface ParseInput {
  /** Rego source to parse. */
  source: string;
  /**
   * Include source location data in the AST. When true, every AST node
   * gains a `location.text` field (base64-encoded source text) plus
   * `location.row` and `location.col`. Required by rego_explain_undefined
   * to identify which body expression is blocking each rule.
   */
  includeLocations?: boolean;
}

/** Input for `opa inspect`. */
export interface InspectInput {
  /** Path to a bundle archive, directory, or single Rego file. */
  target: string;
}

/** Input for `opa capabilities`. */
export interface CapabilitiesInput {
  /** Print the capabilities of the running OPA instead of a named version. */
  current?: boolean;
  /** A specific capabilities version (e.g. "v0.50.0"). */
  version?: string;
}

/** Input for `opa deps`. */
export interface DepsInput {
  /** Policy/data paths to load before computing dependencies. */
  paths: string[];
  /** Reference to compute dependencies for, e.g. "data.example.allow". */
  ref: string;
}

/** Input for `opa eval`. */
export interface EvalInput {
  /** The query string, e.g. "data.example.allow" or "x := 1; x > 0". */
  query: string;
  /** Inline Rego source. Written to a temp file and added to `--data`. */
  source?: string;
  /** Policy / data file or directory paths. */
  paths?: string[];
  /** Inline input document. JSON-stringified and piped via `--stdin-input`. */
  input?: unknown;
  /** Path to an input JSON file. Mutually exclusive with `input`. */
  inputPath?: string;
  /** Add a trace at the requested level. */
  explain?: 'full' | 'notes' | 'fails' | 'debug';
  /** Add per-rule timing data. */
  profile?: boolean;
  /** Add per-line coverage data. */
  coverage?: boolean;
  /** Add evaluation metrics. */
  metrics?: boolean;
  /** Add detailed instrumentation. */
  instrument?: boolean;
  /** Run partial evaluation. */
  partial?: boolean;
  /** Refs treated as unknown during partial evaluation, e.g. ["input.user"]. */
  unknowns?: string[];
  /** Treat builtin errors as fatal instead of returning undefined. */
  strictBuiltinErrors?: boolean;
  /** Path to a capabilities JSON file. */
  capabilities?: string;
  /** Schema directory for input/data validation. */
  schemaDir?: string;
}

/** Input for `opa test`. */
export interface TestInput {
  /** Test directories or files. Tests live in `*_test.rego` siblings. */
  paths: string[];
  /** Verbose output (per-test pass/fail details). */
  verbose?: boolean;
  /** Emit per-line coverage as a JSON object on stdout (overrides the test-record JSON array format). */
  coverage?: boolean;
  /** Run only tests whose names match this regex. */
  runPattern?: string;
  /** Bench-style timing alongside test results. */
  bench?: boolean;
  /**
   * Minimum coverage percentage gate (0–100). OPA exits non-zero when actual
   * coverage is below this value. Implicitly enables coverage-mode output
   * (same stdout format as `coverage: true`).
   */
  threshold?: number;
  /**
   * Emit local variable values in trace output (`--var-values`). When set,
   * each failing test record includes a `trace` array with per-step variable
   * bindings. Useful for debugging table-driven tests: shows which case in an
   * `every tc in cases { ... }` loop caused the failure.
   */
  varValues?: boolean;
  /**
   * Glob patterns for files to exclude from the test run (`--ignore <pattern>`).
   * Pass one pattern per array element; OPA evaluates each independently.
   * Useful for excluding generated files or fixture directories with no tests.
   */
  ignorePatterns?: string[];
  /**
   * Treat paths as bundle roots (`--bundle`). Required when testing policies
   * structured as OPA bundles (with `manifest.json` / `data.json` at the root).
   * Mutually exclusive with plain directory mode.
   */
  bundle?: boolean;
  /**
   * Number of times to repeat each test (`--count N`). Default is 1. Increase
   * to measure test repeatability or spot flaky tests.
   */
  count?: number;
  /**
   * Per-test timeout as a Go duration string, e.g. `"30s"`, `"1m"`.
   * OPA's built-in default is 5s; increase for tests that load large policy
   * sets or call slow built-ins (`--timeout <duration>`).
   */
  timeout?: string;
}

/** Input for `opa bench`. */
export interface BenchInput {
  /** The query to benchmark. */
  query: string;
  /** Policy / data paths to load. */
  paths?: string[];
  /** Inline input document. JSON-stringified and piped via `--stdin-input`. */
  input?: unknown;
  /** Path to an input JSON file. */
  inputPath?: string;
  /** Number of benchmark iterations. */
  count?: number;
}

/** Input for `opa build`. */
export interface BuildInput {
  /** Policy / data paths to bundle. */
  paths: string[];
  /** Output bundle path (typically `*.tar.gz`). */
  output: string;
  /** Optimization level (0 = none, 2 = aggressive). */
  optimize?: 0 | 1 | 2;
  /** Bundle revision string written to the manifest. */
  revision?: string;
  /** Build target (`rego` for source, `wasm` for compiled WASM). */
  target?: 'rego' | 'wasm';
  /** Entrypoint refs (required when `target=wasm` or `optimize > 0`). */
  entrypoints?: string[];
  /** Path to a signing key for inline signing. */
  signingKey?: string;
  /** Signing algorithm (e.g. `RS256`). */
  signingAlg?: string;
  /** Path to a claims file for inline signing. */
  claimsFile?: string;
  /** Path to a capabilities JSON file. */
  capabilities?: string;
  /** Load `paths` as bundle files or root directories (`--bundle`). Needed to rebuild an existing bundle. */
  bundle?: boolean;
  /** Exclude dependents of entrypoints not reachable from them (`--prune-unused`). */
  pruneUnused?: boolean;
  /** File/directory name patterns to ignore during loading (`--ignore`, e.g. `.*`). */
  ignore?: string[];
  /** Opt in to OPA v1.0-compatible behaviors (`--v1-compatible`). */
  v1Compatible?: boolean;
  /** PEM public key / HMAC secret path to re-verify a signed bundle during build (`--verification-key`). */
  verificationKey?: string;
  /** Key ID for verification (`--verification-key-id`, OPA default `default`). */
  verificationKeyId?: string;
}

/** Input for `opa sign`. */
export interface SignInput {
  /** Path to a bundle directory or archive. */
  bundle: string;
  /** Path to the signing key. */
  signingKey: string;
  /** Signing algorithm (e.g. `RS256`). Defaults to `RS256` in OPA. */
  signingAlg?: string;
  /** Path to a claims file (extra signed claims). */
  claimsFile?: string;
}

/** Input for `opa exec` -- batch evaluation against multiple input files. */
export interface ExecInput {
  /** One or more input file paths (JSON/YAML) or directories to evaluate. */
  inputPaths: string[];
  /** The policy decision (entrypoint) to evaluate for each input, e.g. `data.authz.allow`. */
  decision: string;
  /** Load path as a bundle file or root directory. Mutually exclusive with `dataPaths`. */
  bundle?: string;
  /** Policy/data file or directory paths to load. Mutually exclusive with `bundle`. */
  dataPaths?: string[];
}

/** Input for bundle signature verification via `opa eval --bundle`. */
export interface BundleVerifyInput {
  /** Path to the signed bundle directory or `.tar.gz` archive. */
  bundle: string;
  /**
   * Path to the PEM file containing the public key (RSA/ECDSA) or the
   * HMAC secret file used to verify the bundle signature.
   */
  verificationKey: string;
  /**
   * Key ID that must match the `keyid` claim in the bundle signature.
   * Required when the bundle was signed with `--public-key-id`.
   */
  verificationKeyId?: string;
  /** Signing algorithm used when the bundle was signed (e.g. `RS256`, `HS256`). */
  signingAlg?: string;
  /**
   * Expected `scope` value in the bundle signature. Required when the
   * bundle was signed with `--scope`.
   */
  scope?: string;
}

/**
 * Wrapper around the local `opa` binary.
 *
 * Methods do not throw on `opa` errors -- non-zero exit codes are
 * surfaced on the returned `SpawnResult` so tools can map them to
 * structured error envelopes at their layer. They DO throw on
 * caller-side bugs (e.g. an empty `paths` array passed where one is
 * required), since those represent contract violations.
 */
export class OpaCli {
  constructor(private readonly config: Config) {}

  /**
   * Verify the binary is present and report its version.
   * Returns null if the binary is unreachable or output is malformed.
   */
  async version(signal?: AbortSignal): Promise<string | null> {
    const result = await this.run(['version'], undefined, signal);
    if (result.exitCode !== 0) return null;
    const match = /Version:\s*(\S+)/i.exec(result.stdout);
    return match?.[1] ?? null;
  }

  // ─── Authoring ───────────────────────────────────────────────────────

  /**
   * Format Rego source. Stdout contains the formatted output. Reports
   * `exitCode: 0` even when no changes are needed -- callers compare
   * input vs output to detect a no-op.
   */
  async fmt(input: FmtInput, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['fmt'];
    if (input.regoV1) args.push('--rego-v1');
    return this.withTempSource(input.source, (path) =>
      this.run([...args, path], undefined, signal),
    );
  }

  /**
   * List files that would be reformatted. Stdout is one absolute path per
   * line for each file that is not already canonical. Exit 0 on success,
   * non-zero (exit 2) if any file cannot be parsed.
   *
   * NOTE: --list and --write are mutually exclusive in OPA: passing both
   * suppresses the write. Always use separate fmtList + fmtWrite calls.
   */
  async fmtList(input: FmtWriteInput, signal?: AbortSignal): Promise<SpawnResult> {
    if (input.paths.length === 0) {
      throw new Error('opa fmt requires at least one path');
    }
    const args = ['fmt', '--list'];
    if (input.regoV1) args.push('--rego-v1');
    if (input.v0Compatible) args.push('--v0-compatible');
    if (input.v1Compatible) args.push('--v1-compatible');
    args.push(...input.paths);
    return this.run(args, undefined, signal);
  }

  /**
   * Overwrite each file with its canonically formatted version. Exit 0 on
   * success, non-zero (exit 2) if any file cannot be parsed.
   */
  async fmtWrite(input: FmtWriteInput, signal?: AbortSignal): Promise<SpawnResult> {
    if (input.paths.length === 0) {
      throw new Error('opa fmt requires at least one path');
    }
    const args = ['fmt', '--write'];
    if (input.regoV1) args.push('--rego-v1');
    if (input.v0Compatible) args.push('--v0-compatible');
    if (input.v1Compatible) args.push('--v1-compatible');
    args.push(...input.paths);
    return this.run(args, undefined, signal);
  }

  /**
   * Type-check Rego. Returns `exitCode: 0` and empty `stdout` when the
   * policy is valid. On failure, `exitCode` is non-zero and the JSON
   * error report is written to **stderr** (this is OPA's actual
   * behavior -- tools must read `stderr`, not `stdout`, for `check`
   * diagnostics). Either inline `source` or one or more `paths` must be
   * provided.
   */
  async check(input: CheckInput, signal?: AbortSignal): Promise<SpawnResult> {
    if (!input.source && !input.paths?.length) {
      throw new Error('opa check requires either source or at least one path');
    }
    const args = ['check', '--format=json'];
    if (input.strict) args.push('--strict');
    if (input.v1Compatible) args.push('--v1-compatible');
    if (input.v0Compatible) args.push('--v0-compatible');
    if (input.capabilities) args.push('--capabilities', input.capabilities);
    if (input.schemaDir) args.push('--schema', input.schemaDir);
    if (input.source !== undefined) {
      return this.withTempSource(input.source, (path) =>
        this.run([...args, path], undefined, signal),
      );
    }
    args.push(...(input.paths ?? []));
    return this.run(args, undefined, signal);
  }

  /**
   * Parse Rego source to a JSON AST. Stdout is the AST as JSON.
   * Set `includeLocations: true` to add base64-encoded source text and
   * row/col data to every AST node (`--json-include locations,-comments`).
   */
  async parse(input: ParseInput, signal?: AbortSignal): Promise<SpawnResult> {
    return this.withTempSource(input.source, (path) => {
      const args = ['parse', '--format=json'];
      if (input.includeLocations) args.push('--json-include', 'locations,-comments');
      args.push(path);
      return this.run(args, undefined, signal);
    });
  }

  /**
   * Inspect a bundle, directory, or single Rego file. Returns its
   * packages, namespaces, manifest, and annotations as JSON on stdout.
   */
  async inspect(input: InspectInput, signal?: AbortSignal): Promise<SpawnResult> {
    return this.run(['inspect', '--format=json', '--annotations', input.target], undefined, signal);
  }

  /**
   * Print available capabilities. With `current=true`, prints the
   * capabilities of the running OPA. With a `version`, prints those of
   * a specific named version. Without either, lists available named
   * versions.
   */
  async capabilities(input: CapabilitiesInput = {}, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['capabilities'];
    if (input.current) args.push('--current');
    if (input.version) args.push('--version', input.version);
    return this.run(args, undefined, signal);
  }

  /**
   * Static dependency analysis for a Rego ref. Stdout is JSON with the
   * `base` and `virtual` document references the ref depends on.
   */
  async deps(input: DepsInput, signal?: AbortSignal): Promise<SpawnResult> {
    if (input.paths.length === 0) {
      throw new Error('opa deps requires at least one path');
    }
    const args = ['deps', '--format=json'];
    for (const path of input.paths) {
      args.push('--data', path);
    }
    args.push(input.ref);
    return this.run(args, undefined, signal);
  }

  // ─── Evaluation ──────────────────────────────────────────────────────

  /**
   * Evaluate a query against a policy + input. Stdout is JSON with the
   * standard `{result: [...]}` shape (plus optional explain, profile,
   * coverage, and metrics sections).
   */
  async eval(input: EvalInput, signal?: AbortSignal): Promise<SpawnResult> {
    // Inline source becomes a temp file added to --data.
    if (input.source !== undefined) {
      const { source, ...rest } = input;
      void source;
      return this.withTempSource(input.source, (sourcePath) =>
        this.eval(
          {
            ...rest,
            paths: [...(input.paths ?? []), sourcePath],
          },
          signal,
        ),
      );
    }

    const args = ['eval', '--format=json'];
    for (const path of input.paths ?? []) args.push('--data', path);
    if (input.inputPath) args.push('--input', input.inputPath);
    if (input.explain) args.push('--explain', input.explain);
    if (input.profile) args.push('--profile');
    if (input.coverage) args.push('--coverage');
    if (input.metrics) args.push('--metrics');
    if (input.instrument) args.push('--instrument');
    if (input.partial) args.push('--partial');
    for (const ref of input.unknowns ?? []) args.push('--unknowns', ref);
    if (input.strictBuiltinErrors) args.push('--strict-builtin-errors');
    if (input.capabilities) args.push('--capabilities', input.capabilities);
    if (input.schemaDir) args.push('--schema', input.schemaDir);

    let stdin: string | undefined;
    if (input.input !== undefined) {
      args.push('--stdin-input');
      stdin = JSON.stringify(input.input);
    }

    args.push(input.query);
    return this.run(args, stdin, signal);
  }

  /**
   * Run Rego unit tests. Stdout is JSON with per-test pass/fail.
   */
  async test(input: TestInput, signal?: AbortSignal): Promise<SpawnResult> {
    if (input.paths.length === 0) {
      throw new Error('opa test requires at least one path');
    }
    const args = ['test', '--format=json'];
    if (input.verbose) args.push('--verbose');
    if (input.coverage) args.push('--coverage');
    if (input.bench) args.push('--bench');
    if (input.bundle) args.push('--bundle');
    if (input.runPattern) args.push('--run', input.runPattern);
    if (input.varValues) args.push('--var-values');
    if (input.threshold !== undefined) args.push('--threshold', String(input.threshold));
    for (const pat of input.ignorePatterns ?? []) args.push('--ignore', pat);
    if (input.count !== undefined) args.push('--count', String(input.count));
    if (input.timeout) args.push('--timeout', input.timeout);
    args.push(...input.paths);
    return this.run(args, undefined, signal);
  }

  /**
   * Benchmark a query. Stdout is JSON with iteration timing statistics.
   */
  async bench(input: BenchInput, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['bench', '--format=json'];
    for (const path of input.paths ?? []) args.push('--data', path);
    if (input.inputPath) args.push('--input', input.inputPath);
    if (input.count !== undefined) args.push('--count', String(input.count));

    let stdin: string | undefined;
    if (input.input !== undefined) {
      args.push('--stdin-input');
      stdin = JSON.stringify(input.input);
    }

    args.push(input.query);
    return this.run(args, stdin, signal);
  }

  // ─── Bundles ─────────────────────────────────────────────────────────

  /** Build a deployable bundle from policy + data paths. */
  async build(input: BuildInput, signal?: AbortSignal): Promise<SpawnResult> {
    if (input.paths.length === 0) {
      throw new Error('opa build requires at least one input path');
    }
    const args = ['build', '-o', input.output];
    if (input.optimize !== undefined) args.push('--optimize', String(input.optimize));
    if (input.revision) args.push('--revision', input.revision);
    if (input.target) args.push('--target', input.target);
    for (const ep of input.entrypoints ?? []) args.push('--entrypoint', ep);
    if (input.signingKey) args.push('--signing-key', input.signingKey);
    if (input.signingAlg) args.push('--signing-alg', input.signingAlg);
    if (input.claimsFile) args.push('--claims-file', input.claimsFile);
    if (input.capabilities) args.push('--capabilities', input.capabilities);
    if (input.bundle) args.push('--bundle');
    if (input.pruneUnused) args.push('--prune-unused');
    if (input.v1Compatible) args.push('--v1-compatible');
    for (const pat of input.ignore ?? []) args.push('--ignore', pat);
    if (input.verificationKey) args.push('--verification-key', input.verificationKey);
    if (input.verificationKeyId) args.push('--verification-key-id', input.verificationKeyId);
    args.push(...input.paths);
    return this.run(args, undefined, signal);
  }

  /**
   * Sign a bundle. Writes a `.signatures.json` next to the bundle
   * directory.
   */
  async sign(input: SignInput, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['sign', '--signing-key', input.signingKey];
    if (input.signingAlg) args.push('--signing-alg', input.signingAlg);
    if (input.claimsFile) args.push('--claims-file', input.claimsFile);
    args.push('--bundle', input.bundle);
    return this.run(args, undefined, signal);
  }

  /**
   * Verify a signed bundle using `opa eval --bundle --verification-key`.
   * OPA verifies the bundle signature before loading any policies; a
   * failed signature produces a non-zero exit and the error message on
   * stderr. The trivial query `true` is used so the process exits
   * immediately after verification without entering a REPL.
   */
  async bundleVerify(input: BundleVerifyInput, signal?: AbortSignal): Promise<SpawnResult> {
    const args = ['eval', '--bundle', input.bundle, '--verification-key', input.verificationKey];
    if (input.verificationKeyId) args.push('--verification-key-id', input.verificationKeyId);
    if (input.signingAlg) args.push('--signing-alg', input.signingAlg);
    if (input.scope) args.push('--scope', input.scope);
    args.push('true');
    return this.run(args, undefined, signal);
  }

  /**
   * Batch-evaluate a policy decision against one or more input files using
   * `opa exec`. Each input file is evaluated independently; results are
   * returned as a JSON array with one entry per file.
   */
  async exec(input: ExecInput, signal?: AbortSignal): Promise<SpawnResult> {
    if (input.inputPaths.length === 0) {
      throw new Error('opa exec requires at least one input path');
    }
    const args = ['exec', '--format=json', '--decision', input.decision];
    if (input.bundle) args.push('--bundle', input.bundle);
    for (const p of input.dataPaths ?? []) args.push('--data', p);
    args.push(...input.inputPaths);
    return this.run(args, undefined, signal);
  }

  // ─── Low-level escape hatch ──────────────────────────────────────────

  /**
   * Run `opa` with the given argv and optional stdin. Tools should
   * prefer the typed methods above, but this exists for the rare cases
   * the typed surface does not yet cover.
   */
  async run(args: string[], stdin?: string, signal?: AbortSignal): Promise<SpawnResult> {
    const opts: Parameters<typeof runBinary>[1] = {
      args,
      timeoutMs: this.config.subprocessTimeoutMs,
    };
    if (stdin !== undefined) opts.stdin = stdin;
    if (signal !== undefined) opts.signal = signal;
    return runBinary(this.config.opaBinary, opts);
  }

  // ─── Internal: temp file management ──────────────────────────────────

  /**
   * Write `source` to a private temp directory (mode 0700) created with
   * mkdtemp. The directory and its contents are removed on completion.
   * mkdtemp is safe: the directory is created atomically (O_CREAT|O_EXCL)
   * so no other process can predict or race for the path.
   */
  private async withTempSource<T>(source: string, fn: (path: string) => Promise<T>): Promise<T> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'orygn-opa-mcp-'));
    const filePath = join(tmpDir, 'input.rego');
    await writeFile(filePath, source, 'utf8');
    try {
      return await fn(filePath);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}
