export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ping') {
      const v = url.searchParams.get('v') ?? 'unknown';
      const p = url.searchParams.get('p') ?? 'unknown';

      await Promise.all([
        increment(env.TELEMETRY, 'total'),
        increment(env.TELEMETRY, `v:${v}`),
        increment(env.TELEMETRY, `p:${p}`),
      ]);

      return new Response('ok', { status: 200 });
    }

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

    return new Response('not found', { status: 404 });
  },
};

async function increment(kv, key) {
  const current = parseInt((await kv.get(key)) ?? '0');
  await kv.put(key, String(current + 1));
}
