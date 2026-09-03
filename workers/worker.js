const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── /ping ─────────────────────────────────────────────────────────────
    // Stays open, and must. Every published version calls it, including
    // releases that can no longer be updated.
    if (url.pathname === '/ping') {
      const v = url.searchParams.get('v') ?? 'unknown';
      const p = url.searchParams.get('p') ?? 'unknown';
      const u = url.searchParams.get('u') ?? null;
      const today = utcDate();
      const dauKey = u && UUID_RE.test(u) ? `dau:${today}:${u}` : null;

      // An install pings on every server start, and each ping used to cost six
      // writes. Counting each install once per UTC day instead makes write cost
      // track the number of installs rather than the number of restarts, so a
      // client in a restart loop no longer multiplies it.
      //
      // Pings without a usable install id cannot be de-duplicated, so they are
      // still counted per ping. Those are rare and come from very old clients.
      if (dauKey && (await env.TELEMETRY.get(dauKey))) {
        return new Response('ok', { status: 200 });
      }

      const writes = [
        increment(env.TELEMETRY, 'total'),
        increment(env.TELEMETRY, `v:${v}`),
        increment(env.TELEMETRY, `p:${p}`),
        increment(env.TELEMETRY, `day:${today}:total`),
        increment(env.TELEMETRY, `day:${today}:v:${v}`),
        increment(env.TELEMETRY, `day:${today}:p:${p}`),
      ];

      if (dauKey) {
        // Reaching here means this is the install's first ping of the day.
        writes.push(
          env.TELEMETRY.put(dauKey, '1', { expirationTtl: 8 * 24 * 60 * 60 }),
          increment(env.TELEMETRY, `day:${today}:dau`),
        );

        // First-seen detection: uid:<uuid> is written once and never updated.
        if (!(await env.TELEMETRY.get(`uid:${u}`))) {
          writes.push(
            env.TELEMETRY.put(`uid:${u}`, today),
            increment(env.TELEMETRY, 'installs:total'),
            increment(env.TELEMETRY, `day:${today}:installs:new`),
          );
        }
      }

      await Promise.all(writes);
      return new Response('ok', { status: 200 });
    }

    // ── everything below is private ───────────────────────────────────────
    // The read endpoints were open to the world. `/stats` listed the whole
    // namespace and returned it verbatim, which meant every `dau:<date>:<uuid>`
    // and `uid:<uuid>` key went with it: 322 install identifiers, each with the
    // days it was active. That is other people's data, and the aggregate
    // numbers alongside it are nobody's business either.
    //
    // A failed check answers 404, not 401, so the endpoints do not announce
    // themselves. An unset STATS_TOKEN denies everything: a deploy that lands
    // before the secret is set fails closed rather than open.
    if (!(await authorized(request, env))) {
      return new Response('not found', { status: 404 });
    }

    // ── /stats ────────────────────────────────────────────────────────────
    // Aggregates only, assembled from prefixed reads. Never an unprefixed
    // list(): that is what leaked the per-install keys, and it also cost about
    // a thousand reads per request, which anyone could trigger on repeat.
    if (url.pathname === '/stats') {
      const today = utcDate();
      const [total, installs, versions, platforms, dayTotal, dau, newToday] = await Promise.all([
        readInt(env.TELEMETRY, 'total'),
        readInt(env.TELEMETRY, 'installs:total'),
        readGroup(env.TELEMETRY, 'v:'),
        readGroup(env.TELEMETRY, 'p:'),
        readInt(env.TELEMETRY, `day:${today}:total`),
        readInt(env.TELEMETRY, `day:${today}:dau`),
        readInt(env.TELEMETRY, `day:${today}:installs:new`),
      ]);

      return Response.json({
        total,
        installs,
        versions,
        platforms,
        today: { date: today, total: dayTotal, dau, new: newToday },
      });
    }

    // ── /stats/history ────────────────────────────────────────────────────
    // Daily breakdown for the last N days (default 30, max 90). The `day:`
    // prefix carries no install ids, but the rows are still private.
    if (url.pathname === '/stats/history') {
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30'), 1), 90);
      const history = [];
      const base = new Date();

      for (let i = 0; i < days; i++) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() - i);
        const date = d.toISOString().slice(0, 10);
        const prefix = `day:${date}:`;
        const list = await env.TELEMETRY.list({ prefix });
        if (list.keys.length === 0) continue;

        const row = { date };
        await Promise.all(
          list.keys.map(async ({ name }) => {
            const field = name.slice(prefix.length);
            row[field] = parseInt((await env.TELEMETRY.get(name)) ?? '0');
          }),
        );
        history.push(row);
      }

      history.sort((a, b) => a.date.localeCompare(b.date));
      return Response.json({ history });
    }

    // ── /stats/installs ───────────────────────────────────────────────────
    // Counts of unique installs. Counts only, never the identifiers.
    if (url.pathname === '/stats/installs') {
      const today = utcDate();
      const [total, newToday, dauToday] = await Promise.all([
        readInt(env.TELEMETRY, 'installs:total'),
        readInt(env.TELEMETRY, `day:${today}:installs:new`),
        readInt(env.TELEMETRY, `day:${today}:dau`),
      ]);
      return Response.json({ total, newToday, dauToday });
    }

    return new Response('not found', { status: 404 });
  },
};

// ── helpers ───────────────────────────────────────────────────────────────

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

async function increment(kv, key) {
  const current = parseInt((await kv.get(key)) ?? '0');
  await kv.put(key, String(current + 1));
}

async function readInt(kv, key) {
  return parseInt((await kv.get(key)) ?? '0');
}

/**
 * Sum a prefixed family of counters into `{ suffix: count }`.
 *
 * Only `v:` and `p:` are passed in, and neither holds an install id. Callers
 * must never hand this an empty prefix: an unprefixed list is what exposed the
 * `dau:` and `uid:` keys.
 */
async function readGroup(kv, prefix) {
  if (!prefix) throw new Error('readGroup requires a prefix');
  const list = await kv.list({ prefix });
  const out = {};
  await Promise.all(
    list.keys.map(async ({ name }) => {
      out[name.slice(prefix.length)] = parseInt((await kv.get(name)) ?? '0');
    }),
  );
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
