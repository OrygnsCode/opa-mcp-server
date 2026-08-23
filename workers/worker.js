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
      const dauKey = u && UUID_RE.test(u) ? `dau:${today}:${u}` : null;

      // An install pings on every server start, and each ping used to cost six
      // KV writes. A client stuck in a restart loop could therefore spend the
      // whole daily free-tier write budget by itself, which is exactly what
      // happened on 2026-08-16 (one install, ~142 pings, ~870 writes).
      //
      // Count each install once per UTC day instead, so write cost tracks the
      // number of installs rather than the number of restarts. Repeat pings
      // from an install already counted today cost one read and no writes.
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
