const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── /ping ─────────────────────────────────────────────────────────────
    if (url.pathname === '/ping') {
      const v = url.searchParams.get('v') ?? 'unknown';
      const p = url.searchParams.get('p') ?? 'unknown';
      const u = url.searchParams.get('u') ?? null;
      const today = utcDate();

      // Always-on: cumulative counters (existing behaviour) + daily buckets.
      const writes = [
        increment(env.TELEMETRY, 'total'),
        increment(env.TELEMETRY, `v:${v}`),
        increment(env.TELEMETRY, `p:${p}`),
        increment(env.TELEMETRY, `day:${today}:total`),
        increment(env.TELEMETRY, `day:${today}:v:${v}`),
        increment(env.TELEMETRY, `day:${today}:p:${p}`),
      ];

      // UUID-gated: unique install tracking + daily active uniques.
      if (u && UUID_RE.test(u)) {
        // First-seen detection: uid:<uuid> is written once and never updated.
        const firstSeen = await env.TELEMETRY.get(`uid:${u}`);
        if (!firstSeen) {
          writes.push(
            env.TELEMETRY.put(`uid:${u}`, today),
            increment(env.TELEMETRY, 'installs:total'),
            increment(env.TELEMETRY, `day:${today}:installs:new`),
          );
        }

        // Daily active unique: one key per UUID per day, expires after 8 days.
        const dauKey = `dau:${today}:${u}`;
        const dauSeen = await env.TELEMETRY.get(dauKey);
        if (!dauSeen) {
          writes.push(
            env.TELEMETRY.put(dauKey, '1', { expirationTtl: 8 * 24 * 60 * 60 }),
            increment(env.TELEMETRY, `day:${today}:dau`),
          );
        }
      }

      await Promise.all(writes);
      return new Response('ok', { status: 200 });
    }

    // ── /stats ────────────────────────────────────────────────────────────
    // Cumulative totals (backwards-compatible with the original endpoint).
    if (url.pathname === '/stats') {
      const list = await env.TELEMETRY.list();
      const out = {};
      await Promise.all(
        list.keys.map(async ({ name }) => {
          out[name] = parseInt((await env.TELEMETRY.get(name)) ?? '0');
        }),
      );
      return Response.json(out);
    }

    // ── /stats/history ────────────────────────────────────────────────────
    // Daily breakdown for the last N days (default 30, max 90).
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
    // Quick summary of unique install counts.
    if (url.pathname === '/stats/installs') {
      const today = utcDate();
      const [total, newToday, dauToday] = await Promise.all([
        env.TELEMETRY.get('installs:total').then((v) => parseInt(v ?? '0')),
        env.TELEMETRY.get(`day:${today}:installs:new`).then((v) => parseInt(v ?? '0')),
        env.TELEMETRY.get(`day:${today}:dau`).then((v) => parseInt(v ?? '0')),
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
