/**
 * The daily usage report. At most once per UTC day per install (the home
 * folder's usage-stats directory is the install), after the day's first tool
 * call, it sends what the install looks like and the counts of the days
 * before, then stays quiet until the next day. docs/privacy.md lists the
 * fields; every value is a number band, a version, or one of a fixed list.
 *
 * Several copies of the server can share one install (an app per window, two
 * AI apps), so one lock file decides which of them sends, and the state file
 * says a day was sent only once the receiver answered. A day's report
 * carries a random number, reused if it has to be sent again; the receiver
 * counts each number once and forgets it after three days, so a retry never
 * counts twice and nothing links one day's report to another's.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../config.js';
import { SERVER_VERSION } from '../constants.js';
import { allowedRoots } from './client-roots.js';
import { logger } from './logger.js';
import {
  PACKAGE_ROOT,
  currentAppName,
  flush,
  isInstalled,
  packagedAs,
  startCounting,
  usageDir,
  usageSwitch,
  utcDay,
  type DayTally,
  type UsageSwitch,
} from './usage-stats.js';

export const REPORT_BASE = 'https://telemetry.orygn.tech';
export const REPORT_PATH = '/opa-mcp/v1/report';
export const SCHEMA = 1;
const SEND_TIMEOUT_MS = 3_000;
const LOCK_STALE_MS = 60_000;
// A day's counts wait this long after a process last wrote them, so one
// still finishing its write at midnight is not sent half done.
const SETTLE_MS = 60_000;
const MAX_DAYS = 7;
// How long a report waits for the startup check to say which opa, regal and
// conftest it found.
const BINARIES_WAIT_MS = 10_000;
// The receiver takes reports up to 64 KB. Seven days of every tool failing
// in every way comes near that, so the oldest days are left out until the
// report fits.
export const MAX_REPORT_BYTES = 60_000;

type Env = Record<string, string | undefined>;

interface State {
  first_seen?: string;
  active: string[];
  sent_day?: string;
  nonce?: { day: string; value: string };
  failures?: number;
  next_try_at?: string;
}

export interface ReportDay {
  d: string;
  tools: Record<string, string>;
  failures: Record<string, string>;
  crashes: Record<string, string>;
  apps: string[];
}

export interface Report {
  s: number;
  day: string;
  nonce: string;
  v: string;
  os: string;
  arch: string;
  node: string;
  app: string;
  install: string;
  ctx: string;
  opa: string;
  opa_v: string;
  regal: string;
  conftest: string;
  files: string;
  settings: string[];
  age: string;
  first: { week: boolean; month: boolean; ever: boolean };
  days: ReportDay[];
}

// --- bands ---

export function countBand(n: number): string {
  return n >= 100 ? '100+' : n >= 10 ? '10-99' : '1-9';
}

export function ageBand(days: number): string {
  return days <= 0 ? '0' : days <= 7 ? '1-7' : days <= 30 ? '8-30' : days <= 90 ? '31-90' : '90+';
}

// --- where and how it runs ---

export function osName(platform: string = process.platform): string {
  return platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
      ? 'macos'
      : platform === 'linux'
        ? 'linux'
        : 'other';
}

export function archName(arch: string = process.arch): string {
  return arch === 'x64' || arch === 'arm64' ? arch : 'other';
}

export function nodeMajor(version: string = process.versions.node): string {
  const major = version.split('.')[0] ?? '';
  return /^[1-9]\d$/.test(major) ? major : 'other';
}

/** Every kind installKind can give. */
export const INSTALL_KINDS = ['npx', 'dlx', 'global', 'local', 'docker', 'mcpb', 'source'] as const;

/**
 * How this copy was installed. The Docker image and the Claude Desktop
 * bundle say so themselves (OPA_MCP_PACKAGING); the rest is read from where
 * the package sits.
 */
export function installKind(env: Env = process.env, root: string = PACKAGE_ROOT): string {
  const packaged = packagedAs(env);
  if (packaged) return packaged;
  if (!isInstalled(root)) return 'source';
  const p = `${root.replace(/\\/g, '/')}/`;
  // npx keeps what it runs in <npm cache>/_npx/<hash>/node_modules.
  if (p.includes('/_npx/')) return 'npx';
  // pnpm dlx, yarn dlx and bunx run from folders of their own.
  if (/\/dlx[-/]|\/bunx-|\/\.bun\/install\/cache\//i.test(p)) return 'dlx';
  // npm's global folder is node_modules under lib (Unix) or npm (Windows);
  // pnpm's is under global/<n>.
  if (/\/(?:lib|npm)\/node_modules\/@orygn\/opa-mcp\/$/.test(p)) return 'global';
  if (/\/global\/\d+\/node_modules\//.test(p)) return 'global';
  return 'local';
}

/** A container, as far as the process can tell. */
export function runContext(
  env: Env = process.env,
  platform: string = process.platform,
  fileExists: (p: string) => boolean = existsSync,
): string {
  if (packagedAs(env) === 'docker') return 'container';
  if (env['KUBERNETES_SERVICE_HOST']) return 'container';
  // Docker and Podman each leave a marker file at the container root.
  if (platform === 'linux' && (fileExists('/.dockerenv') || fileExists('/run/.containerenv'))) {
    return 'container';
  }
  return 'default';
}

/** `1.22.4` becomes `1.22`; anything else is unknown. */
export function minorVersion(version: string | null | undefined): string {
  const m = /^v?(\d{1,3})\.(\d{1,3})(?:[.\-+]|$)/.exec(version?.trim() ?? '');
  return m ? `${m[1]!}.${m[2]!}` : 'unknown';
}

/** A Claude Desktop setting the app did not fill in reaches us as its placeholder. */
const PLACEHOLDER_RE = /^\$\{user_config\.[^}]*\}$/;

function envValue(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v && !PLACEHOLDER_RE.test(v) ? v : undefined;
}

/**
 * How opa was found: OPA_BINARY set to a path of the user's choosing, opa on
 * PATH, the copy bundled with the npm package, or not at all.
 */
export function opaSource(
  env: Env,
  resolvedBinary: string,
  version: string | null | undefined,
): string {
  if (!version) return 'missing';
  const configured = envValue(env, 'OPA_BINARY');
  if (configured !== undefined && configured !== 'opa') return 'custom';
  return resolvedBinary === 'opa' ? 'path' : 'bundled';
}

/**
 * The documented settings that change what the server does, with the value
 * each has when not set. A report names the ones set to something else,
 * never their values.
 */
export const SETTINGS: ReadonlyArray<readonly [string, string?]> = [
  ['OPA_URL', 'http://localhost:8181'],
  ['OPA_TOKEN'],
  ['OPA_BINARY', 'opa'],
  ['REGAL_BINARY', 'regal'],
  ['CONFTEST_BINARY', 'conftest'],
  ['OPA_MCP_ALLOWED_PATHS'],
  ['OPA_MCP_NO_CLIENT_ROOTS'],
  ['OPA_MCP_TIMEOUT_MS', '30000'],
  ['OPA_MCP_HTTP_TIMEOUT_MS', '15000'],
  ['OPA_MCP_MAX_RESPONSE_BYTES', '100000'],
  ['OPA_MCP_MAX_SUBPROCESS_BYTES', '33554432'],
  ['OPA_MCP_PASSTHROUGH_ENV'],
  ['OPA_MCP_BLOCK_ENV'],
  ['OPA_MCP_LOG_FILE'],
  ['OPA_MCP_LOG_LEVEL', 'info'],
];

export function settingsSet(env: Env = process.env): string[] {
  return SETTINGS.filter(([name, fallback]) => {
    const v = envValue(env, name);
    return v !== undefined && v.toLowerCase() !== fallback?.toLowerCase();
  }).map(([name]) => name);
}

// --- the days ---

function isoWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return utcDay(new Date(d.getTime() - back * 86_400_000));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Whether today is this install's first active day of its week, month, and
 * ever, from the days before it. Worked out from the days before today only,
 * so a report sent again later the same day says the same.
 */
export function firstFlags(
  active: string[],
  day: string,
  firstSeen: string | undefined,
): Report['first'] {
  const earlier = active.filter((d) => d < day);
  return {
    week: !earlier.some((d) => isoWeekStart(d) === isoWeekStart(day)),
    month: !earlier.some((d) => d.slice(0, 7) === day.slice(0, 7)),
    ever: earlier.length === 0 && (firstSeen === undefined || firstSeen === day),
  };
}

function addCounts(into: Record<string, number>, from: unknown): void {
  if (typeof from !== 'object' || from === null) return;
  for (const [k, n] of Object.entries(from as Record<string, unknown>)) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) into[k] = (into[k] ?? 0) + v;
  }
}

const KEY_RE = /^[A-Za-z0-9_|@/.:-]{1,160}$/;

// At most this many of each per day, the most used first; the receiver keeps
// no more than these.
const MAX_TOOLS = 80;
const MAX_FAILURES = 100;
const MAX_CRASHES = 20;

function banded(counts: Record<string, number>, max: number): Record<string, string> {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([k, n]) => n > 0 && KEY_RE.test(k))
      .sort(([, a], [, b]) => b - a)
      .slice(0, max)
      .map(([k, n]) => [k, countBand(n)]),
  );
}

/**
 * The finished days' counts, added up across every process's file. A day
 * with a file written in the last minute waits for the next report.
 */
export function collectDays(
  dir: string,
  today: string,
  now: number = Date.now(),
): { days: ReportDay[]; files: Record<string, string[]> } {
  const byDay = new Map<string, { tally: DayTally; files: string[]; fresh: boolean }>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { days: [], files: {} };
  }
  for (const name of names) {
    const m = /^day-(\d{4}-\d{2}-\d{2})-[\w-]+\.json$/.exec(name);
    if (!m || m[1]! >= today) continue;
    const path = join(dir, name);
    let tally: Partial<DayTally>;
    let mtime: number;
    try {
      tally = JSON.parse(readFileSync(path, 'utf8')) as Partial<DayTally>;
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const entry = byDay.get(m[1]!) ?? {
      tally: { tools: {}, failures: {}, crashes: {}, apps: [] },
      files: [],
      fresh: false,
    };
    addCounts(entry.tally.tools, tally.tools);
    addCounts(entry.tally.failures, tally.failures);
    addCounts(entry.tally.crashes, tally.crashes);
    for (const app of Array.isArray(tally.apps) ? tally.apps : []) {
      if (typeof app === 'string' && !entry.tally.apps.includes(app)) entry.tally.apps.push(app);
    }
    entry.files.push(path);
    if (now - mtime < SETTLE_MS) entry.fresh = true;
    byDay.set(m[1]!, entry);
  }
  const ready = [...byDay.entries()]
    .filter(([, e]) => !e.fresh)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, MAX_DAYS);
  return {
    days: ready.map(([d, e]) => ({
      d,
      tools: banded(e.tally.tools, MAX_TOOLS),
      failures: banded(e.tally.failures, MAX_FAILURES),
      crashes: banded(e.tally.crashes, MAX_CRASHES),
      apps: e.tally.apps.slice(0, 10),
    })),
    files: Object.fromEntries(ready.map(([d, e]) => [d, e.files])),
  };
}

// --- state and the lock ---

function readState(dir: string): State {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as State;
    return {
      ...s,
      active: Array.isArray(s.active)
        ? s.active.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
        : [],
    };
  } catch {
    return { active: [] };
  }
}

function writeState(dir: string, state: State): void {
  const temp = join(dir, `state.json.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, join(dir, 'state.json'));
}

/**
 * Made with exclusive create, so of several processes trying at once one gets
 * it. A lock older than a minute belongs to a process that died.
 */
function takeLock(dir: string, now: number): boolean {
  const path = join(dir, 'send.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      try {
        if (now - statSync(path).mtimeMs > LOCK_STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(dir: string): void {
  rmSync(join(dir, 'send.lock'), { force: true });
}

/** After a failed send: 15 minutes, doubling, at most 6 hours. */
export function backoffMs(failures: number): number {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, failures - 1), 6 * 3_600_000);
}

// --- sending ---

/** The receiver's HTTP status, or 0 when it could not be reached. */
type Post = (url: string, body: string) => Promise<number>;

const realPost: Post = async (url, body) => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `opa-mcp/${SERVER_VERSION}` },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: 'error',
    });
    return res.status;
  } catch {
    return 0;
  }
};

/**
 * What a status means for the report: taken; refused for what it is, which
 * sending it again would not change; or not taken this time.
 */
export function sendOutcome(status: number): 'sent' | 'rejected' | 'failed' {
  if (status >= 200 && status < 300) return 'sent';
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'rejected';
  return 'failed';
}

/** The report as sent, without the oldest days while it is too large. */
export function fitReport(report: Report): string {
  let body = JSON.stringify(report);
  while (body.length > MAX_REPORT_BYTES && report.days.length > 0) {
    report.days = report.days.slice(0, -1);
    body = JSON.stringify(report);
  }
  return body;
}

interface Binaries {
  opa: string | null;
  regal: string | null;
  conftest: string | null;
}

let binaries: Binaries | undefined;
let binariesKnown: () => void = () => {};
let binariesReady = new Promise<void>((resolve) => {
  binariesKnown = resolve;
});

/** Called by the startup check with the versions it found, null for a binary not found. */
export function noteBinaryVersions(found: Binaries): void {
  binaries = found;
  binariesKnown();
}

interface Deps {
  post: Post;
  env: Env;
  log: (line: string) => void;
}

const realLog = (line: string): void => {
  logger.info('usage report (OPA_MCP_TELEMETRY=log, not sent)', { report: line });
  process.stderr.write(`opa-mcp usage report (OPA_MCP_TELEMETRY=log, not sent): ${line}\n`);
};

let deps: Deps = { post: realPost, env: process.env, log: realLog };

/**
 * Where reports go. OPA_MCP_TELEMETRY_URL points them at another receiver,
 * such as one run locally to test against.
 */
function endpoint(): string {
  const override = deps.env['OPA_MCP_TELEMETRY_URL']?.trim().replace(/\/+$/, '');
  return (override && /^https?:\/\/\S+$/.test(override) ? override : REPORT_BASE) + REPORT_PATH;
}

let config: Config | undefined;
let mode: UsageSwitch['mode'] = 'off';
let sending = false;
let sentDay: string | undefined;
let retryAfter = 0;

/**
 * Turns the report on for this process when usage stats are on (or in log
 * mode), and counting with it. Returns the switch, for the caller to decide
 * whether to watch tool calls at all.
 */
export function startUsageReport(cfg: Config): UsageSwitch {
  const sw = usageSwitch(deps.env);
  if (sw.mode === 'off') return sw;
  config = cfg;
  mode = sw.mode;
  startCounting({ onToolCall: () => void sendIfDue() });
  return sw;
}

async function knownBinaries(): Promise<Binaries | undefined> {
  if (binaries) return binaries;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    binariesReady,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BINARIES_WAIT_MS);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  return binaries;
}

const FILES = { env: 'allowed_paths', 'client-roots': 'roots', none: 'none' } as const;

async function buildReport(
  cfg: Config,
  state: State & { nonce: { day: string; value: string }; first_seen: string },
  day: string,
  first: Report['first'],
  days: ReportDay[],
): Promise<Report> {
  const found = await knownBinaries();
  return {
    s: SCHEMA,
    day,
    nonce: state.nonce.value,
    v: SERVER_VERSION,
    os: osName(),
    arch: archName(),
    node: nodeMajor(),
    app: currentAppName(),
    install: installKind(deps.env),
    ctx: runContext(deps.env),
    // Unknown when the startup check has not finished in time.
    opa: found ? opaSource(deps.env, cfg.opaBinary, found.opa) : 'unknown',
    opa_v: minorVersion(found?.opa),
    regal: found && !found.regal ? 'missing' : minorVersion(found?.regal),
    conftest: found && !found.conftest ? 'missing' : minorVersion(found?.conftest),
    files: FILES[allowedRoots(cfg).source],
    settings: settingsSet(deps.env),
    age: ageBand(daysBetween(state.first_seen, day)),
    first,
    days,
  };
}

/**
 * Sends today's report if it has not gone out yet. Never throws, never writes
 * to stdout, never holds up a tool: it runs after the result is on its way.
 */
export async function sendIfDue(
  now: Date = new Date(),
): Promise<'sent' | 'logged' | 'skipped' | 'failed' | 'rejected'> {
  if (!config || sending || mode === 'off') return 'skipped';
  const day = utcDay(now);
  if (sentDay === day || now.getTime() < retryAfter) return 'skipped';
  sending = true;
  const dir = usageDir();
  try {
    mkdirSync(dir, { recursive: true });
    const before = readState(dir);
    if (before.sent_day === day) {
      sentDay = day;
      return 'skipped';
    }
    if (before.next_try_at && Date.parse(before.next_try_at) > now.getTime()) {
      retryAfter = Date.parse(before.next_try_at);
      return 'skipped';
    }
    if (!takeLock(dir, now.getTime())) return 'skipped';
    try {
      // Read again under the lock: another process may have just sent.
      const state = readState(dir);
      if (state.sent_day === day) {
        sentDay = day;
        return 'skipped';
      }
      if (state.nonce?.day !== day) state.nonce = { day, value: randomBytes(16).toString('hex') };
      if (!state.first_seen) state.first_seen = day;
      const first = firstFlags(state.active, day, state.first_seen);
      if (!state.active.includes(day)) {
        state.active = [...state.active.filter((d) => d < day), day].slice(-40);
      }
      // Saved before sending, so a retry reuses the same number and flags.
      writeState(dir, state);

      flush();
      const { days, files } = collectDays(dir, day, now.getTime());
      const report = await buildReport(
        config,
        state as State & { nonce: { day: string; value: string }; first_seen: string },
        day,
        first,
        days,
      );
      const body = fitReport(report);
      let outcome: 'sent' | 'logged' | 'rejected' | 'failed';
      if (mode === 'log') {
        deps.log(body);
        outcome = 'logged';
      } else {
        outcome = sendOutcome(await deps.post(endpoint(), body));
      }
      if (outcome === 'failed') {
        state.failures = (state.failures ?? 0) + 1;
        retryAfter = now.getTime() + backoffMs(state.failures);
        state.next_try_at = new Date(retryAfter).toISOString();
      } else {
        // Taken, logged, or refused for good: either way this day is done, and
        // the counts it carried go, so a report the receiver will never take
        // cannot be retried for ever.
        state.sent_day = day;
        delete state.failures;
        delete state.next_try_at;
        // Only the days that went out: a day left out to make the report fit
        // goes with a later one.
        for (const d of report.days) for (const f of files[d.d] ?? []) rmSync(f, { force: true });
        sentDay = day;
      }
      writeState(dir, state);
      return outcome;
    } finally {
      releaseLock(dir);
    }
  } catch {
    return 'failed';
  } finally {
    sending = false;
  }
}

// --- the install ID of earlier versions ---

const OLD_ID_FILE = join(homedir(), '.orygn', 'opa-mcp', 'install-id');

/**
 * Versions before 0.11.0 kept a random install ID in this file and sent it
 * with every start. Nothing reads it any more, so it is removed, but only if
 * it is still the file those versions wrote.
 */
export function removeOldInstallId(file: string = OLD_ID_FILE): boolean {
  try {
    if (!readFileSync(file, 'utf8').startsWith('# opa-mcp install ID')) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** For tests: swap what sends and what is read, and reset the in-process memory. */
export const __testing = {
  use(next: Partial<Deps>, cfg?: Config, m: UsageSwitch['mode'] = 'on'): void {
    deps = { ...deps, ...next };
    if (cfg) config = cfg;
    mode = m;
    sentDay = undefined;
    retryAfter = 0;
    sending = false;
  },
  reset(): void {
    deps = { post: realPost, env: process.env, log: realLog };
    config = undefined;
    mode = 'off';
    sentDay = undefined;
    retryAfter = 0;
    sending = false;
    binaries = undefined;
    binariesReady = new Promise<void>((resolve) => {
      binariesKnown = resolve;
    });
  },
  endpoint,
};
