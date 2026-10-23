const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;

// The values Node reports as process.platform.
const PLATFORMS = new Set([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
]);

// Sent instead of an install ID by clients running in a container or a CI job.
const CONTEXTS = new Set(['container', 'ci']);

const LOG_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── /ping ─────────────────────────────────────────────────────────────
    // Stays open, and must. Every published version calls it, including
    // releases that can no longer be updated.
    if (url.pathname === '/ping') {
      return ping(request, url, env);
    }

    // ── everything below is private ───────────────────────────────────────
    // A failed check answers 404, not 401, so the endpoints do not announce
    // themselves. An unset STATS_TOKEN denies everything: a deploy that lands
    // before the secret is set fails closed rather than open.
    if (!(await authorized(request, env))) {
      return new Response('not found', { status: 404 });
    }

    switch (url.pathname) {
      case '/stats':
        return Response.json(await stats(env.DB));
      case '/stats/history':
        return Response.json(await history(env.DB, intParam(url, 'days', 30, 1, 400)));
      case '/stats/installs':
        return Response.json(await installs(env.DB));
      case '/stats/log':
        return Response.json(await recentLog(env.DB, intParam(url, 'hours', 24, 1, LOG_DAYS * 24)));
      default:
        return new Response('not found', { status: 404 });
    }
  },

  // Once a day: drop log rows older than LOG_DAYS.
  async scheduled(controller, env) {
    const cutoff = new Date(controller.scheduledTime - LOG_DAYS * DAY_MS).toISOString();
    await env.DB.prepare('DELETE FROM ping_log WHERE ts < ?1').bind(cutoff).run();
  },
};

// ── ping ──────────────────────────────────────────────────────────────────

async function ping(request, url, env) {
  // An address sending far more pings than a client ever would is not
  // recorded past the limit. The address is only the limiter's key; it is
  // never written anywhere.
  const address = request.headers.get('cf-connecting-ip');
  if (address && env.PING_LIMIT) {
    const { success } = await env.PING_LIMIT.limit({ key: address });
    if (!success) return new Response('ok', { status: 200 });
  }

  const now = new Date();
  const params = url.searchParams;
  const c = params.get('c');
  const id = params.get('u');

  const event = {
    ts: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    version: clean(params.get('v'), (v) => VERSION_RE.test(v)),
    platform: clean(params.get('p'), (p) => PLATFORMS.has(p)),
    context: !c ? 'default' : CONTEXTS.has(c) ? c : 'other',
    id: id && UUID_RE.test(id) ? id : null,
    userAgent: (request.headers.get('user-agent') ?? '').slice(0, 64),
  };

  try {
    await record(env.DB, event);
  } catch (err) {
    console.error('ping not recorded', String(err));
    return new Response('error', { status: 500 });
  }
  return new Response('ok', { status: 200 });
}

/**
 * Anything outside the expected shape is stored as `other`, so arbitrary
 * query strings cannot create arbitrary rows.
 */
function clean(value, valid) {
  if (!value) return 'unknown';
  return valid(value) ? value : 'other';
}

async function record(db, event) {
  let idState = 'none';

  if (event.context !== 'default') {
    // Containers and CI jobs usually start from a clean home directory, so any
    // ID they send would be new on every run. They count as pings, not installs.
    idState = 'ignored';
  } else if (event.id) {
    // One statement decides new, returning or repeat. Two pings from the same
    // install arriving together cannot both count it: the second finds
    // last_seen already set to today and changes nothing.
    const row = await db
      .prepare(
        `INSERT INTO installs (id, first_seen, last_seen, days_seen) VALUES (?1, ?2, ?2, 1)
         ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen, days_seen = installs.days_seen + 1
           WHERE installs.last_seen < excluded.last_seen
         RETURNING days_seen`,
      )
      .bind(event.id, event.date)
      .first();
    idState = row === null ? 'repeat' : row.days_seen === 1 ? 'new' : 'returning';
  }

  const writes = [
    db
      .prepare(
        `INSERT INTO daily_pings (date, version, platform, context, pings) VALUES (?1, ?2, ?3, ?4, 1)
         ON CONFLICT (date, version, platform, context) DO UPDATE SET pings = daily_pings.pings + 1`,
      )
      .bind(event.date, event.version, event.platform, event.context),
    db
      .prepare(
        `INSERT INTO ping_log (ts, version, platform, context, id_state, user_agent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(event.ts, event.version, event.platform, event.context, idState, event.userAgent),
  ];

  if (idState === 'new' || idState === 'returning') {
    writes.push(
      db
        .prepare(
          `INSERT INTO daily_installs (date, active_installs, new_installs) VALUES (?1, 1, ?2)
           ON CONFLICT (date) DO UPDATE SET
             active_installs = daily_installs.active_installs + 1,
             new_installs = daily_installs.new_installs + excluded.new_installs`,
        )
        .bind(event.date, idState === 'new' ? 1 : 0),
    );
  }

  await db.batch(writes);
}

// ── stats ─────────────────────────────────────────────────────────────────
// Every figure adds the counters carried over from the previous store
// (legacy_*) to the ones recorded here, so totals and history run unbroken
// across the move. The reads never return install IDs.

async function stats(db) {
  const today = utcDate();
  const [legacy, versions, platforms, contexts, counts, todayPings, todayInstalls, legacyToday] =
    await db.batch([
      db.prepare('SELECT key, value FROM legacy_totals'),
      db.prepare('SELECT version AS k, SUM(pings) AS n FROM daily_pings GROUP BY version'),
      db.prepare('SELECT platform AS k, SUM(pings) AS n FROM daily_pings GROUP BY platform'),
      db.prepare('SELECT context AS k, SUM(pings) AS n FROM daily_pings GROUP BY context'),
      installCounts(db),
      db
        .prepare('SELECT COALESCE(SUM(pings), 0) AS n FROM daily_pings WHERE date = ?1')
        .bind(today),
      db
        .prepare('SELECT active_installs, new_installs FROM daily_installs WHERE date = ?1')
        .bind(today),
      db.prepare('SELECT field, value FROM legacy_daily WHERE date = ?1').bind(today),
    ]);

  const old = Object.fromEntries(legacy.results.map((r) => [r.key, r.value]));
  const oldToday = Object.fromEntries(legacyToday.results.map((r) => [r.field, r.value]));
  const c = counts.results[0];
  const t = todayInstalls.results[0];

  return {
    total: (old.total ?? 0) + sum(versions.results),
    installs: c.total,
    returningInstalls: c.came_back,
    activeInstalls: { last7Days: c.week, last30Days: c.month },
    versions: merge(prefixed(old, 'v:'), versions.results),
    platforms: merge(prefixed(old, 'p:'), platforms.results),
    contexts: merge({}, contexts.results),
    today: {
      date: today,
      total: (oldToday.total ?? 0) + todayPings.results[0].n,
      dau: (oldToday.dau ?? 0) + (t?.active_installs ?? 0),
      new: (oldToday['installs:new'] ?? 0) + (t?.new_installs ?? 0),
    },
  };
}

async function installs(db) {
  const today = utcDate();
  const [counts, todayInstalls, legacyToday] = await db.batch([
    installCounts(db),
    db
      .prepare('SELECT active_installs, new_installs FROM daily_installs WHERE date = ?1')
      .bind(today),
    db.prepare('SELECT field, value FROM legacy_daily WHERE date = ?1').bind(today),
  ]);

  const oldToday = Object.fromEntries(legacyToday.results.map((r) => [r.field, r.value]));
  const c = counts.results[0];
  const t = todayInstalls.results[0];

  return {
    total: c.total,
    returning: c.came_back,
    activeLast7Days: c.week,
    activeLast30Days: c.month,
    newToday: (oldToday['installs:new'] ?? 0) + (t?.new_installs ?? 0),
    dauToday: (oldToday.dau ?? 0) + (t?.active_installs ?? 0),
  };
}

/** Installs, how many came back on a later day, and how many were active recently. */
function installCounts(db) {
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(days_seen > 1), 0) AS came_back,
              COALESCE(SUM(last_seen >= ?1), 0) AS week,
              COALESCE(SUM(last_seen >= ?2), 0) AS month
       FROM installs`,
    )
    .bind(daysAgo(6), daysAgo(29));
}

/**
 * One row per day that has data, oldest first, in the flat shape the endpoint
 * has always returned: `total`, `dau`, `installs:new`, then `v:<version>`,
 * `p:<platform>` and `c:<context>` ping counts.
 */
async function history(db, days) {
  const since = daysAgo(days - 1);
  const [legacy, pings, active] = await db.batch([
    db.prepare('SELECT date, field, value FROM legacy_daily WHERE date >= ?1').bind(since),
    db
      .prepare('SELECT date, version, platform, context, pings FROM daily_pings WHERE date >= ?1')
      .bind(since),
    db
      .prepare('SELECT date, active_installs, new_installs FROM daily_installs WHERE date >= ?1')
      .bind(since),
  ]);

  const rows = new Map();
  const row = (date) => {
    if (!rows.has(date)) rows.set(date, { date, total: 0, dau: 0, 'installs:new': 0 });
    return rows.get(date);
  };
  const add = (r, field, n) => {
    r[field] = (r[field] ?? 0) + n;
  };

  for (const { date, field, value } of legacy.results) add(row(date), field, value);
  for (const { date, version, platform, context, pings: n } of pings.results) {
    const r = row(date);
    add(r, 'total', n);
    add(r, `v:${version}`, n);
    add(r, `p:${platform}`, n);
    add(r, `c:${context}`, n);
  }
  for (const { date, active_installs, new_installs } of active.results) {
    const r = row(date);
    add(r, 'dau', active_installs);
    add(r, 'installs:new', new_installs);
  }

  return { history: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/** The newest rows first, at most 5,000. */
async function recentLog(db, hours) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT ts, version, platform, context, id_state, user_agent
       FROM ping_log WHERE ts >= ?1 ORDER BY ts DESC LIMIT 5000`,
    )
    .bind(since)
    .all();
  return { since, rows: results };
}

// ── helpers ───────────────────────────────────────────────────────────────

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}

function intParam(url, name, fallback, min, max) {
  const n = parseInt(url.searchParams.get(name) ?? '', 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
}

function sum(rows) {
  return rows.reduce((total, r) => total + r.n, 0);
}

function prefixed(map, prefix) {
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}

function merge(base, rows) {
  const out = { ...base };
  for (const { k, n } of rows) out[k] = (out[k] ?? 0) + n;
  return out;
}

/**
 * Bearer check against the STATS_TOKEN secret.
 *
 * Compared as SHA-256 digests so the loop runs over fixed-length input and
 * cannot leak the token's length, and with a running OR so it does not return
 * early on the first differing byte.
 */
async function authorized(request, env) {
  const expected = env.STATS_TOKEN;
  if (!expected) return false;

  const header = request.headers.get('Authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented) return false;

  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}
