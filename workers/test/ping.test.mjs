// Tests for the ping receiver, run against the real Worker on a local D1
// (Miniflare): what counts as an install, what counts as a crawler, and what
// the private stats return. Run with: npm test (in workers/).
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
function check(condition, label) {
  if (condition) console.log(`ok: ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

const migration = readFileSync(join(here, 'migrations', '0001_init.sql'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

async function start(bindings = { STATS_TOKEN: 'test-stats-token' }, limit = 1000) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: join(here, 'worker.js'),
      compatibilityDate: '2025-01-01',
      d1Databases: { DB: 'local-test' },
      bindings,
      ratelimits: { PING_LIMIT: { namespace_id: '2001', simple: { limit, period: 60 } } },
    }),
  );
  const db = await mf.getD1Database('DB');
  for (const statement of migration) await db.prepare(statement).run();
  return { mf, db };
}

const today = new Date().toISOString().slice(0, 10);
const FACEBOOK = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
let next = 1;
const uuid = () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;

const { mf, db } = await start();
const ping = (query, userAgent, address = '203.0.113.7') =>
  mf.dispatchFetch(`http://localhost/ping?${new URLSearchParams(query)}`, {
    headers: {
      'cf-connecting-ip': address,
      ...(userAgent === undefined ? {} : { 'user-agent': userAgent }),
    },
  });
const installs = async () => (await db.prepare('SELECT COUNT(*) AS c FROM installs').first()).c;
const daily = async (context) =>
  (
    await db
      .prepare(
        'SELECT COALESCE(SUM(pings), 0) AS n FROM daily_pings WHERE date = ?1 AND context = ?2',
      )
      .bind(today, context)
      .first()
  ).n;
const lastLog = async () =>
  db
    .prepare('SELECT context, id_state, user_agent FROM ping_log ORDER BY rowid DESC LIMIT 1')
    .first();
const active = async () =>
  (await db
    .prepare('SELECT active_installs, new_installs FROM daily_installs WHERE date = ?1')
    .bind(today)
    .first()) ?? {
    active_installs: 0,
    new_installs: 0,
  };

try {
  // A real client: Node's fetch sends "node".
  const id = uuid();
  let res = await ping({ v: '0.10.0', p: 'win32', u: id }, 'node');
  check(res.status === 200, `a client ping is answered (${res.status})`);
  check(
    (await installs()) === 1 && (await active()).new_installs === 1,
    'a client with a new ID is a new install',
  );
  check(
    (await lastLog()).id_state === 'new' && (await lastLog()).context === 'default',
    'and is logged as new',
  );
  await ping({ v: '0.10.0', p: 'win32', u: id }, 'node');
  check(
    (await installs()) === 1 && (await lastLog()).id_state === 'repeat',
    'the same install again today is a repeat',
  );

  // Older Node releases send "undici".
  await ping({ v: '0.3.0', p: 'linux', u: uuid() }, 'undici');
  check(
    (await installs()) === 2 && (await lastLog()).id_state === 'new',
    'a client sending "undici" counts too',
  );

  // Facebook's link-preview crawler, with a fresh ID as it sends.
  const before = { installs: await installs(), active: await active() };
  res = await ping({ v: '0.4.0', p: 'linux', u: uuid() }, FACEBOOK);
  const logged = await lastLog();
  check(res.status === 200, `a crawler is answered like a client (${res.status})`);
  check((await installs()) === before.installs, 'a crawler with an ID never becomes an install');
  check(
    (await active()).active_installs === before.active.active_installs &&
      (await active()).new_installs === before.active.new_installs,
    "and adds nothing to the day's installs",
  );
  check(
    logged.context === 'crawler' && logged.id_state === 'crawler',
    `and is logged as a crawler (${JSON.stringify(logged)})`,
  );
  check((await daily('crawler')) === 1, 'it is counted under the context "crawler"');

  // A crawler fetching the CI form of the URL, a browser, and no user agent at all.
  await ping({ v: '0.9.1', p: 'linux', c: 'ci' }, FACEBOOK);
  await ping({ v: '0.9.1', p: 'darwin', u: uuid() }, BROWSER);
  await ping({ v: '0.9.1', p: 'darwin', u: uuid() }, '');
  await ping({ v: '0.9.1', p: 'darwin', u: uuid() }, 'nodejs-scanner/2');
  await ping({ v: '0.9.1', p: 'darwin', u: uuid() }, 'Mozilla/5.0 node');
  check(
    (await installs()) === before.installs && (await daily('crawler')) === 6,
    'browsers, empty and look-alike agents are crawlers too',
  );
  check((await daily('ci')) === 0, 'a crawler fetching a CI ping is not counted as CI');

  // A client in CI still counts as CI, never as an install.
  await ping({ v: '0.9.1', p: 'linux', c: 'ci' }, 'node');
  check(
    (await daily('ci')) === 1 && (await lastLog()).id_state === 'ignored',
    'a client in CI is counted as CI and ignored for installs',
  );

  // What the stats say.
  const get = (path, headers = {}) => mf.dispatchFetch(`http://localhost${path}`, { headers });
  const auth = { authorization: 'Bearer test-stats-token' };
  check(
    (await get('/stats')).status === 404 &&
      (await get('/stats', { authorization: 'Bearer wrong' })).status === 404,
    'stats without the token: not found',
  );
  const stats = await (await get('/stats', auth)).json();
  // Client pings so far: 2 (0.10.0) + 1 (0.3.0) + 1 (0.9.1 in CI) = 4; crawler pings: 6.
  check(stats.total === 4, `the total leaves crawlers out (${stats.total})`);
  check(stats.today.total === 4, `so does today's total (${stats.today.total})`);
  check(
    stats.versions['0.4.0'] === undefined &&
      stats.versions['0.10.0'] === 2 &&
      stats.versions['0.9.1'] === 1,
    `versions count clients only (${JSON.stringify(stats.versions)})`,
  );
  check(
    stats.platforms.darwin === undefined && stats.platforms.win32 === 2,
    `platforms count clients only (${JSON.stringify(stats.platforms)})`,
  );
  check(
    stats.contexts.crawler === 6 && stats.contexts.default === 3 && stats.contexts.ci === 1,
    `contexts show the crawlers (${JSON.stringify(stats.contexts)})`,
  );
  check(
    stats.installs === 2 && stats.today.new === 2,
    `installs: 2, both new today (${stats.installs}, ${stats.today.new})`,
  );
  const history = await (await get('/stats/history?days=2', auth)).json();
  const row = history.history.find((r) => r.date === today);
  check(
    row.total === 4 &&
      row['c:crawler'] === 6 &&
      row['v:0.4.0'] === undefined &&
      row['installs:new'] === 2,
    `history keeps crawlers apart (${JSON.stringify(row)})`,
  );
  const log = await (await get('/stats/log?hours=1', auth)).json();
  check(
    log.rows.filter((r) => r.id_state === 'crawler').length === 6,
    'the log marks each crawler ping',
  );

  // The daily pruning still runs.
  await db
    .prepare(
      "INSERT INTO ping_log (ts, version, platform, context, id_state, user_agent) VALUES ('2000-01-01T00:00:00.000Z', '0.1.0', 'linux', 'crawler', 'crawler', 'x')",
    )
    .run();
  const worker = await mf.getWorker();
  await worker.scheduled({ scheduledTime: new Date(), cron: '17 3 * * *' });
  check(
    (await db.prepare("SELECT COUNT(*) AS c FROM ping_log WHERE ts < '2001-01-01'").first()).c ===
      0,
    'old log rows are pruned',
  );
} finally {
  await mf.dispose();
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
