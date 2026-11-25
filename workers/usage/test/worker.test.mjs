// Tests for the usage report receiver, run against the real Worker on a
// local D1 (Miniflare): validation, de-duplication, the counting, the rate
// limit, the private stats, the daily pruning, and reports from the real
// client code, which must be taken whole. Run with: npm test (in workers/),
// after the main build (npm run build at the repository root).
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const repo = join(here, '..', '..');
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

function options(extra) {
  return convertV4MiniflareOptions({
    modules: true,
    scriptPath: join(here, 'src', 'worker.js'),
    compatibilityDate: '2025-11-01',
    d1Databases: { DB: 'local-test' },
    bindings: { STATS_TOKEN: 'test-stats-token' },
    ratelimits: { REPORT_LIMIT: { namespace_id: '2002', simple: { limit: 1000, period: 60 } } },
    ...extra,
  });
}

async function start(extra = {}) {
  const mf = new Miniflare(options(extra));
  const db = await mf.getD1Database('DB');
  for (const statement of migration) await db.prepare(statement).run();
  return { mf, db };
}

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const hex = (n) => n.toString(16).padStart(32, '0');
let next = 1;
const report = (extra = {}) => ({
  s: 1,
  day: today,
  nonce: hex(next++),
  v: '0.11.0',
  os: 'windows',
  arch: 'x64',
  node: '22',
  app: 'claude-desktop',
  install: 'npx',
  ctx: 'default',
  opa: 'path',
  opa_v: '1.22',
  regal: '0.43',
  conftest: 'missing',
  files: 'roots',
  settings: ['OPA_URL', 'OPA_TOKEN'],
  age: '8-30',
  first: { week: true, month: false, ever: false },
  days: [
    {
      d: daysAgo(1),
      tools: { rego_eval: '10-99', rego_test: '1-9' },
      failures: { 'rego_eval|EVAL_ERROR': '1-9', 'rego_test|OPA_BINARY_NOT_FOUND': '1-9' },
      crashes: { 'rego_test|TypeError@lib/opa-cli.js:212': '1-9' },
      apps: ['claude-desktop'],
    },
  ],
  ...extra,
});

const { mf, db } = await start();
const PATH = '/opa-mcp/v1/report';
const send = (body, headers = {}, path = PATH) =>
  mf.dispatchFetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    cf: { country: 'DE' },
  });
const count = async (day, metric, key = '') =>
  (
    await db
      .prepare('SELECT n FROM daily WHERE day = ?1 AND metric = ?2 AND key = ?3')
      .bind(day, metric, key)
      .first()
  )?.n ?? 0;
const rowsLike = async (pattern) =>
  (await db.prepare('SELECT COUNT(*) AS c FROM daily WHERE key LIKE ?1').bind(pattern).first()).c;
const logRows = async () => (await db.prepare('SELECT COUNT(*) AS c FROM log').first()).c;

try {
  // A good report.
  const first = report();
  let res = await send(first);
  check(res.status === 204, `a report is taken (${res.status})`);
  check(
    (await count(today, 'reports')) === 1 &&
      (await count(today, 'version', '0.11.0')) === 1 &&
      (await count(today, 'os', 'windows')) === 1 &&
      (await count(today, 'arch', 'x64')) === 1 &&
      (await count(today, 'node', '22')) === 1 &&
      (await count(today, 'app', 'claude-desktop')) === 1 &&
      (await count(today, 'install', 'npx')) === 1 &&
      (await count(today, 'country', 'DE')) === 1,
    'it counts as one report today, by version, platform, app, install and country',
  );
  check(
    (await count(today, 'opa', 'path|1.22')) === 1 &&
      (await count(today, 'regal', '0.43')) === 1 &&
      (await count(today, 'conftest', 'missing')) === 1 &&
      (await count(today, 'files', 'roots')) === 1 &&
      (await count(today, 'setting', 'OPA_URL')) === 1 &&
      (await count(today, 'setting', 'OPA_TOKEN')) === 1 &&
      (await count(today, 'age', '8-30')) === 1,
    'and by the binaries it found, where files come from, and the settings changed',
  );
  check(
    (await count(today, 'first_week', 'default')) === 1 &&
      (await count(today, 'first_month', 'default')) === 0 &&
      (await count(today, 'first_ever', 'default')) === 0,
    'the first-of flags count only when set',
  );
  const y = daysAgo(1);
  check(
    (await count(y, 'active')) === 1 &&
      (await count(y, 'tool', 'rego_eval|10-99')) === 1 &&
      (await count(y, 'tool', 'rego_test|1-9')) === 1 &&
      (await count(y, 'failure', 'rego_eval|EVAL_ERROR|1-9')) === 1 &&
      (await count(y, 'failure', 'rego_test|OPA_BINARY_NOT_FOUND|1-9')) === 1 &&
      (await count(y, 'crash', 'rego_test|TypeError@lib/opa-cli.js:212|1-9')) === 1 &&
      (await count(y, 'active_app', 'claude-desktop')) === 1,
    "yesterday's counts go under yesterday",
  );
  const logged = await db.prepare('SELECT body FROM log').first();
  check(
    (await logRows()) === 1 &&
      !logged.body.includes('203.0.113.7') &&
      !logged.body.includes(first.nonce) &&
      JSON.parse(logged.body).country === 'DE',
    'the log keeps the report without its address or number',
  );

  // The same report again counts once.
  res = await send(first);
  check(
    res.status === 204 &&
      (await count(today, 'reports')) === 1 &&
      (await count(y, 'tool', 'rego_eval|10-99')) === 1 &&
      (await logRows()) === 1,
    'the same report sent again is counted once',
  );
  await send(report());
  check(
    (await count(today, 'reports')) === 2 && (await count(y, 'tool', 'rego_eval|10-99')) === 2,
    "another install's report adds to the counts",
  );

  // Values outside the lists.
  await send(
    report({
      v: '1.2',
      os: 'plan9',
      arch: 'mips',
      node: '22.1.0',
      app: '<script>',
      install: 'evil',
      ctx: 'space',
      opa: 'stolen',
      opa_v: '/usr/bin/opa',
      regal: 'C:\\Users\\someone',
      conftest: 7,
      files: '/etc/passwd',
      settings: ['OPA_TOKEN=hunter2', 'HOME', 42, 'OPA_URL', 'OPA_URL'],
      age: 'old',
      first: 'yes',
    }),
  );
  check(
    (await count(today, 'version', 'other')) === 1 &&
      (await count(today, 'os', 'other')) === 1 &&
      (await count(today, 'arch', 'other')) === 1 &&
      (await count(today, 'node', 'other')) === 1 &&
      (await count(today, 'app', 'other')) === 1 &&
      (await count(today, 'install', 'other')) === 1 &&
      (await count(today, 'ctx', 'other')) === 1 &&
      (await count(today, 'opa', 'other|unknown')) === 1 &&
      (await count(today, 'regal', 'unknown')) === 1 &&
      (await count(today, 'conftest', 'unknown')) === 1 &&
      (await count(today, 'files', 'other')) === 1 &&
      (await count(today, 'age', 'other')) === 1,
    'values outside the lists are counted as other or unknown',
  );
  check(
    (await count(today, 'setting', 'OPA_URL')) === 3 &&
      (await rowsLike('%hunter2%')) === 0 &&
      (await rowsLike('HOME')) === 0,
    'only documented setting names are kept, each once',
  );
  check(
    (await rowsLike('%script%')) === 0 &&
      (await rowsLike('%evil%')) === 0 &&
      (await rowsLike('%plan9%')) === 0 &&
      (await rowsLike('%someone%')) === 0 &&
      (await rowsLike('%passwd%')) === 0,
    'and nothing is stored as sent',
  );

  await send(
    report({
      days: [
        {
          d: daysAgo(2),
          tools: {
            'DROP TABLE x': '1-9',
            bad_band: '999',
            rego_fine: '1-9',
            other: '1-9',
            ['rego_' + 'a'.repeat(60)]: '1-9',
            eval: '1-9',
          },
          failures: {
            'rego_fine|EVAL_ERROR': '1-9',
            'rego_fine|NOT_A_CODE': '1-9',
            'rego_fine|EVAL_ERROR|extra': '1-9',
            'evil|EVAL_ERROR': '1-9',
            'other|UNKNOWN_TOOL': '1-9',
          },
          crashes: {
            'rego_fine|external': '1-9',
            'rego_fine|TypeError@/home/someone/x.js:1': '1-9',
            'rego_fine|Error@lib/x.js': '1-9',
            'rego_fine|lowercase@lib/x.js:1': '1-9',
          },
          apps: ['evil', 'cursor'],
        },
        { d: daysAgo(2), tools: { rego_twice: '1-9' } },
        { d: daysAgo(-5), tools: { rego_future: '1-9' } },
        { d: daysAgo(100), tools: { rego_ancient: '1-9' } },
        { d: 'yesterday', tools: { rego_words: '1-9' } },
      ],
    }),
  );
  const d2 = daysAgo(2);
  check(
    (await count(d2, 'tool', 'rego_fine|1-9')) === 1 &&
      (await count(d2, 'tool', 'other|1-9')) === 1 &&
      (await rowsLike('DROP%')) === 0 &&
      (await rowsLike('bad_band%')) === 0 &&
      (await rowsLike('rego_aaaa%')) === 0 &&
      (await rowsLike('eval|%')) === 0 &&
      (await rowsLike('rego_twice%')) === 0 &&
      (await rowsLike('rego_future%')) === 0 &&
      (await rowsLike('rego_ancient%')) === 0 &&
      (await rowsLike('rego_words%')) === 0,
    'tool names, bands and days outside the rules are dropped',
  );
  check(
    (await count(d2, 'failure', 'rego_fine|EVAL_ERROR|1-9')) === 1 &&
      (await count(d2, 'failure', 'other|UNKNOWN_TOOL|1-9')) === 1 &&
      (await db
        .prepare("SELECT COUNT(*) AS c FROM daily WHERE day = ?1 AND metric = 'failure'")
        .bind(d2)
        .first()
        .then((r) => r.c)) === 2,
    'failures keep only a known tool and a known code',
  );
  check(
    (await count(d2, 'crash', 'rego_fine|external|1-9')) === 1 &&
      (await db
        .prepare("SELECT COUNT(*) AS c FROM daily WHERE day = ?1 AND metric = 'crash'")
        .bind(d2)
        .first()
        .then((r) => r.c)) === 1,
    'crash sites keep only a file under the server and its line, never a full path',
  );
  check(
    (await count(d2, 'active_app', 'other')) === 1 &&
      (await count(d2, 'active_app', 'cursor')) === 1,
    'and unknown apps count as other',
  );
  const many = Array.from({ length: 12 }, (_, i) => ({
    d: daysAgo(i + 3),
    tools: { rego_many_days: '1-9' },
  }));
  await send(report({ days: many }));
  check((await rowsLike('rego_many_days|1-9')) === 7, 'at most seven days per report');
  const wide = {
    d: daysAgo(20),
    tools: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`rego_w${i}`, '1-9'])),
    failures: Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [`rego_w${i}|EVAL_ERROR`, '1-9']),
    ),
    crashes: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`rego_w${i}|Error@lib/x.js:${i + 1}`, '1-9']),
    ),
    apps: Array.from({ length: 30 }, () => 'zed'),
  };
  await send(report({ days: [wide] }));
  const metricRows = async (day, metric) =>
    (
      await db
        .prepare('SELECT COUNT(*) AS c FROM daily WHERE day = ?1 AND metric = ?2')
        .bind(day, metric)
        .first()
    ).c;
  check(
    (await metricRows(daysAgo(20), 'tool')) === 80 &&
      (await metricRows(daysAgo(20), 'failure')) === 100 &&
      (await metricRows(daysAgo(20), 'crash')) === 20 &&
      (await metricRows(daysAgo(20), 'active_app')) === 1,
    'a day keeps at most 80 tools, 100 failures, 20 crash sites, and each app once',
  );

  // Reports that are not reports.
  check((await send('{not json')).status === 400, 'not JSON: 400');
  check((await send({ ...report(), nonce: 'short' })).status === 400, 'no proper number: 400');
  check(
    (await send({ ...report(), nonce: 'G'.repeat(32) })).status === 400,
    'a number not in hex: 400',
  );
  check((await send({ ...report(), s: 2 })).status === 400, 'an unknown schema: 400');
  check((await send([1, 2])).status === 400, 'a list: 400');
  check((await send({ ...report(), pad: 'x'.repeat(70_000) })).status === 413, 'too large: 413');
  // A week of every tool failing in every way the client caps at.
  const heavy = report({
    days: Array.from({ length: 7 }, (_, i) => ({
      d: daysAgo(i + 30),
      tools: Object.fromEntries(
        Array.from({ length: 80 }, (_, t) => [`rego_tool_name_${t}`, '10-99']),
      ),
      failures: Object.fromEntries(
        Array.from({ length: 100 }, (_, t) => [
          `rego_tool_name_${t % 80}|INVALID_ARGUMENTS`,
          '10-99',
        ]),
      ),
      crashes: Object.fromEntries(
        Array.from({ length: 20 }, (_, t) => [
          `rego_tool_name_${t}|ReferenceError@tools/helpers/policy-diff.js:${10000 + t}`,
          '1-9',
        ]),
      ),
      apps: ['cursor', 'claude-code', 'vscode'],
    })),
  });
  const heavyBody = JSON.stringify(heavy);
  res = await send(heavyBody);
  check(
    heavyBody.length < 64 * 1024 &&
      res.status === 204 &&
      (await count(daysAgo(36), 'tool', 'rego_tool_name_79|10-99')) === 1,
    `the heaviest week the client sends fits and is counted (${heavyBody.length} bytes)`,
  );

  // Development.
  const before = await count(today, 'reports');
  await send(report({ install: 'source' }));
  check(
    (await count(today, 'reports')) === before && (await count(today, 'dev_reports')) === 1,
    'a report from a source checkout is counted apart, and nowhere else',
  );

  // The private stats.
  const get = (path, headers = {}) => mf.dispatchFetch(`http://localhost${path}`, { headers });
  const auth = { authorization: 'Bearer test-stats-token' };
  check(
    (await get('/opa-mcp/v1/stats')).status === 404 &&
      (await get('/opa-mcp/v1/stats', { authorization: 'Bearer wrong-token-xxxxxx' })).status ===
        404 &&
      (await get('/opa-mcp/v1/log')).status === 404,
    'stats and log without the token: not found',
  );
  res = await get('/opa-mcp/v1/stats?days=7', auth);
  const body = await res.json();
  check(
    res.status === 200 &&
      body.perDay[today].reports >= 4 &&
      body.perDay[today].dev_reports === 1 &&
      body.perDay[y].active >= 2 &&
      body.totals.tool['rego_eval|10-99'] >= 2 &&
      body.totals.failure['rego_eval|EVAL_ERROR|1-9'] >= 2 &&
      body.rows === undefined,
    'stats with the token: the counts per day and over the span',
  );
  const firstsBefore = body.perDay[today];
  await send(report({ ctx: 'container', first: { week: true, month: true, ever: true } }));
  await send(report({ ctx: 'space', first: { week: false, month: false, ever: true } }));
  const firstsAfter = (await (await get('/opa-mcp/v1/stats?days=1', auth)).json()).perDay[today];
  check(
    firstsAfter.first_ever === firstsBefore.first_ever &&
      firstsAfter.first_ever_container === firstsBefore.first_ever_container + 2 &&
      firstsAfter.first_week_container === firstsBefore.first_week_container + 1,
    'a container new on every run is counted apart from new installs',
  );
  const withRows = await (await get('/opa-mcp/v1/stats?days=2&rows=1', auth)).json();
  check(
    Array.isArray(withRows.rows) &&
      withRows.rows.some((r) => r.metric === 'version' && r.key === '0.11.0' && r.day === today),
    'and every row as stored, when asked',
  );
  const recent = await (await get('/opa-mcp/v1/log?hours=1', auth)).json();
  check(
    recent.reports.length >= 5 &&
      recent.reports.every((r) => r.nonce === undefined && typeof r.ts === 'string'),
    'the log, with the token: recent reports, without their numbers',
  );
  check(
    (await get('/opa-mcp/v1/report')).status === 404 &&
      (await get('/nothing')).status === 404 &&
      (await send(report(), {}, '/v1/report')).status === 404 &&
      (await send(report(), {}, '/discord-mcp/v1/ping')).status === 404 &&
      (await send(report(), {}, '/ping')).status === 404,
    'anything else: not found',
  );
  const closed = await start({ bindings: {} });
  check(
    (
      await closed.mf.dispatchFetch('http://localhost/opa-mcp/v1/stats', {
        headers: { authorization: 'Bearer ' },
      })
    ).status === 404,
    'with no token set, stats stay closed',
  );
  await closed.mf.dispose();

  // The rate limit, from one address.
  const limited = await start({
    ratelimits: { REPORT_LIMIT: { namespace_id: '2002', simple: { limit: 3, period: 60 } } },
  });
  const burst = [];
  for (let i = 0; i < 5; i += 1) {
    burst.push(
      (
        await limited.mf.dispatchFetch(`http://localhost${PATH}`, {
          method: 'POST',
          headers: { 'cf-connecting-ip': '198.51.100.9' },
          body: JSON.stringify(report()),
        })
      ).status,
    );
  }
  const counted =
    (
      await limited.db
        .prepare("SELECT n FROM daily WHERE day = ?1 AND metric = 'reports'")
        .bind(today)
        .first()
    )?.n ?? 0;
  check(
    burst.every((s) => s === 204) && counted === 3,
    `past the limit, reports are answered but not counted (${counted} of 5)`,
  );
  await limited.mf.dispose();

  // Daily pruning.
  await db
    .prepare("INSERT INTO nonces (nonce, seen, fresh) VALUES ('old', ?1, 0)")
    .bind(daysAgo(4))
    .run();
  await db
    .prepare("INSERT INTO log (ts, body) VALUES (?1, '{}')")
    .bind(new Date(Date.now() - 8 * 86_400_000).toISOString())
    .run();
  const worker = await mf.getWorker();
  await worker.scheduled({ scheduledTime: new Date(), cron: '41 3 * * *' });
  check(
    (await db.prepare("SELECT COUNT(*) AS c FROM nonces WHERE nonce = 'old'").first()).c === 0 &&
      (await db.prepare('SELECT COUNT(*) AS c FROM nonces').first()).c > 0,
    'numbers older than three days are forgotten, recent ones kept',
  );
  check(
    (
      await db
        .prepare('SELECT COUNT(*) AS c FROM log WHERE ts < ?1')
        .bind(new Date(Date.now() - 7 * 86_400_000).toISOString())
        .first()
    ).c === 0 && (await logRows()) > 0,
    'the log keeps seven days',
  );

  // Reports from the real client code, over HTTP.
  const served = new Miniflare(options({ d1Databases: { DB: 'local-client' }, port: 0 }));
  const url = (await served.ready).toString().replace(/\/$/, '');
  const sdb = await served.getD1Database('DB');
  for (const statement of migration) await sdb.prepare(statement).run();
  const dist = (p) => pathToFileURL(join(repo, 'dist', p)).href;
  const usageReport = await import(dist('lib/usage-report.js'));
  const usageStats = await import(dist('lib/usage-stats.js'));
  const { CALL_CODES } = await import(dist('lib/usage-observer.js'));
  const { TOOL_ERROR_CODES } = await import(dist('types.js'));
  const { buildServer } = await import(dist('server.js'));
  const { toolNames } = await import(dist('tools/index.js'));
  const { loadConfig } = await import(dist('config.js'));
  const kept = async (day, metric, key) =>
    ((
      await sdb
        .prepare('SELECT n FROM daily WHERE day = ?1 AND metric = ?2 AND key = ?3')
        .bind(day, metric, key)
        .first()
    )?.n ?? 0) > 0;

  const names = [...toolNames(buildServer(loadConfig()))];
  const codes = [...TOOL_ERROR_CODES, ...CALL_CODES];
  const apps = usageStats.APP_NAMES;
  check(
    names.length >= 50 && codes.length > 30 && apps.length > 15,
    `the client's lists are there (${names.length} tools, ${codes.length} codes, ${apps.length} apps)`,
  );

  // Seven finished days in the client's own files: every tool, every code,
  // every app, and a crash site worked out from a real stack.
  const data = mkdtempSync(join(tmpdir(), 'opa-mcp-usage-client-'));
  const site = usageStats.crashSite(
    Object.assign(new TypeError('x'), {
      stack: `TypeError: x\n    at f (${join(repo, 'dist', 'lib', 'opa-cli.js')}:212:9)`,
    }),
  );
  const old = (Date.now() - 3_600_000) / 1000;
  for (let i = 0; i < 7; i += 1) {
    const file = join(data, `day-${daysAgo(i + 1)}-1-abcdef.json`);
    writeFileSync(
      file,
      JSON.stringify({
        tools:
          i === 0 ? Object.fromEntries([...names, 'other'].map((n) => [n, 3])) : { rego_eval: 1 },
        failures: i === 1 ? Object.fromEntries(codes.map((c) => [`rego_eval|${c}`, 1])) : {},
        crashes: i === 2 ? { [`rego_eval|${site}`]: 1, 'rego_test|external': 1 } : {},
        apps: apps.slice(i * 4, i * 4 + 4),
      }),
    );
    utimesSync(file, old, old);
  }
  usageStats.__testing.reset(data);
  usageReport.noteBinaryVersions({ opa: '1.22.4', regal: '0.43.0', conftest: '0.71.1' });
  const env = {
    OPA_MCP_TELEMETRY_URL: url,
    OPA_MCP_PACKAGING: 'docker',
    ...Object.fromEntries(usageReport.SETTINGS.map(([name]) => [name, 'set-by-test'])),
  };
  usageReport.__testing.use({ env }, { ...loadConfig(), allowedPaths: ['/x'] }, 'on');
  const outcome = await usageReport.sendIfDue();
  check(
    outcome === 'sent' && (await kept(today, 'install', 'docker')),
    `the client's own report is taken and counted (${outcome})`,
  );
  check(
    (await kept(today, 'opa', 'custom|1.22')) &&
      (await kept(today, 'regal', '0.43')) &&
      (await kept(today, 'conftest', '0.71')) &&
      (await kept(today, 'files', 'allowed_paths')) &&
      (await kept(today, 'ctx', 'container')) &&
      (await kept(today, 'node', process.versions.node.split('.')[0])),
    'with its binaries, files, context and Node.js version',
  );
  const lost = async (metric, keys, day = today) => {
    const out = [];
    for (const k of keys) if (!(await kept(day, metric, k))) out.push(k);
    return out;
  };
  const lostSettings = await lost(
    'setting',
    usageReport.SETTINGS.map(([n]) => n),
  );
  check(
    lostSettings.length === 0,
    `the receiver knows every setting the client names (not kept: ${lostSettings.join(', ') || 'none'})`,
  );
  const lostTools = await lost(
    'tool',
    [...names, 'other'].map((n) => `${n}|1-9`),
    daysAgo(1),
  );
  check(
    lostTools.length === 0,
    `and every tool name (${names.length}; not kept: ${lostTools.join(', ') || 'none'})`,
  );
  const lostCodes = await lost(
    'failure',
    codes.map((c) => `rego_eval|${c}|1-9`),
    daysAgo(2),
  );
  check(
    lostCodes.length === 0,
    `and every error code (${codes.length}; not kept: ${lostCodes.join(', ') || 'none'})`,
  );
  const crashKept = await kept(daysAgo(3), 'crash', `rego_eval|${site}|1-9`);
  check(
    site === 'TypeError@lib/opa-cli.js:212' &&
      crashKept &&
      (await kept(daysAgo(3), 'crash', 'rego_test|external|1-9')),
    `and a crash site (${site})`,
  );
  const lostApps = [];
  for (const app of apps) {
    let found = false;
    for (let i = 1; i <= 7; i += 1) if (await kept(daysAgo(i), 'active_app', app)) found = true;
    if (!found) lostApps.push(app);
  }
  check(
    lostApps.length === 0 &&
      !(await kept(daysAgo(1), 'active_app', 'other')) === !apps.slice(0, 4).includes('other'),
    `and every app (${apps.length}; not kept: ${lostApps.join(', ') || 'none'})`,
  );
  rmSync(data, { recursive: true, force: true });

  // Every install kind the client can send is one the receiver keeps.
  for (const install of usageReport.INSTALL_KINDS) {
    await served.dispatchFetch(`http://localhost${PATH}`, {
      method: 'POST',
      body: JSON.stringify({ ...report(), install }),
    });
  }
  const lostKinds = (
    await lost(
      'install',
      usageReport.INSTALL_KINDS.filter((k) => k !== 'source'),
    )
  ).concat(
    (await sdb.prepare("SELECT n FROM daily WHERE metric = 'dev_reports'").first())?.n
      ? []
      : ['source'],
  );
  check(
    lostKinds.length === 0 && !(await kept(today, 'install', 'other')),
    `and every install kind (not kept: ${lostKinds.join(', ') || 'none'})`,
  );
  usageReport.__testing.reset();
  usageStats.__testing.reset();
  await served.dispose();
} finally {
  await mf.dispose();
}

if (failures > 0) {
  console.error(`\nusage receiver: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nusage receiver: all passed');
