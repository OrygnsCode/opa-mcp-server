// Prints the usage stats. The token is the receiver's STATS_TOKEN secret,
// given in the environment or as a file (by default
// ~/.orygn/opa-mcp-usage-token):
//   node usage/stats.mjs [days]
//   STATS_TOKEN_FILE=path node usage/stats.mjs [days]
//   STATS_URL=http://127.0.0.1:8787 node usage/stats.mjs   (a local receiver)
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const days = Number(process.argv[2] ?? 30);
const base = (process.env.STATS_URL ?? 'https://telemetry.orygn.tech').replace(/\/+$/, '');
const tokenFile = process.env.STATS_TOKEN_FILE ?? join(homedir(), '.orygn', 'opa-mcp-usage-token');
const token =
  process.env.STATS_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
if (!token) {
  console.error('Set STATS_TOKEN, or STATS_TOKEN_FILE, or put the token in ' + tokenFile);
  process.exit(1);
}
const res = await fetch(`${base}/opa-mcp/v1/stats?days=${days}`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`The receiver answered ${res.status}.`);
  process.exit(1);
}
const { from, perDay, totals } = await res.json();

console.log(`Since ${from}\n`);
console.log(
  'day          reports  new  first-of-week  first-of-month  active  dev  new-in-container',
);
for (const [day, d] of Object.entries(perDay)) {
  console.log(
    `${day}  ${String(d.reports).padStart(7)}  ${String(d.first_ever).padStart(3)}  ${String(d.first_week).padStart(13)}  ${String(d.first_month).padStart(14)}  ${String(d.active).padStart(6)}  ${String(d.dev_reports).padStart(3)}  ${String(d.first_ever_container).padStart(16)}`,
  );
}
const sum = (key) => Object.values(perDay).reduce((n, d) => n + d[key], 0);
console.log(`\nInstalls active in the span (first-of-month, summed): ${sum('first_month')}`);
console.log(`New installs: ${sum('first_ever')}`);
// A container started fresh each time (docker run --rm) is new on every run.
console.log(`Container runs with no earlier state: ${sum('first_ever_container')}\n`);

const show = (title, entries, limit = 15) => {
  const list = Object.entries(entries ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (list.length === 0) return;
  console.log(title);
  for (const [k, n] of list) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log('');
};
for (const metric of [
  'version',
  'app',
  'install',
  'os',
  'arch',
  'node',
  'ctx',
  'country',
  'opa',
  'regal',
  'conftest',
  'files',
  'setting',
  'age',
  'active_app',
]) {
  show(metric, totals[metric]);
}

// Tools and failures: install-days, whatever the band.
const byFirst = (metric, parts) => {
  const out = {};
  for (const [key, n] of Object.entries(totals[metric] ?? {})) {
    const k = key.split('|').slice(0, parts).join('|');
    out[k] = (out[k] ?? 0) + n;
  }
  return out;
};
show('tools (install-days)', byFirst('tool', 1), 60);
show('failures by code (install-days)', byFirst('failure', 2), 40);
show('crashes by site (install-days)', byFirst('crash', 2), 40);
