import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../../../src/config.js';
import { SERVER_VERSION } from '../../../src/constants.js';
import {
  MAX_REPORT_BYTES,
  REPORT_PATH,
  __testing,
  ageBand,
  archName,
  backoffMs,
  collectDays,
  countBand,
  firstFlags,
  fitReport,
  installKind,
  minorVersion,
  nodeMajor,
  noteBinaryVersions,
  opaSource,
  osName,
  removeOldInstallId,
  runContext,
  sendIfDue,
  sendOutcome,
  settingsSet,
  type Report,
} from '../../../src/lib/usage-report.js';
import {
  __testing as stats,
  noteClient,
  noteToolCall,
  startCounting,
  utcDay,
} from '../../../src/lib/usage-stats.js';

describe('bands', () => {
  it('bands counts and ages', () => {
    expect([1, 9, 10, 99, 100, 5000].map(countBand)).toEqual([
      '1-9',
      '1-9',
      '10-99',
      '10-99',
      '100+',
      '100+',
    ]);
    expect([0, 1, 7, 8, 30, 31, 90, 91].map(ageBand)).toEqual([
      '0',
      '1-7',
      '1-7',
      '8-30',
      '8-30',
      '31-90',
      '31-90',
      '90+',
    ]);
  });
});

describe('where and how it runs', () => {
  it('names the OS, the architecture and the Node.js major version from fixed lists', () => {
    expect(['win32', 'darwin', 'linux', 'freebsd'].map((p) => osName(p))).toEqual([
      'windows',
      'macos',
      'linux',
      'other',
    ]);
    expect(['x64', 'arm64', 'ia32'].map((a) => archName(a))).toEqual(['x64', 'arm64', 'other']);
    expect(nodeMajor('22.12.0')).toBe('22');
    expect(nodeMajor('8.0.0')).toBe('other');
    expect(nodeMajor('garbage')).toBe('other');
  });

  it('tells how the package was installed from where it sits', () => {
    const cases: Array<[string, string]> = [
      ['/home/u/.npm/_npx/1a2b/node_modules/@orygn/opa-mcp', 'npx'],
      ['C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\@orygn\\opa-mcp', 'npx'],
      ['/opt/homebrew/lib/node_modules/@orygn/opa-mcp', 'global'],
      ['/home/u/.nvm/versions/node/v22.12.0/lib/node_modules/@orygn/opa-mcp', 'global'],
      ['C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@orygn\\opa-mcp', 'global'],
      [
        '/home/u/.local/share/pnpm/global/5/node_modules/.pnpm/@orygn+opa-mcp@0.11.0/node_modules/@orygn/opa-mcp',
        'global',
      ],
      [
        '/home/u/.cache/pnpm/dlx/abc/node_modules/.pnpm/@orygn+opa-mcp@0.11.0/node_modules/@orygn/opa-mcp',
        'dlx',
      ],
      ['/tmp/bunx-1000-@orygn/opa-mcp@latest/node_modules/@orygn/opa-mcp', 'dlx'],
      ['/home/u/project/node_modules/@orygn/opa-mcp', 'local'],
      ['/home/u/src/opa-mcp-server', 'source'],
    ];
    for (const [root, kind] of cases) expect(installKind({}, root), root).toBe(kind);
    expect(installKind({ OPA_MCP_PACKAGING: 'docker' }, '/app')).toBe('docker');
    expect(installKind({ OPA_MCP_PACKAGING: 'mcpb' }, '/x/server')).toBe('mcpb');
    expect(
      installKind(
        { OPA_MCP_PACKAGING: 'plugin' },
        '/home/u/.claude/plugins/cache/orygn/opa-mcp/0.11.1/node_modules/@orygn/opa-mcp',
      ),
    ).toBe('plugin');
  });

  it('notices a container', () => {
    const none = (): boolean => false;
    expect(runContext({}, 'linux', none)).toBe('default');
    expect(runContext({ OPA_MCP_PACKAGING: 'docker' }, 'win32', none)).toBe('container');
    expect(runContext({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, 'linux', none)).toBe('container');
    expect(runContext({}, 'linux', (p) => p === '/.dockerenv')).toBe('container');
    expect(runContext({}, 'linux', (p) => p === '/run/.containerenv')).toBe('container');
    // The marker files only mean something on Linux.
    expect(runContext({}, 'darwin', () => true)).toBe('default');
  });

  it('keeps only the minor version of a binary', () => {
    expect(minorVersion('1.22.4')).toBe('1.22');
    expect(minorVersion('v0.43.0')).toBe('0.43');
    expect(minorVersion('0.71.1-rc1')).toBe('0.71');
    expect(minorVersion('1.22')).toBe('1.22');
    expect(minorVersion('dev build')).toBe('unknown');
    expect(minorVersion(null)).toBe('unknown');
  });

  it('tells how opa was found', () => {
    expect(opaSource({}, 'opa', '1.22.4')).toBe('path');
    expect(opaSource({}, '/x/node_modules/@orygn/opa-mcp-linux-x64/opa', '1.22.4')).toBe('bundled');
    expect(opaSource({ OPA_BINARY: '/usr/local/bin/opa' }, '/usr/local/bin/opa', '1.0.0')).toBe(
      'custom',
    );
    expect(opaSource({ OPA_BINARY: 'opa' }, 'opa', '1.0.0')).toBe('path');
    expect(opaSource({ OPA_BINARY: '${user_config.opa_binary}' }, 'opa', '1.0.0')).toBe('path');
    expect(opaSource({}, 'opa', null)).toBe('missing');
  });

  it('names the settings changed from their defaults, never their values', () => {
    const env = {
      OPA_URL: 'http://localhost:8181',
      OPA_TOKEN: 'secret-token-value',
      OPA_BINARY: 'opa',
      REGAL_BINARY: '/home/someone/bin/regal',
      OPA_MCP_TIMEOUT_MS: '30000',
      OPA_MCP_HTTP_TIMEOUT_MS: '60000',
      OPA_MCP_ALLOWED_PATHS: '${user_config.allowed_paths}',
      OPA_MCP_LOG_LEVEL: 'INFO',
      OPA_MCP_BLOCK_ENV: '  ',
      UNRELATED: 'x',
    };
    const set = settingsSet(env);
    expect(set).toEqual(['OPA_TOKEN', 'REGAL_BINARY', 'OPA_MCP_HTTP_TIMEOUT_MS']);
    expect(JSON.stringify(set)).not.toContain('secret');
    expect(JSON.stringify(set)).not.toContain('someone');
  });
});

describe('firstFlags()', () => {
  it('works out first of week, month and ever from the days before', () => {
    // 2026-11-23 is a Monday.
    expect(firstFlags([], '2026-11-25', undefined)).toEqual({
      week: true,
      month: true,
      ever: true,
    });
    expect(firstFlags(['2026-11-23'], '2026-11-25', '2026-11-23')).toEqual({
      week: false,
      month: false,
      ever: false,
    });
    expect(firstFlags(['2026-11-22'], '2026-11-25', '2026-11-22')).toEqual({
      week: true,
      month: false,
      ever: false,
    });
    // Saturday the 31st and Sunday the 1st are the same week.
    expect(firstFlags(['2026-10-31'], '2026-11-01', '2026-10-31')).toEqual({
      week: false,
      month: true,
      ever: false,
    });
  });

  it('says the same when today is already in the list', () => {
    expect(firstFlags(['2026-11-25'], '2026-11-25', '2026-11-25')).toEqual({
      week: true,
      month: true,
      ever: true,
    });
  });
});

describe('collectDays()', () => {
  let dir: string;
  const now = Date.parse('2026-11-25T12:00:00Z');
  const write = (name: string, body: unknown, ageMs = 3_600_000): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    const t = (now - ageMs) / 1000;
    utimesSync(path, t, t);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opa-mcp-collect-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds up the files of every process, per finished day, newest first', () => {
    write('day-2026-11-24-1-aaaaaa.json', {
      tools: { rego_eval: 8 },
      failures: { 'rego_eval|EVAL_ERROR': 2 },
      crashes: {},
      apps: ['claude-code'],
    });
    write('day-2026-11-24-2-bbbbbb.json', {
      tools: { rego_eval: 3, rego_test: 1 },
      failures: {},
      crashes: { 'rego_test|TypeError@lib/x.js:1': 1 },
      apps: ['cursor', 'claude-code'],
    });
    write('day-2026-11-20-1-aaaaaa.json', { tools: { rego_check: 200 } });
    write(`day-2026-11-25-1-aaaaaa.json`, { tools: { rego_eval: 1 } });
    const { days, files } = collectDays(dir, '2026-11-25', now);
    expect(days).toEqual([
      {
        d: '2026-11-24',
        tools: { rego_eval: '10-99', rego_test: '1-9' },
        failures: { 'rego_eval|EVAL_ERROR': '1-9' },
        crashes: { 'rego_test|TypeError@lib/x.js:1': '1-9' },
        apps: ['claude-code', 'cursor'],
      },
      { d: '2026-11-20', tools: { rego_check: '100+' }, failures: {}, crashes: {}, apps: [] },
    ]);
    // Today is not over, so its file stays.
    expect(Object.keys(files)).toEqual(['2026-11-24', '2026-11-20']);
    expect(files['2026-11-24']).toHaveLength(2);
  });

  it('waits for a day a process wrote to in the last minute', () => {
    write('day-2026-11-24-1-aaaaaa.json', { tools: { rego_eval: 1 } }, 10_000);
    expect(collectDays(dir, '2026-11-25', now).days).toEqual([]);
  });

  it('skips files it cannot read and values that are not counts', () => {
    write('day-2026-11-24-1-aaaaaa.json', '{not json');
    write('day-2026-11-24-2-bbbbbb.json', {
      tools: { rego_eval: 'many', rego_test: -3, rego_check: 2, 'has space': 4 },
      apps: [7, 'zed'],
    });
    write('notes.txt', 'hello');
    expect(collectDays(dir, '2026-11-25', now).days).toEqual([
      { d: '2026-11-24', tools: { rego_check: '1-9' }, failures: {}, crashes: {}, apps: ['zed'] },
    ]);
  });

  it('sends at most seven days', () => {
    for (let i = 1; i <= 10; i++) {
      write(`day-2026-11-${String(10 + i).padStart(2, '0')}-1-aaaaaa.json`, {
        tools: { rego_eval: 1 },
      });
    }
    const { days, files } = collectDays(dir, '2026-11-25', now);
    expect(days.map((d) => d.d)).toEqual([
      '2026-11-20',
      '2026-11-19',
      '2026-11-18',
      '2026-11-17',
      '2026-11-16',
      '2026-11-15',
      '2026-11-14',
    ]);
    expect(Object.keys(files)).toHaveLength(7);
  });

  it('finds nothing in a folder that does not exist', () => {
    expect(collectDays(join(dir, 'missing'), '2026-11-25', now)).toEqual({ days: [], files: {} });
  });
});

describe('sending rules', () => {
  it('reads a status as taken, refused for good, or worth retrying', () => {
    expect([200, 204].map(sendOutcome)).toEqual(['sent', 'sent']);
    expect([400, 404, 413].map(sendOutcome)).toEqual(['rejected', 'rejected', 'rejected']);
    expect([0, 408, 429, 500, 503].map(sendOutcome)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
    ]);
  });

  it('backs off from 15 minutes to at most 6 hours', () => {
    expect(backoffMs(1)).toBe(15 * 60_000);
    expect(backoffMs(2)).toBe(30 * 60_000);
    expect(backoffMs(10)).toBe(6 * 3_600_000);
  });

  it('keeps the most used of each per day, up to what the receiver takes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opa-mcp-cap-'));
    try {
      const tools = Object.fromEntries(
        Array.from({ length: 120 }, (_, i) => [`rego_t${i}`, i + 1]),
      );
      const failures = Object.fromEntries(
        Array.from({ length: 150 }, (_, i) => [`rego_t${i}|EVAL_ERROR`, i + 1]),
      );
      const path = join(dir, 'day-2026-11-24-1-aaaaaa.json');
      writeFileSync(path, JSON.stringify({ tools, failures, crashes: {}, apps: [] }));
      const t = (Date.now() - 3_600_000) / 1000;
      utimesSync(path, t, t);
      const [d] = collectDays(dir, '2026-11-25').days;
      expect(Object.keys(d!.tools)).toHaveLength(80);
      expect(d!.tools['rego_t119']).toBe('100+');
      expect(d!.tools['rego_t0']).toBeUndefined();
      expect(Object.keys(d!.failures)).toHaveLength(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops the oldest days until a report fits', () => {
    const day = (d: string): Report['days'][number] => ({
      d,
      tools: Object.fromEntries(
        Array.from({ length: 400 }, (_, i) => [`rego_tool_with_a_long_name_${i}`, '1-9']),
      ),
      failures: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`rego_tool_${i}|INVALID_INPUT`, '10-99']),
      ),
      crashes: {},
      apps: [],
    });
    const report = {
      days: ['2026-11-24', '2026-11-23', '2026-11-22', '2026-11-21', '2026-11-20'].map(day),
    } as unknown as Report;
    const body = fitReport(report);
    expect(body.length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(report.days[0]!.d).toBe('2026-11-24');
    expect(report.days.length).toBeLessThan(5);
  });
});

describe('removeOldInstallId()', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opa-mcp-old-id-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('removes the file earlier versions wrote, and nothing else', () => {
    const ours = join(dir, 'install-id');
    writeFileSync(ours, '# opa-mcp install ID\n#\n00000000-0000-4000-8000-000000000001\n');
    expect(removeOldInstallId(ours)).toBe(true);
    expect(existsSync(ours)).toBe(false);

    const other = join(dir, 'other');
    writeFileSync(other, 'something else\n');
    expect(removeOldInstallId(other)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(removeOldInstallId(join(dir, 'missing'))).toBe(false);
  });
});

describe('sendIfDue()', () => {
  let dir: string;
  let posts: Array<{ url: string; body: Report }>;
  let status: number;
  const config = {
    opaBinary: 'opa',
    allowedPaths: ['/policies'],
  } as unknown as Config;
  const day = utcDay();
  const at = (d: string, hour = 12): Date =>
    new Date(`${d}T${String(hour).padStart(2, '0')}:00:00Z`);

  const use = (env: Record<string, string> = {}, mode: 'on' | 'log' = 'on'): string[] => {
    const logged: string[] = [];
    __testing.use(
      {
        env,
        post: (url, body) => {
          posts.push({ url, body: JSON.parse(body) as Report });
          return Promise.resolve(status);
        },
        log: (line) => logged.push(line),
      },
      config,
      mode,
    );
    return logged;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opa-mcp-send-'));
    stats.reset(dir);
    __testing.reset();
    posts = [];
    status = 204;
    noteBinaryVersions({ opa: '1.22.4', regal: '0.43.0', conftest: null });
  });

  afterEach(() => {
    __testing.reset();
    stats.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  const state = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;

  it('sends one report a day, with what the install looks like', async () => {
    use({ OPA_TOKEN: 'secret' });
    expect(await sendIfDue()).toBe('sent');
    expect(posts).toHaveLength(1);
    const { url, body } = posts[0]!;
    expect(url.endsWith(REPORT_PATH)).toBe(true);
    expect(body).toMatchObject({
      s: 1,
      day,
      v: SERVER_VERSION,
      install: 'source',
      opa: 'path',
      opa_v: '1.22',
      regal: '0.43',
      conftest: 'missing',
      files: 'allowed_paths',
      settings: ['OPA_TOKEN'],
      age: '0',
      first: { week: true, month: true, ever: true },
      days: [],
    });
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(state()['sent_day']).toBe(day);

    expect(await sendIfDue()).toBe('skipped');
    expect(posts).toHaveLength(1);
  });

  it('does not send again the same day from another process', async () => {
    use();
    expect(await sendIfDue()).toBe('sent');
    // A second process: nothing in memory, the state file says it is done.
    use();
    expect(await sendIfDue()).toBe('skipped');
    expect(posts).toHaveLength(1);
  });

  it('sends the finished days and removes their files once taken', async () => {
    use();
    startCounting({ onToolCall: () => {} });
    noteClient('claude-code');
    noteToolCall('rego_eval');
    noteToolCall('rego_eval', { code: 'EVAL_ERROR' });
    const [file] = readdirSync(dir).filter((n) => n.startsWith('day-'));
    // Make the counts yesterday's and old enough to have settled.
    const yesterday = utcDay(new Date(Date.now() - 86_400_000));
    const moved = join(dir, file!.replace(day, yesterday));
    writeFileSync(moved, readFileSync(join(dir, file!)));
    rmSync(join(dir, file!));
    const t = (Date.now() - 3_600_000) / 1000;
    utimesSync(moved, t, t);
    stats.reset(dir);

    expect(await sendIfDue()).toBe('sent');
    expect(posts[0]!.body.days).toEqual([
      {
        d: yesterday,
        tools: { rego_eval: '1-9' },
        failures: { 'rego_eval|EVAL_ERROR': '1-9' },
        crashes: {},
        apps: ['claude-code'],
      },
    ]);
    expect(existsSync(moved)).toBe(false);
  });

  it('keeps the files of days left out to make the report fit', async () => {
    use();
    const long = (i: number): string => `rego_${'x'.repeat(140)}_${i}`;
    const t = (Date.now() - 3_600_000) / 1000;
    const written: Record<string, string> = {};
    for (let i = 1; i <= 7; i++) {
      const d = utcDay(new Date(Date.now() - i * 86_400_000));
      const path = join(dir, `day-${d}-1-aaaaaa.json`);
      writeFileSync(
        path,
        JSON.stringify({
          tools: Object.fromEntries(Array.from({ length: 80 }, (_, k) => [long(k), 1])),
          failures: Object.fromEntries(
            Array.from({ length: 100 }, (_, k) => [`${long(k)}|EVAL_ERROR`, 1]),
          ),
        }),
      );
      utimesSync(path, t, t);
      written[d] = path;
    }
    expect(await sendIfDue()).toBe('sent');
    const sent = posts[0]!.body.days.map((d) => d.d);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(7);
    for (const [d, path] of Object.entries(written)) {
      expect(existsSync(path), d).toBe(!sent.includes(d));
    }
  });

  it('retries a failed send later with the same number, and counts it once', async () => {
    use();
    status = 503;
    const first = at(day, 9);
    expect(await sendIfDue(first)).toBe('failed');
    expect(state()['next_try_at']).toBe(new Date(first.getTime() + 15 * 60_000).toISOString());
    // Too soon, in this process and in another.
    expect(await sendIfDue(at(day, 9))).toBe('skipped');
    use();
    expect(await sendIfDue(new Date(first.getTime() + 60_000))).toBe('skipped');

    status = 204;
    expect(await sendIfDue(new Date(first.getTime() + 16 * 60_000))).toBe('sent');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body.nonce).toBe(posts[0]!.body.nonce);
    expect(posts[1]!.body.first).toEqual(posts[0]!.body.first);
    expect(state()['failures']).toBeUndefined();
  });

  it('gives up on a report the receiver refuses, for that day', async () => {
    use();
    status = 400;
    expect(await sendIfDue()).toBe('rejected');
    expect(state()['sent_day']).toBe(day);
    expect(await sendIfDue()).toBe('skipped');
  });

  it('uses a new number each day, and knows the install is not new', async () => {
    use();
    expect(await sendIfDue(at('2026-11-23'))).toBe('sent');
    use();
    expect(await sendIfDue(at('2026-11-25'))).toBe('sent');
    expect(posts[1]!.body.nonce).not.toBe(posts[0]!.body.nonce);
    expect(posts[1]!.body.first).toEqual({ week: false, month: false, ever: false });
    expect(posts[1]!.body.age).toBe('1-7');
  });

  it('leaves sending to whichever process holds the lock', async () => {
    use();
    writeFileSync(join(dir, 'send.lock'), '123');
    expect(await sendIfDue()).toBe('skipped');
    expect(posts).toHaveLength(0);
    // A lock left by a process that died is taken over after a minute.
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(join(dir, 'send.lock'), old, old);
    expect(await sendIfDue()).toBe('sent');
    expect(existsSync(join(dir, 'send.lock'))).toBe(false);
  });

  it('in log mode writes the report and sends nothing', async () => {
    const logged = use({}, 'log');
    expect(await sendIfDue()).toBe('logged');
    expect(posts).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect((JSON.parse(logged[0]!) as Report).day).toBe(day);
    expect(await sendIfDue()).toBe('skipped');
  });

  it('does nothing when off', async () => {
    __testing.use({}, config, 'off');
    expect(await sendIfDue()).toBe('skipped');
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
  });

  it('sends to OPA_MCP_TELEMETRY_URL when set', async () => {
    use({ OPA_MCP_TELEMETRY_URL: 'http://127.0.0.1:8787/' });
    await sendIfDue();
    expect(posts[0]!.url).toBe(`http://127.0.0.1:8787${REPORT_PATH}`);
    use({ OPA_MCP_TELEMETRY_URL: 'not a url' });
    expect(__testing.endpoint()).not.toContain('not a url');
  });

  it('holds nothing but fixed words, versions, bands and tool names', async () => {
    use({
      OPA_TOKEN: 'hunter2',
      OPA_URL: 'https://opa.internal.example.com',
      OPA_MCP_ALLOWED_PATHS: '/home/someone/policies',
    });
    startCounting({ onToolCall: () => {} });
    noteClient('A Secret Internal Agent v9 for ACME');
    noteToolCall('other', { code: 'UNRECOGNIZED' });
    await sendIfDue();
    const text = JSON.stringify(posts[0]!.body);
    for (const leak of ['hunter2', 'internal', 'someone', 'ACME', 'Secret']) {
      expect(text).not.toContain(leak);
    }
    const allowed =
      /^(?:[a-z0-9_-]{1,40}|[A-Z_]{2,40}|\d{4}-\d{2}-\d{2}|[0-9a-f]{32}|\d+\.\d+(?:\.\d+)?|\d+(?:-\d+|\+)?|1-9|10-99|100\+)$/;
    const walk = (v: unknown): void => {
      if (typeof v === 'string') expect(v, v).toMatch(allowed);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(posts[0]!.body);
  });
});
