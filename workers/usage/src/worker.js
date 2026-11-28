// Receives opa-mcp's anonymous usage reports and keeps daily counts. The
// client side is src/lib/usage-report.ts; docs/privacy.md lists the fields.
//
//   POST /opa-mcp/v1/report   the daily report of an install
//   GET  /opa-mcp/v1/stats    the counts, for whoever holds STATS_TOKEN
//   GET  /opa-mcp/v1/log      the last days of reports as received, likewise
//
// It answers nothing outside those paths.
//
// The POST path must stay up for good: every published version sends to it,
// including versions that can no longer be updated. Every value is checked
// against a fixed list or pattern; anything else is counted as "other" or
// dropped, so a report can never add a row of its own making.

const SCHEMA = 1;
const BASE = '/opa-mcp/v1';
const MAX_BODY = 64 * 1024;
const MAX_DAYS = 7;
const MAX_TOOLS = 80;
const MAX_FAILURES = 100;
const MAX_CRASHES = 20;
const MAX_APPS = 10;
const LOG_DAYS = 7;
const NONCE_DAYS = 3;
const DAY_MS = 86_400_000;

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
// The server's own tool names all have one of these prefixes. A tool the
// client did not know is sent as "other".
const TOOL_RE = /^(?:rego|opa|conftest|mcp)_[a-z0-9_]{1,40}$/;
// Where in the server's own code an unexpected error was thrown: the
// error's type and a file under dist/ with its line, or external when the
// innermost frame was outside the server.
const SITE_RE = /^(?:[A-Z][A-Za-z]{0,39}@[a-z0-9][a-z0-9/_.-]{0,99}\.js:\d{1,6}|external|unknown)$/;
const MINOR_RE = /^\d{1,3}\.\d{1,3}$/;
const NODE_RE = /^[1-9]\d$/;
const COUNTRY_RE = /^[A-Z][A-Z0-9]$/;

const OS = new Set(['windows', 'macos', 'linux', 'other']);
const ARCH = new Set(['x64', 'arm64', 'other']);
const APPS = new Set([
  'claude-desktop',
  'claude-code',
  'cursor',
  'vscode',
  'windsurf',
  'roo-code',
  'cline',
  'codex',
  'zed',
  'goose',
  'continue',
  'lm-studio',
  'gemini-cli',
  'kiro',
  'chatgpt',
  'jetbrains',
  'opencode',
  'warp',
  'librechat',
  'inspector',
  'other',
  'unknown',
]);
const INSTALLS = new Set([
  'npx',
  'dlx',
  'global',
  'local',
  'docker',
  'mcpb',
  'plugin',
  'source',
  'other',
]);
const CONTEXTS = new Set(['default', 'container']);
const OPA_SOURCES = new Set(['bundled', 'path', 'custom', 'missing', 'unknown']);
const FILES = new Set(['allowed_paths', 'roots', 'none']);
const AGES = new Set(['0', '1-7', '8-30', '31-90', '90+']);
const COUNTS = new Set(['1-9', '10-99', '100+']);
// The settings a report may name: the documented environment variables
// that change what the server does. Only their names are ever sent.
const SETTINGS = new Set([
  'OPA_URL',
  'OPA_TOKEN',
  'OPA_BINARY',
  'REGAL_BINARY',
  'CONFTEST_BINARY',
  'OPA_MCP_ALLOWED_PATHS',
  'OPA_MCP_NO_CLIENT_ROOTS',
  'OPA_MCP_TIMEOUT_MS',
  'OPA_MCP_HTTP_TIMEOUT_MS',
  'OPA_MCP_MAX_RESPONSE_BYTES',
  'OPA_MCP_MAX_SUBPROCESS_BYTES',
  'OPA_MCP_PASSTHROUGH_ENV',
  'OPA_MCP_BLOCK_ENV',
  'OPA_MCP_LOG_FILE',
  'OPA_MCP_LOG_LEVEL',
]);
// The error codes a tool result can carry (src/types.ts), and four the
// client adds for calls that never reached a tool or ended without a result
// from one.
const CODES = new Set([
  'INVALID_INPUT',
  'OPA_BINARY_NOT_FOUND',
  'REGAL_NOT_FOUND',
  'REGAL_VERSION_TOO_OLD',
  'CONFTEST_NOT_FOUND',
  'INVALID_REGO',
  'INVALID_BUNDLE',
  'EVAL_ERROR',
  'PATH_NOT_ALLOWED',
  'PATH_NOT_FOUND',
  'OPA_UNREACHABLE',
  'OPA_AUTH_FAILED',
  'POLICY_NOT_FOUND',
  'DATA_NOT_FOUND',
  'DEPENDENCY_CONFLICT',
  'NO_TESTS_FOUND',
  'COVERAGE_BELOW_THRESHOLD',
  'OUTPUT_TOO_LARGE',
  'SUBPROCESS_KILLED',
  'OPA_URL_INVALID',
  'TIMEOUT',
  'CANCELLED',
  'VERIFY_INCONCLUSIVE',
  'Z3_INIT_ERROR',
  'OPA_VERSION_UNSUPPORTED',
  'GITHUB_TOKEN_MISSING',
  'GIST_CREATE_FAILED',
  'UNKNOWN_ERROR',
  'INVALID_ARGUMENTS',
  'UNKNOWN_TOOL',
  'PROTOCOL_ERROR',
  'UNRECOGNIZED',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === `${BASE}/report`) {
      return receive(request, env);
    }
    // Everything else is private. A failed check answers 404, like an
    // address that does not exist, and an unset STATS_TOKEN refuses all.
    if (
      request.method === 'GET' &&
      (url.pathname === `${BASE}/stats` || url.pathname === `${BASE}/log`)
    ) {
      if (await authorized(request, env)) {
        return url.pathname === `${BASE}/stats`
          ? Response.json(
              await stats(
                env.DB,
                intParam(url, 'days', 30, 1, 400),
                url.searchParams.get('rows') === '1',
              ),
            )
          : Response.json(await recent(env.DB, intParam(url, 'hours', 24, 1, LOG_DAYS * 24)));
      }
    }
    return new Response('not found', { status: 404 });
  },

  // Once a day: forget report numbers after three days and the log after seven.
  async scheduled(controller, env) {
    const now = controller.scheduledTime;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM nonces WHERE seen < ?1').bind(isoDay(now - NONCE_DAYS * DAY_MS)),
      env.DB.prepare('DELETE FROM log WHERE ts < ?1').bind(
        new Date(now - LOG_DAYS * DAY_MS).toISOString(),
      ),
    ]);
  },
};

// ── receiving ─────────────────────────────────────────────────────────────

async function receive(request, env) {
  // An address sending far more than any client would is not recorded past
  // the limit. The address is only the limiter's key and is never stored.
  const address = request.headers.get('cf-connecting-ip');
  if (address && env.REPORT_LIMIT) {
    const { success } = await env.REPORT_LIMIT.limit({ key: address });
    if (!success) return new Response(null, { status: 204 });
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY) return new Response('too large', { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response('too large', { status: 413 });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (
    !body ||
    typeof body !== 'object' ||
    body.s !== SCHEMA ||
    typeof body.nonce !== 'string' ||
    !NONCE_RE.test(body.nonce)
  ) {
    return new Response('bad report', { status: 400 });
  }

  const now = Date.now();
  const today = isoDay(now);
  const country =
    typeof request.cf?.country === 'string' && COUNTRY_RE.test(request.cf.country)
      ? request.cf.country
      : 'XX';
  const clean = cleanReport(body, now);
  const rows = reportRows(clean, today, country);

  // One transaction: the report's number, the counts, the log. A number
  // seen before (a report sent again after an answer that never arrived)
  // turns fresh to 0, and the two inserts after it then add nothing. If
  // anything fails, none of it stays, and the client's retry counts.
  const fresh = 'SELECT fresh FROM nonces WHERE nonce = ?2';
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO nonces (nonce, seen, fresh) VALUES (?1, ?2, 1) ON CONFLICT (nonce) DO UPDATE SET fresh = 0',
      ).bind(body.nonce, today),
      // Every count in one statement.
      env.DB.prepare(
        `INSERT INTO daily (day, metric, key, n)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), 1
         FROM json_each(?1) WHERE (${fresh}) = 1
         ON CONFLICT (day, metric, key) DO UPDATE SET n = n + 1`,
      ).bind(JSON.stringify(rows), body.nonce),
      env.DB.prepare(`INSERT INTO log (ts, body) SELECT ?1, ?3 WHERE (${fresh}) = 1`).bind(
        new Date(now).toISOString(),
        body.nonce,
        JSON.stringify({ ...clean, country }),
      ),
    ]);
  } catch (err) {
    console.error('report not recorded', String(err));
    return new Response('error', { status: 500 });
  }
  return new Response(null, { status: 204 });
}

function pick(value, allowed, fallback = 'other') {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function matching(value, re, fallback = 'other') {
  return typeof value === 'string' && re.test(value) ? value : fallback;
}

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A map of key to band, keeping only keys that pass `valid` and a known
// band, up to `max` of them.
function bandMap(value, valid, max) {
  const out = {};
  if (!isMap(value)) return out;
  let n = 0;
  for (const [k, band] of Object.entries(value)) {
    if (n >= max) break;
    if (!valid(k) || !COUNTS.has(band)) continue;
    out[k] = band;
    n += 1;
  }
  return out;
}

const validTool = (t) => t === 'other' || TOOL_RE.test(t);

// tool|code: a tool name and an error code from the list.
function validFailure(key) {
  const [tool, code, extra] = key.split('|');
  return extra === undefined && validTool(tool) && CODES.has(code);
}

// tool|site: a tool name and a crash site.
function validCrash(key) {
  const at = key.indexOf('|');
  return at > 0 && validTool(key.slice(0, at)) && SITE_RE.test(key.slice(at + 1));
}

// The report reduced to what is allowed. A finished day is only taken from
// the last six weeks and never from the future.
export function cleanReport(body, now) {
  const first = isMap(body.first) ? body.first : {};
  const earliest = isoDay(now - 42 * DAY_MS);
  const latest = isoDay(now + DAY_MS);
  const days = [];
  const seen = new Set();
  for (const d of Array.isArray(body.days) ? body.days : []) {
    if (days.length >= MAX_DAYS) break;
    if (
      !isMap(d) ||
      typeof d.d !== 'string' ||
      !DAY_RE.test(d.d) ||
      d.d < earliest ||
      d.d > latest ||
      seen.has(d.d)
    )
      continue;
    seen.add(d.d);
    days.push({
      d: d.d,
      tools: bandMap(d.tools, validTool, MAX_TOOLS),
      failures: bandMap(d.failures, validFailure, MAX_FAILURES),
      crashes: bandMap(d.crashes, validCrash, MAX_CRASHES),
      apps: [
        ...new Set(
          (Array.isArray(d.apps) ? d.apps : []).slice(0, MAX_APPS).map((a) => pick(a, APPS)),
        ),
      ],
    });
  }
  const settings = Array.isArray(body.settings)
    ? [
        ...new Set(
          body.settings
            .slice(0, SETTINGS.size)
            .filter((s) => typeof s === 'string' && SETTINGS.has(s)),
        ),
      ]
    : [];
  return {
    v: matching(body.v, VERSION_RE),
    os: pick(body.os, OS),
    arch: pick(body.arch, ARCH),
    node: matching(body.node, NODE_RE),
    app: pick(body.app, APPS),
    install: pick(body.install, INSTALLS),
    ctx: pick(body.ctx, CONTEXTS),
    opa: pick(body.opa, OPA_SOURCES),
    opa_v: matching(body.opa_v, MINOR_RE, 'unknown'),
    regal: body.regal === 'missing' ? 'missing' : matching(body.regal, MINOR_RE, 'unknown'),
    conftest:
      body.conftest === 'missing' ? 'missing' : matching(body.conftest, MINOR_RE, 'unknown'),
    files: pick(body.files, FILES),
    settings,
    age: pick(body.age, AGES),
    first: { week: first.week === true, month: first.month === true, ever: first.ever === true },
    days,
  };
}

// The rows a report adds one to. A report from a source checkout is
// development: it is counted apart and touches nothing else.
export function reportRows(r, today, country) {
  if (r.install === 'source') return [[today, 'dev_reports', '']];
  const rows = [
    [today, 'reports', ''],
    [today, 'version', r.v],
    [today, 'os', r.os],
    [today, 'arch', r.arch],
    [today, 'node', r.node],
    [today, 'app', r.app],
    [today, 'install', r.install],
    [today, 'ctx', r.ctx],
    [today, 'country', country],
    [today, 'opa', r.opa === 'missing' ? 'missing' : `${r.opa}|${r.opa_v}`],
    [today, 'regal', r.regal],
    [today, 'conftest', r.conftest],
    [today, 'files', r.files],
    [today, 'age', r.age],
  ];
  for (const s of r.settings) rows.push([today, 'setting', s]);
  // Kept by context: a container started fresh each time (docker run --rm)
  // keeps no state, so it is new on every run and must not count as one.
  if (r.first.week) rows.push([today, 'first_week', r.ctx]);
  if (r.first.month) rows.push([today, 'first_month', r.ctx]);
  if (r.first.ever) rows.push([today, 'first_ever', r.ctx]);
  for (const d of r.days) {
    rows.push([d.d, 'active', '']);
    for (const [tool, band] of Object.entries(d.tools)) rows.push([d.d, 'tool', `${tool}|${band}`]);
    for (const [key, band] of Object.entries(d.failures))
      rows.push([d.d, 'failure', `${key}|${band}`]);
    for (const [key, band] of Object.entries(d.crashes))
      rows.push([d.d, 'crash', `${key}|${band}`]);
    for (const app of d.apps) rows.push([d.d, 'active_app', app]);
  }
  return rows;
}

// ── stats ─────────────────────────────────────────────────────────────────

async function authorized(request, env) {
  if (!env.STATS_TOKEN) return false;
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(env.STATS_TOKEN);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function intParam(url, name, fallback, min, max) {
  const n = Number(url.searchParams.get(name));
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const PER_DAY = ['reports', 'first_week', 'first_month', 'first_ever', 'active', 'dev_reports'];
const FIRSTS = ['first_week', 'first_month', 'first_ever'];
const DAY_FIELDS = [...PER_DAY, ...FIRSTS.map((m) => `${m}_container`)];

// The counts for the last `days` days: a line per day for the headline
// figures, and every breakdown summed over the span. With rows, also every
// row as stored, for following one value over time.
async function stats(db, days, withRows) {
  const from = isoDay(Date.now() - (days - 1) * DAY_MS);
  const { results } = await db
    .prepare('SELECT day, metric, key, n FROM daily WHERE day >= ?1 ORDER BY day, metric, key')
    .bind(from)
    .all();
  const perDay = {};
  const totals = {};
  for (const { day, metric, key, n } of results) {
    if (PER_DAY.includes(metric)) {
      perDay[day] ??= Object.fromEntries(DAY_FIELDS.map((m) => [m, 0]));
      // The first-of counts are installs outside containers; those inside
      // one are shown apart.
      perDay[day][FIRSTS.includes(metric) && key !== 'default' ? `${metric}_container` : metric] +=
        n;
      continue;
    }
    totals[metric] ??= {};
    totals[metric][key || '-'] = (totals[metric][key || '-'] ?? 0) + n;
  }
  return { from, days, perDay, totals, ...(withRows ? { rows: results } : {}) };
}

// The reports of the last `hours` hours, newest first, as they were stored.
async function recent(db, hours) {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const { results } = await db
    .prepare('SELECT ts, body FROM log WHERE ts >= ?1 ORDER BY ts DESC LIMIT 500')
    .bind(since)
    .all();
  return { since, reports: results.map((r) => ({ ts: r.ts, ...JSON.parse(r.body) })) };
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
