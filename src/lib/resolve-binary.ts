/**
 * Resolves which `opa` binary the server should spawn.
 *
 * The server ships the OPA binary as platform-specific optional
 * dependencies (`@orygn/opa-mcp-<platform>-<arch>`), following the same
 * model esbuild and @swc use. npm installs only the package matching the
 * host's `os`/`cpu`, so the right binary lands in `node_modules` with no
 * postinstall download.
 *
 * Resolution order, highest priority first:
 *   1. An explicit `OPA_BINARY` (anything other than the bare default
 *      `'opa'`) is returned verbatim. The operator's choice always wins.
 *   2. `opa` already on PATH is used as-is, preserving the exact behavior
 *      of every install that predates bundling. No version is swapped out
 *      from under an existing user.
 *   3. The bundled optional-dependency binary, if installed.
 *   4. Falls back to the literal `'opa'`, so a missing binary surfaces the
 *      same `OPA_BINARY_NOT_FOUND` install hint as before.
 *
 * This function never throws: every filesystem and module-resolution
 * failure degrades to returning `'opa'`.
 *
 * Note on the PATH scan (step 2): it mirrors how the OS resolves a bare
 * command name, but is not guaranteed bit-identical to the platform's
 * loader in every edge case. While no platform packages are published it
 * is moot -- `bundledOpaPath()` returns undefined, so the resolver can
 * only ever return `'opa'`. Scan fidelity becomes load-bearing once the
 * platform packages ship, and is validated by the cross-platform CI
 * matrix before that point.
 */
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);

/** Optional-dependency package name keyed by `${platform}-${arch}`. */
const PLATFORM_PACKAGES: Record<string, string> = {
  'linux-x64': '@orygn/opa-mcp-linux-x64',
  'linux-arm64': '@orygn/opa-mcp-linux-arm64',
  'darwin-x64': '@orygn/opa-mcp-darwin-x64',
  'darwin-arm64': '@orygn/opa-mcp-darwin-arm64',
  'win32-x64': '@orygn/opa-mcp-win32-x64',
};

/**
 * The bundled package name for a platform/arch pair, or `undefined` when
 * that combination is not shipped (e.g. 32-bit, freebsd).
 */
export function platformPackageName(platform: string, arch: string): string | undefined {
  return PLATFORM_PACKAGES[`${platform}-${arch}`];
}

/**
 * True when `bin` resolves to a file on PATH. Inputs are injectable so the
 * scan can be exercised deterministically across platforms in tests.
 *
 * On win32 each PATHEXT extension is tried (matching the OS), and
 * surrounding double quotes are stripped from PATH entries (Windows
 * permits quoted directories, which the loader unquotes but a naive split
 * would not).
 */
export function binOnPath(
  bin: string,
  opts: { platform?: string; pathEnv?: string; pathExt?: string } = {},
): boolean {
  const platform = opts.platform ?? process.platform;
  const pathEnv = opts.pathEnv ?? process.env['PATH'] ?? '';
  const exts =
    platform === 'win32'
      ? (opts.pathExt ?? process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT')
          .split(';')
          .map((e) => e.toLowerCase())
      : [''];

  for (const rawDir of pathEnv.split(delimiter)) {
    const dir = rawDir.replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, bin + ext))) return true;
    }
  }
  return false;
}

/**
 * Absolute path to the bundled `opa` binary for the given platform/arch,
 * or `undefined` when the optional dependency is not installed, the
 * platform is unsupported, or the file is missing.
 *
 * On non-Windows platforms the file is checked for the execute bit and
 * `chmod`ed to 0o755 if a package manager dropped it (npm preserves the
 * bit, but pnpm/Yarn occasionally do not). The chmod is best-effort: if it
 * fails the path is still returned so the spawn produces a clear error.
 */
export function bundledOpaPath(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const pkg = platformPackageName(platform, arch);
  if (!pkg) return undefined;

  const binName = platform === 'win32' ? 'opa.exe' : 'opa';
  let file: string;
  try {
    file = join(dirname(nodeRequire.resolve(`${pkg}/package.json`)), binName);
  } catch {
    return undefined; // optional dependency not installed
  }
  if (!existsSync(file)) return undefined;

  if (platform !== 'win32') {
    try {
      accessSync(file, constants.X_OK);
    } catch {
      try {
        chmodSync(file, 0o755);
      } catch {
        /* best effort; an unusable binary will surface OPA_BINARY_NOT_FOUND on spawn */
      }
    }
  }
  return file;
}

/** Injectable probes for {@link resolveOpaBinary}, for deterministic tests. */
export interface ResolveBinaryDeps {
  onPath?: (bin: string) => boolean;
  bundled?: () => string | undefined;
}

/**
 * Decide which `opa` binary to spawn. See the module header for the full
 * resolution order. `configured` is the value from `OPA_BINARY` (or the
 * `'opa'` default). Never throws.
 */
export function resolveOpaBinary(configured: string, deps: ResolveBinaryDeps = {}): string {
  if (configured !== 'opa') return configured;

  const onPath = deps.onPath ?? ((b: string): boolean => binOnPath(b));
  if (onPath('opa')) return 'opa';

  const bundled = deps.bundled ?? ((): string | undefined => bundledOpaPath());
  return bundled() ?? 'opa';
}
