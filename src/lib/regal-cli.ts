/**
 * Wrapper around the optional `regal` binary (Rego linter, by Styra).
 *
 * Regal is OPTIONAL -- only the `rego_lint` tool requires it. Other
 * tools work without Regal installed. If absent, `rego_lint` returns a
 * structured `REGAL_NOT_FOUND` error with an install hint.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../config.js';
import { runBinary, type SpawnResult } from './subprocess.js';

/**
 * Rules whose verdict depends on the on-disk path of the file being
 * linted. When a caller passes inline `source`, the file lives at a
 * randomized temp path that can never match the source's declared
 * package, so these rules always fire as false positives. Auto-disabled
 * for inline source unless the caller explicitly re-enables them.
 */
export const INLINE_SOURCE_FALSE_POSITIVE_RULES = ['directory-package-mismatch'] as const;

/** Input for `regal fix`. */
export interface FixInput {
  /** Policy files or directories to fix. */
  paths: string[];
  /** Preview changes without writing them. Use with the tool to check before committing. */
  dryRun?: boolean;
  /**
   * Allow fixing files that have uncommitted git changes, or when the
   * directory is not a git repository. Without this flag regal refuses
   * to modify uncommitted files.
   */
  force?: boolean;
  /** Path to a Regal config file. */
  configFile?: string;
  /** Disable specific named rules. */
  disable?: string[];
  /** Enable specific named rules. */
  enable?: string[];
  /** Disable entire rule categories. */
  disableCategory?: string[];
  /** Enable entire rule categories. */
  enableCategory?: string[];
  /** Glob patterns to skip. */
  ignoreFiles?: string[];
}

/** Input for `regal lint`. */
export interface LintInput {
  /** Inline Rego source. Mutually exclusive with `paths`. */
  source?: string;
  /** Paths to Rego files or directories to lint. */
  paths?: string[];
  /** Path to a Regal config file. */
  configFile?: string;
  /** Disable specific named rules (e.g. `print-or-trace-call`). */
  disable?: string[];
  /** Disable entire rule categories (e.g. `style`, `idiomatic`). */
  disableCategory?: string[];
  /** Enable specific named rules. */
  enable?: string[];
  /** Enable entire rule categories. */
  enableCategory?: string[];
  /** Disable every rule before applying enable* flags. */
  disableAll?: boolean;
  /** Enable every rule (overrides config defaults). */
  enableAll?: boolean;
  /** Glob patterns to skip. */
  ignoreFiles?: string[];
  /**
   * Severity at which Regal returns a non-zero exit code (`error` or
   * `warning`). Defaults to `error` to match Regal's own default.
   */
  failLevel?: 'error' | 'warning';
}

/**
 * Wrapper around the local `regal` binary.
 *
 * Like `OpaCli`, methods do not throw on Regal-side errors -- the exit
 * code on the returned `SpawnResult` is the signal. Inline source is
 * always written to a temp file because `regal lint` does not read
 * from stdin.
 */
export class RegalCli {
  constructor(private readonly config: Config) {}

  /**
   * Verify the binary is present and report its version. Returns null
   * if the binary is unreachable or output is malformed.
   */
  async version(signal?: AbortSignal): Promise<string | null> {
    const result = await this.run(['version'], signal);
    if (result.exitCode !== 0) return null;
    const match =
      /Version:\s*(\S+)/i.exec(result.stdout) ?? /v?(\d+\.\d+\.\d+\S*)/i.exec(result.stdout);
    return match?.[1] ?? null;
  }

  /**
   * Lint Rego source. Stdout is JSON when `--format=json` is set
   * (always, here). Either `source` or one or more `paths` must be
   * provided.
   *
   * Regal's exit codes:
   * - 0 -- no findings at or above `failLevel`
   * - 3 -- findings present
   * - non-zero other -- Regal-internal failure (config error, etc.)
   *
   * When called with inline `source`, location-bound rules whose
   * verdict depends on the on-disk path (currently
   * `directory-package-mismatch`) are auto-disabled because the
   * randomized temp-file path makes those rules false positives.
   * Callers that want them anyway can re-enable via `enable`.
   */
  async lint(input: LintInput, signal?: AbortSignal): Promise<SpawnResult> {
    if (!input.source && !input.paths?.length) {
      throw new Error('regal lint requires either source or at least one path');
    }
    const args = ['lint', '--format=json', '--no-color'];
    if (input.configFile) args.push('--config-file', input.configFile);
    if (input.failLevel) args.push('--fail-level', input.failLevel);
    if (input.disableAll) args.push('--disable-all');
    if (input.enableAll) args.push('--enable-all');

    const userEnable = new Set(input.enable ?? []);
    const userDisable = new Set(input.disable ?? []);
    const effectiveDisable = new Set(userDisable);
    if (input.source !== undefined) {
      for (const rule of INLINE_SOURCE_FALSE_POSITIVE_RULES) {
        if (!userEnable.has(rule)) effectiveDisable.add(rule);
      }
    }

    for (const rule of effectiveDisable) args.push('--disable', rule);
    for (const rule of userEnable) args.push('--enable', rule);
    for (const cat of input.disableCategory ?? []) args.push('--disable-category', cat);
    for (const cat of input.enableCategory ?? []) args.push('--enable-category', cat);
    for (const pattern of input.ignoreFiles ?? []) args.push('--ignore-files', pattern);

    if (input.source !== undefined) {
      return this.withTempSource(input.source, (path) => this.run([...args, path], signal));
    }
    args.push(...(input.paths ?? []));
    return this.run(args, signal);
  }

  /**
   * Auto-fix Rego violations for rules that support mechanical fixes.
   * In regal 0.30.0 the fixable rules are: opa-fmt, use-rego-v1,
   * use-assignment-operator, no-whitespace-comment, and
   * directory-package-mismatch. Modifies files in place unless
   * `dryRun` is set. Always passes `--no-color` to keep output parseable.
   */
  async fix(input: FixInput, signal?: AbortSignal): Promise<SpawnResult> {
    if (input.paths.length === 0) {
      throw new Error('regal fix requires at least one path');
    }
    const args = ['fix', '--no-color'];
    if (input.dryRun) args.push('--dry-run');
    if (input.force) args.push('--force');
    if (input.configFile) args.push('--config-file', input.configFile);
    for (const rule of input.disable ?? []) args.push('--disable', rule);
    for (const rule of input.enable ?? []) args.push('--enable', rule);
    for (const cat of input.disableCategory ?? []) args.push('--disable-category', cat);
    for (const cat of input.enableCategory ?? []) args.push('--enable-category', cat);
    for (const pattern of input.ignoreFiles ?? []) args.push('--ignore-files', pattern);
    args.push(...input.paths);
    return this.run(args, signal);
  }

  /**
   * Run `regal` with the given argv. Tools should prefer the typed
   * methods above; this is the escape hatch.
   */
  async run(args: string[], signal?: AbortSignal): Promise<SpawnResult> {
    const opts: Parameters<typeof runBinary>[1] = {
      args,
      timeoutMs: this.config.subprocessTimeoutMs,
    };
    if (signal !== undefined) opts.signal = signal;
    return runBinary(this.config.regalBinary, opts);
  }

  // ─── Internal: temp file management ──────────────────────────────────

  // mkdtemp creates the directory atomically (O_CREAT|O_EXCL) with mode
  // 0700 -- no other process can read or predict the temp file path.
  private async withTempSource<T>(source: string, fn: (path: string) => Promise<T>): Promise<T> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'orygn-regal-mcp-'));
    const filePath = join(tmpDir, 'input.rego');
    await writeFile(filePath, source, 'utf8');
    try {
      return await fn(filePath);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}
