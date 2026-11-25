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
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CI_VARIABLES,
  __testing,
  appName,
  crashSite,
  flush,
  isInstalled,
  noteClient,
  noteToolCall,
  packagedAs,
  recordCrashSite,
  startCounting,
  takeCrashSite,
  usageLine,
  usageSwitch,
  utcDay,
} from '../../../src/lib/usage-stats.js';

describe('usageSwitch()', () => {
  it('is on for an installed copy with nothing set', () => {
    expect(usageSwitch({}, true)).toEqual({ mode: 'on' });
  });

  it('is off in a source checkout unless asked for', () => {
    expect(usageSwitch({}, false)).toEqual({
      mode: 'off',
      why: 'running from a source checkout',
    });
    expect(usageSwitch({ OPA_MCP_TELEMETRY: 'on' }, false).mode).toBe('on');
  });

  it('takes on, true, 1 and yes as on, in any case', () => {
    for (const value of ['on', 'true', '1', 'yes', 'ON', ' Yes ']) {
      expect(usageSwitch({ OPA_MCP_TELEMETRY: value }, true).mode, value).toBe('on');
    }
  });

  it('takes any other value as off and says which', () => {
    for (const value of ['off', 'false', '0', 'no', 'disabled', 'nope']) {
      const sw = usageSwitch({ OPA_MCP_TELEMETRY: value }, true);
      expect(sw.mode, value).toBe('off');
      expect(sw.why).toBe(`OPA_MCP_TELEMETRY=${value}`);
    }
  });

  it('treats an empty OPA_MCP_TELEMETRY as unset', () => {
    expect(usageSwitch({ OPA_MCP_TELEMETRY: '' }, true).mode).toBe('on');
    expect(usageSwitch({ OPA_MCP_TELEMETRY: '  ' }, false).mode).toBe('off');
  });

  it('honours DO_NOT_TRACK and OPA_MCP_NO_TELEMETRY over an explicit on', () => {
    for (const value of ['1', 'true', 'yes']) {
      expect(usageSwitch({ DO_NOT_TRACK: value, OPA_MCP_TELEMETRY: 'on' }, true)).toEqual({
        mode: 'off',
        why: 'DO_NOT_TRACK is set',
      });
      expect(usageSwitch({ OPA_MCP_NO_TELEMETRY: value, OPA_MCP_TELEMETRY: 'on' }, true)).toEqual({
        mode: 'off',
        why: 'OPA_MCP_NO_TELEMETRY is set',
      });
    }
  });

  it('ignores DO_NOT_TRACK set to a no', () => {
    for (const value of ['0', 'false', 'no', 'off', '']) {
      expect(usageSwitch({ DO_NOT_TRACK: value }, true).mode, value).toBe('on');
    }
  });

  it('is off in CI, for each variable CI systems set', () => {
    for (const name of CI_VARIABLES) {
      expect(usageSwitch({ [name]: 'true', OPA_MCP_TELEMETRY: 'on' }, true), name).toEqual({
        mode: 'off',
        why: 'running in CI',
      });
    }
    expect(usageSwitch({ CI: 'false' }, true).mode).toBe('on');
  });

  it('writes to the log in log mode whatever else is set, since nothing is sent', () => {
    expect(usageSwitch({ OPA_MCP_TELEMETRY: 'log', DO_NOT_TRACK: '1', CI: 'true' }, false)).toEqual(
      { mode: 'log' },
    );
    expect(usageSwitch({ OPA_MCP_TELEMETRY: 'LOG' }, true).mode).toBe('log');
  });

  it('in the Claude Desktop bundle, is on only when the checkbox says so', () => {
    const mcpb = { OPA_MCP_PACKAGING: 'mcpb' };
    expect(usageSwitch({ ...mcpb, OPA_MCP_TELEMETRY: 'true' }, false).mode).toBe('on');
    for (const value of ['false', '${user_config.usage_stats}', '', undefined]) {
      expect(usageSwitch({ ...mcpb, OPA_MCP_TELEMETRY: value }, false), String(value)).toEqual({
        mode: 'off',
        why: "turned off in the extension's settings",
      });
    }
    expect(usageSwitch({ ...mcpb, OPA_MCP_TELEMETRY: 'true', DO_NOT_TRACK: '1' }).mode).toBe('off');
  });

  it('counts the Docker image and the bundle as installed', () => {
    expect(usageSwitch({ OPA_MCP_PACKAGING: 'docker' }).mode).toBe('on');
    expect(packagedAs({ OPA_MCP_PACKAGING: 'Docker' })).toBe('docker');
    expect(packagedAs({ OPA_MCP_PACKAGING: 'brew' })).toBeUndefined();
  });

  it('defaults to off in this repository, which is a source checkout', () => {
    expect(isInstalled()).toBe(false);
    expect(usageSwitch({}).mode).toBe('off');
  });
});

describe('isInstalled()', () => {
  it('is true under node_modules on either kind of path', () => {
    expect(isInstalled('/usr/lib/node_modules/@orygn/opa-mcp')).toBe(true);
    expect(isInstalled('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@orygn\\opa-mcp')).toBe(
      true,
    );
    expect(isInstalled('/home/u/src/opa-mcp-server')).toBe(false);
    expect(isInstalled('/home/u/node_modules_backup/opa-mcp')).toBe(false);
  });
});

describe('usageLine()', () => {
  it('says how to turn it off, where', () => {
    expect(usageLine({ mode: 'on' }, {})).toBe(
      'Usage stats: on. To turn them off, set OPA_MCP_TELEMETRY=off.',
    );
    expect(usageLine({ mode: 'on' }, { OPA_MCP_PACKAGING: 'mcpb' })).toContain(
      'untick Usage stats',
    );
    expect(usageLine({ mode: 'off', why: 'DO_NOT_TRACK is set' })).toBe(
      'Usage stats: off (DO_NOT_TRACK is set).',
    );
    expect(usageLine({ mode: 'log' })).toContain('never sent');
  });
});

describe('appName()', () => {
  it('maps the name a client gives to one of a fixed list', () => {
    const cases: Array<[string | undefined, string]> = [
      ['claude-ai', 'claude-desktop'],
      ['local-agent-mode-opa-mcp', 'claude-desktop'],
      ['local-agent-mode-cursor-helper', 'claude-desktop'],
      ['claude-code', 'claude-code'],
      ['Claude Code', 'claude-code'],
      ['cursor-vscode', 'cursor'],
      ['Visual Studio Code', 'vscode'],
      ['mcp-inspector', 'inspector'],
      ['Roo Code', 'roo-code'],
      ['codex-mcp-client', 'codex'],
      ['gemini-cli-mcp-client', 'gemini-cli'],
      ['some-new-agent', 'other'],
      ['', 'unknown'],
      [undefined, 'unknown'],
    ];
    for (const [name, app] of cases) expect(appName(name), String(name)).toBe(app);
  });
});

describe('crashSite()', () => {
  const root = join(tmpdir(), 'pkg', 'dist');
  const at = (file: string, line = 12): string => `    at fn (${file}:${line}:5)`;
  const error = (frames: string[], name = 'TypeError'): Error => {
    const e = new Error('secret message with /home/someone/policy.rego');
    e.name = name;
    e.stack = [`${name}: ${e.message}`, ...frames].join('\n');
    return e;
  };

  it('names the innermost frame in the server code, never the message', () => {
    const e = error([
      '    at JSON.parse (<anonymous>)',
      '    at node:internal/fs/utils:351:5',
      at(join(root, 'lib', 'opa-cli.js'), 212),
      at(join(root, 'tools', 'evaluation', 'eval.js'), 40),
    ]);
    expect(crashSite(e, root)).toBe('TypeError@lib/opa-cli.js:212');
  });

  it('reads file URLs and frames without a function name', () => {
    const file = pathToFileURL(join(root, 'lib', 'rego-z3.js')).href;
    const e = error([`    at ${file}:7:3`], 'RangeError');
    expect(crashSite(e, root)).toBe('RangeError@lib/rego-z3.js:7');
  });

  it('is external when no frame is in the server code', () => {
    const e = error([at(join(tmpdir(), 'pkg', 'node_modules', 'zod', 'index.js'))]);
    expect(crashSite(e, root)).toBe('external');
  });

  it('keeps an odd error name out', () => {
    const e = error([at(join(root, 'server.js'))], 'not a name; rm -rf');
    expect(crashSite(e, root)).toBe('Error@server.js:12');
  });

  it('is unknown with no stack, or for a thrown non-error', () => {
    const e = new Error('x');
    e.stack = undefined;
    expect(crashSite(e, root)).toBe('unknown');
    expect(crashSite('a string', root)).toBe('unknown');
  });

  it('is unknown for a file name outside the expected shape', () => {
    const e = error([at(join(root, 'lib', 'Some File.js'))]);
    expect(crashSite(e, root)).toBe('unknown');
  });
});

describe('the running tally', () => {
  let dir: string;
  const files = (): string[] => readdirSync(dir).filter((n) => n.startsWith('day-'));
  const read = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, files()[0]!), 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opa-mcp-usage-stats-'));
    __testing.reset(dir);
  });

  afterEach(() => {
    __testing.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts nothing until counting starts', () => {
    noteToolCall('rego_eval');
    flush();
    expect(files()).toEqual([]);
  });

  it('writes each call to a file of its own for the day, at once', () => {
    startCounting({ onToolCall: () => {} });
    noteClient('claude-code');
    noteToolCall('rego_eval');
    noteToolCall('rego_eval', { code: 'EVAL_ERROR' });
    noteToolCall('rego_test', { code: 'UNKNOWN_ERROR', site: 'TypeError@lib/x.js:1' });
    expect(files()).toEqual([`day-${utcDay()}-${__testing.fileTag}.json`]);
    expect(read()).toEqual({
      tools: { rego_eval: 2, rego_test: 1 },
      failures: { 'rego_eval|EVAL_ERROR': 1, 'rego_test|UNKNOWN_ERROR': 1 },
      crashes: { 'rego_test|TypeError@lib/x.js:1': 1 },
      apps: ['claude-code'],
    });
  });

  it('lists each app that called a tool once', () => {
    startCounting({ onToolCall: () => {} });
    noteToolCall('rego_eval');
    noteClient('cursor-vscode');
    noteToolCall('rego_eval');
    noteToolCall('rego_eval');
    noteClient('');
    noteToolCall('rego_eval');
    expect(read()['apps']).toEqual(['unknown', 'cursor']);
  });

  it('calls back after the call, not during it', async () => {
    let called = 0;
    startCounting({ onToolCall: () => (called += 1) });
    noteToolCall('rego_eval');
    expect(called).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(called).toBe(1);
  });

  it('prunes day files older than a week and stale temporary files', () => {
    const old = join(dir, 'day-2000-01-01-1-abc.json');
    const recent = join(dir, `day-${utcDay()}-1-abc.json`);
    const temp = join(dir, 'day-x.json.tmp');
    for (const f of [old, recent, temp]) writeFileSync(f, '{}');
    const twoHoursAgo = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(temp, twoHoursAgo, twoHoursAgo);
    startCounting({ onToolCall: () => {} });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('keeps crash sites only while counting, each taken once', () => {
    recordCrashSite(1, 'TypeError@lib/x.js:1');
    expect(takeCrashSite(1)).toBeUndefined();
    startCounting({ onToolCall: () => {} });
    recordCrashSite(2, 'TypeError@lib/x.js:1');
    expect(takeCrashSite(2)).toBe('TypeError@lib/x.js:1');
    expect(takeCrashSite(2)).toBeUndefined();
    for (let i = 0; i < 100; i++) recordCrashSite(i, 'external');
    expect(takeCrashSite(0)).toBeUndefined();
    expect(takeCrashSite(99)).toBe('external');
  });
});
