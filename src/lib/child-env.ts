/**
 * Builds the environment handed to `opa`, `regal` and `conftest`.
 *
 * Rego can read its interpreter's environment: `opa.runtime().env` returns the
 * whole thing. So every variable this server passes down is readable by any
 * policy it evaluates, and `rego_eval` takes inline source -- no filesystem
 * access, so `OPA_MCP_ALLOWED_PATHS` never applies. Untrusted Rego reaches an
 * agent through a README, an issue, or a pull request diff, which makes a
 * pass-through of `process.env` a prompt injection away from handing over
 * `OPA_TOKEN`, the `GITHUB_TOKEN` this project's own README asks users to put in
 * their client config, and whatever else the operator's shell happens to hold.
 *
 * So the child gets an explicit allow-list instead. It holds no cloud or
 * repository token, which is what motivated the list, but it is not free of
 * credentials: a proxy URL can embed one, and `HTTP_PROXY` and its siblings are
 * on the list because dropping them breaks every user behind a corporate proxy.
 * An operator who would rather lose proxy support than expose those credentials
 * to evaluated policy can name them in `OPA_MCP_BLOCK_ENV`.
 *
 * Measured against the bundled OPA 1.19.0, `version`, `eval`, `check`, `test`
 * and `build` all succeed with a completely empty environment, so the entries
 * below exist for correctness in real-world setups (proxies, custom CA bundles,
 * tool config discovery), not to make the binaries run.
 *
 * Operators who genuinely need a variable in policy can name it in
 * `OPA_MCP_PASSTHROUGH_ENV`, which is opt-in precisely because it undoes this.
 */

/** Vars every platform benefits from. Locale keeps output formatting stable. */
const COMMON = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_NUMERIC', 'TZ'];

/** POSIX home and temp. Regal and Conftest look under HOME for config. */
const POSIX = ['HOME', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME'];

/**
 * Windows equivalents. A Go binary starts without these, but process creation
 * and temp-file handling are better behaved with them present.
 */
const WINDOWS = [
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
];

/**
 * Proxy and TLS trust. Without these, `http.send`, bundle downloads and remote
 * schema fetches fail behind a corporate proxy or a custom CA.
 *
 * A proxy URL can embed credentials, so these are the least inert entries here.
 * They are included because breaking every corporate user is the worse trade,
 * and they are the operator's own infrastructure credentials rather than the
 * cloud and repository tokens that motivated this module.
 */
const NETWORK = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/**
 * Where the tools look for their own config and credentials. These name file
 * locations; they are not themselves secrets. Conftest reads registry auth from
 * the Docker config file, so `conftest_pull` and `conftest_push` need these.
 */
const TOOL_CONFIG = [
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'DOCKER_CONFIG',
  'REGISTRY_AUTH_FILE',
];

const ALLOWED: readonly string[] = [...COMMON, ...POSIX, ...WINDOWS, ...NETWORK, ...TOOL_CONFIG];

/** Split a comma or semicolon separated list of variable names. */
function nameList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Names an operator opted into via OPA_MCP_PASSTHROUGH_ENV. */
function passthroughNames(source: NodeJS.ProcessEnv): string[] {
  return nameList(source['OPA_MCP_PASSTHROUGH_ENV']);
}

/**
 * Names an operator withheld via OPA_MCP_BLOCK_ENV.
 *
 * Applied last, so it overrides the allow-list, the passthrough list and the
 * caller's own `extra`. The point is to be able to say no to something this
 * module would otherwise hand down, and a rule that could be overridden by the
 * thing it is meant to restrain would not be worth having.
 */
function blockedNames(source: NodeJS.ProcessEnv): string[] {
  return nameList(source['OPA_MCP_BLOCK_ENV']);
}

/**
 * Windows treats variable names case-insensitively, and the casing in
 * `process.env` follows whatever the parent used, so an exact-key lookup would
 * silently miss `Path` where the list says `PATH`.
 */
function lookup(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = source[name];
  if (direct !== undefined) return direct;
  if (process.platform !== 'win32') return undefined;

  const wanted = name.toLowerCase();
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === wanted) return source[key];
  }
  return undefined;
}

/**
 * Windows-only identity variables that libuv copies from the parent no matter
 * what environment is requested -- spawning with `{}` still delivers them, and
 * measurably so. They are not secrets, but they name the operating-system user,
 * the Windows domain and the domain controller, which is more than an untrusted
 * policy needs to know about the machine evaluating it.
 *
 * They cannot be removed, only overwritten, so they are blanked. None of the
 * three binaries reads them: every representative `opa` command succeeds with a
 * completely empty environment on both platforms.
 */
const WINDOWS_IDENTITY_TO_BLANK = ['USERNAME', 'USERDOMAIN', 'LOGONSERVER'];

/**
 * Build the child environment: the allow-list, plus any opted-in passthrough,
 * plus `extra` from the caller (which wins, since it is explicit intent).
 *
 * @param extra   Variables the calling command needs. Readable by evaluated
 *                policy like everything else here, so pass secrets only when the
 *                command actually requires them. `OPA_MCP_BLOCK_ENV` removes a
 *                name even when it appears here.
 * @param source  Environment to read from. Injectable for testing.
 */
export function buildChildEnv(
  extra?: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  if (process.platform === 'win32') {
    for (const name of WINDOWS_IDENTITY_TO_BLANK) env[name] = '';
  }

  for (const name of [...ALLOWED, ...passthroughNames(source)]) {
    const value = lookup(source, name);
    if (value !== undefined) env[name] = value;
  }

  const result = extra ? { ...env, ...extra } : env;

  for (const name of blockedNames(source)) {
    delete result[name];
    if (process.platform === 'win32') {
      const wanted = name.toLowerCase();
      for (const key of Object.keys(result)) {
        if (key.toLowerCase() === wanted) delete result[key];
      }
    }
  }

  return result;
}

/** Exposed for tests and for documenting the surface. */
export const ALLOWED_CHILD_ENV_VARS: readonly string[] = ALLOWED;
