/**
 * Usage stats: whether they are on, and what this install counts while it
 * runs, for the daily report (usage-report.ts sends it).
 *
 * Nothing counted here comes from a policy, an input, a file or a message. A
 * tool call is counted under the tool's own name, a failure under the error
 * code the server returned, an unexpected error under the place in the
 * server's own code where it was thrown. Counts are kept per UTC day in one
 * small file per process, which the report adds up once the day is over.
 * docs/privacy.md lists every field.
 */
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Env = Record<string, string | undefined>;

export type UsageMode = 'on' | 'off' | 'log';

export interface UsageSwitch {
  mode: UsageMode;
  /** Why it is off, for mcp_server_info: which setting or circumstance. */
  why?: string;
}

const ON_WORDS = ['on', 'true', '1', 'yes'];

/** Set by CI systems. A test run is never real use. */
export const CI_VARIABLES = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TF_BUILD',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'BITBUCKET_BUILD_NUMBER',
  'CODEBUILD_BUILD_ID',
];

/** The folder holding dist/, and package.json beside it. */
export const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DIST_ROOT = join(PACKAGE_ROOT, 'dist');

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/**
 * How this copy says it was packaged: the Docker image, the Claude Desktop
 * bundle and the Claude plugin set OPA_MCP_PACKAGING. Anything else is not
 * trusted.
 */
export function packagedAs(env: Env = process.env): 'docker' | 'mcpb' | 'plugin' | undefined {
  const v = env['OPA_MCP_PACKAGING']?.trim().toLowerCase();
  return v === 'docker' || v === 'mcpb' || v === 'plugin' ? v : undefined;
}

/** An npm install of the package, as opposed to a clone of the repository. */
export function isInstalled(root: string = PACKAGE_ROOT): boolean {
  return /[\\/]node_modules[\\/]/.test(root + sep);
}

/**
 * Whether usage stats are sent, and if not, why. OPA_MCP_TELEMETRY=log
 * writes the report to the log instead of sending it, whatever else is set.
 * DO_NOT_TRACK, OPA_MCP_NO_TELEMETRY and CI turn it off. OPA_MCP_TELEMETRY
 * set to anything but on (off, false, disabled, ...) turns it off, so a word
 * meant as off never leaves it on. A source checkout is development, so it
 * sends nothing unless told to.
 */
export function usageSwitch(
  env: Env = process.env,
  installed: boolean = isInstalled() || packagedAs(env) !== undefined,
): UsageSwitch {
  const value = env['OPA_MCP_TELEMETRY']?.trim();
  if (value?.toLowerCase() === 'log') return { mode: 'log' };
  if (truthy(env['DO_NOT_TRACK'])) return { mode: 'off', why: 'DO_NOT_TRACK is set' };
  if (truthy(env['OPA_MCP_NO_TELEMETRY'])) {
    return { mode: 'off', why: 'OPA_MCP_NO_TELEMETRY is set' };
  }
  if (CI_VARIABLES.some((name) => truthy(env[name]))) return { mode: 'off', why: 'running in CI' };
  // The Claude Desktop bundle sets OPA_MCP_TELEMETRY from its Usage stats
  // checkbox, as "true" or "false". There only an explicit on counts, so a
  // setting the app failed to fill in leaves it off. The Claude plugin has no
  // settings of its own (Claude Desktop drops a plugin server that uses them),
  // so it reads the environment like any other install.
  if (packagedAs(env) === 'mcpb') {
    return value !== undefined && ON_WORDS.includes(value.toLowerCase())
      ? { mode: 'on' }
      : { mode: 'off', why: "turned off in the extension's settings" };
  }
  if (value !== undefined && value !== '') {
    if (ON_WORDS.includes(value.toLowerCase())) return { mode: 'on' };
    return { mode: 'off', why: `OPA_MCP_TELEMETRY=${value.slice(0, 20)}` };
  }
  if (!installed) return { mode: 'off', why: 'running from a source checkout' };
  return { mode: 'on' };
}

/** One line for mcp_server_info, either way. */
export function usageLine(sw: UsageSwitch, env: Env = process.env): string {
  if (sw.mode === 'log') {
    return 'Usage stats: written to the log once a day and never sent (OPA_MCP_TELEMETRY=log).';
  }
  if (sw.mode === 'off') return `Usage stats: off (${sw.why ?? 'turned off'}).`;
  const packaged = packagedAs(env);
  if (packaged === 'mcpb') {
    return "Usage stats: on. To turn them off, untick Usage stats in this extension's settings.";
  }
  if (packaged === 'plugin') {
    return "Usage stats: on. To turn them off, set OPA_MCP_TELEMETRY=off in the environment Claude runs with, for example in the env block of Claude Code's settings.json.";
  }
  return 'Usage stats: on. To turn them off, set OPA_MCP_TELEMETRY=off.';
}

// --- the AI app ---

/**
 * The AI app, from the name it gives when it connects, as one of a fixed
 * list. Order matters: Claude Code before Claude, and so on. Claude Desktop
 * connects to an extension as "local-agent-mode-<the server's name>", so
 * that prefix comes first.
 */
const APPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^local-agent-mode-|^custom3p-/i, 'claude-desktop'],
  [/inspector/i, 'inspector'],
  [/claude[-_ ]?code/i, 'claude-code'],
  [/claude/i, 'claude-desktop'],
  [/cursor/i, 'cursor'],
  [/visual studio code|vscode|vs code/i, 'vscode'],
  [/windsurf|codeium/i, 'windsurf'],
  [/roo[-_ ]?code/i, 'roo-code'],
  [/^roo\b/i, 'roo-code'],
  [/cline/i, 'cline'],
  [/codex/i, 'codex'],
  [/^zed/i, 'zed'],
  [/goose/i, 'goose'],
  [/continue/i, 'continue'],
  [/lm[-_ ]?studio/i, 'lm-studio'],
  [/gemini/i, 'gemini-cli'],
  [/kiro/i, 'kiro'],
  [/chatgpt|openai/i, 'chatgpt'],
  [/jetbrains|intellij|pycharm|webstorm|goland/i, 'jetbrains'],
  [/opencode/i, 'opencode'],
  [/warp/i, 'warp'],
  [/librechat/i, 'librechat'],
];

/** Every name appName can give. */
export const APP_NAMES: readonly string[] = [
  ...new Set(APPS.map(([, name]) => name)),
  'other',
  'unknown',
];

export function appName(clientName: string | undefined): string {
  if (!clientName || !clientName.trim()) return 'unknown';
  for (const [pattern, name] of APPS) if (pattern.test(clientName)) return name;
  return 'other';
}

// --- where an unexpected error came from ---

/**
 * Put on a tool result (never serialised) by the code that turned an
 * unexpected exception into UNKNOWN_ERROR, saying where it was thrown. The
 * SDK sends a validated copy of the result, without it, so the tool wrapper
 * moves it to `crashSites` under the request's id for the observer.
 */
export const CRASH_SITE: unique symbol = Symbol('opa-mcp.crash-site');

const crashSites = new Map<string | number, string>();

export function recordCrashSite(requestId: string | number, site: string): void {
  if (!counting) return;
  // Only crashes land here, and each is taken when its result goes out; a
  // result that never goes out (a cancelled call) cannot pile them up.
  if (crashSites.size >= 64) crashSites.delete(crashSites.keys().next().value!);
  crashSites.set(requestId, site);
}

export function takeCrashSite(requestId: string | number): string | undefined {
  const site = crashSites.get(requestId);
  crashSites.delete(requestId);
  return site;
}

const SITE_RE = /^[A-Z][A-Za-z]{0,39}@[a-z0-9][a-z0-9/_.-]{0,99}\.js:\d{1,6}$/;

/**
 * The error's type and the innermost line of the server's own code on its
 * stack, as `TypeError@lib/opa-cli.js:212`. Never the message, which can
 * hold a path, a policy, or a value. `external` when no frame is in the
 * server's code, `unknown` when there is no stack to read.
 */
export function crashSite(e: unknown, distRoot: string = DIST_ROOT): string {
  if (!(e instanceof Error) || typeof e.stack !== 'string') return 'unknown';
  const name = /^[A-Z][A-Za-z]{0,39}$/.test(e.name) ? e.name : 'Error';
  for (const line of e.stack.split('\n').slice(1)) {
    const m = /^\s*at (?:.*?\()?(.+?):(\d+):\d+\)?\s*$/.exec(line);
    if (!m) continue;
    let file = m[1]!;
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (!isAbsolute(file)) continue;
    const rel = relative(distRoot, file);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    const site = `${name}@${rel.split(sep).join('/')}:${m[2]!}`;
    return SITE_RE.test(site) ? site : 'unknown';
  }
  return 'external';
}

// --- the running tally ---

export interface DayTally {
  /** Calls per tool. */
  tools: Record<string, number>;
  /** Failed calls per `tool|CODE`. */
  failures: Record<string, number>;
  /** Unexpected errors per `tool|site`. */
  crashes: Record<string, number>;
  /** AI apps that called a tool that day. */
  apps: string[];
}

export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

interface Running {
  day: string;
  tally: DayTally;
  dirty: boolean;
  file: string;
}

let running: Running | undefined;
let counting = false;
let currentApp = 'unknown';
let onCall: (() => void) | undefined;
let exitHooked = false;
// Where this process writes its counts, fixed when counting starts.
let countDir = '';
let dirOverride: string | undefined;
let resolvedDir: string | undefined;
let dirResolved = false;
const fileTag = `${process.pid}-${randomBytes(3).toString('hex')}`;

/**
 * A folder of this user's own in the system's temp folder, for when the home
 * folder cannot be written. On a machine with other users the temp folder is
 * shared, and files written in a folder someone else made could follow links
 * they planted, so it is made private and refused if it is a link, belongs to
 * someone else, or others can reach it.
 */
export function privateTempDir(base: string = tmpdir()): string | undefined {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const dir = join(base, uid === undefined ? 'opa-mcp-usage-stats' : `opa-mcp-usage-stats-${uid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory()) return undefined;
    if (uid !== undefined && (st.uid !== uid || (st.mode & 0o077) !== 0)) return undefined;
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * Where the counts and the report's state live, beside the rest of opa-mcp's
 * files in the home folder. Where that cannot be written (a container run as
 * a user with no home), a private folder in the system's temp folder, and
 * when there is none of those either, nowhere: nothing is counted.
 */
export function usageDir(): string | undefined {
  if (dirOverride) return dirOverride;
  if (dirResolved) return resolvedDir;
  const primary = join(homedir(), '.orygn', 'opa-mcp', 'usage-stats');
  try {
    mkdirSync(primary, { recursive: true });
    accessSync(primary, constants.W_OK);
    resolvedDir = primary;
  } catch {
    resolvedDir = privateTempDir();
  }
  dirResolved = true;
  return resolvedDir;
}

function emptyTally(): DayTally {
  return { tools: {}, failures: {}, crashes: {}, apps: [] };
}

function today(): Running {
  const day = utcDay();
  if (!running || running.day !== day) {
    // The day turned: what is left of the old one is written before moving on.
    if (running?.dirty) flush();
    running = {
      day,
      tally: emptyTally(),
      dirty: false,
      file: join(countDir, `day-${day}-${fileTag}.json`),
    };
  }
  return running;
}

/**
 * Writes this process's count for the day, whole, under a temporary name
 * renamed into place, so the report never reads half a file.
 */
export function flush(): void {
  if (!running || !running.dirty) return;
  try {
    mkdirSync(dirname(running.file), { recursive: true });
    const temp = `${running.file}.tmp`;
    writeFileSync(temp, JSON.stringify(running.tally));
    renameSync(temp, running.file);
    running.dirty = false;
  } catch {
    // A folder that cannot be written just means nothing is counted.
  }
}

/**
 * Turns counting on for this process. `onToolCall` runs after every counted
 * call, once the result is on its way.
 */
export function startCounting(opts: { onToolCall: () => void }): void {
  const dir = usageDir();
  if (dir === undefined) return;
  countDir = dir;
  counting = true;
  onCall = opts.onToolCall;
  pruneOldFiles();
  // Written after every call anyway: an app closing the server kills it
  // outright, and on Windows nothing runs at exit.
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', flush);
  }
}

export function countingEnabled(): boolean {
  return counting;
}

export function noteClient(clientName: string | undefined): void {
  const name = appName(clientName);
  if (name !== 'unknown') currentApp = name;
}

export function currentAppName(): string {
  return currentApp;
}

/**
 * One tool call and how it ended: no code for a result that was not an
 * error, otherwise its error code, and for an unexpected error where it was
 * thrown.
 */
export function noteToolCall(tool: string, outcome: { code?: string; site?: string } = {}): void {
  if (!counting) return;
  const r = today();
  const t = r.tally;
  t.tools[tool] = (t.tools[tool] ?? 0) + 1;
  if (!t.apps.includes(currentApp)) t.apps.push(currentApp);
  if (outcome.code !== undefined) {
    const key = `${tool}|${outcome.code}`;
    t.failures[key] = (t.failures[key] ?? 0) + 1;
  }
  if (outcome.site !== undefined) {
    const key = `${tool}|${outcome.site}`;
    t.crashes[key] = (t.crashes[key] ?? 0) + 1;
  }
  r.dirty = true;
  flush();
  if (onCall) setImmediate(onCall);
}

/** Day files from more than a week ago are never sent; they go. */
const KEEP_DAYS = 8;

function pruneOldFiles(): void {
  try {
    const dir = countDir;
    if (!existsSync(dir)) return;
    const cutoff = utcDay(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const name of readdirSync(dir)) {
      const m = /^day-(\d{4}-\d{2}-\d{2})-/.exec(name);
      if (m && m[1]! < cutoff) rmSync(join(dir, name), { force: true });
      // A temporary file left by a process that died mid-write.
      if (name.endsWith('.tmp') && Date.now() - statSync(join(dir, name)).mtimeMs > 3_600_000) {
        rmSync(join(dir, name), { force: true });
      }
    }
  } catch {
    // Nothing to prune is fine.
  }
}

/** For tests: the state of this process's counting, and a way to reset it. */
export const __testing = {
  reset(dir?: string): void {
    dirOverride = dir;
    resolvedDir = undefined;
    dirResolved = false;
    countDir = '';
    running = undefined;
    counting = false;
    currentApp = 'unknown';
    onCall = undefined;
    crashSites.clear();
  },
  running: (): Running | undefined => running,
  fileTag,
};
