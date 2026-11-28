/**
 * The Claude plugin in plugin/ is configuration, not code, and nothing runs it
 * until someone installs it. These checks hold its files to each other and to
 * the server it launches, so a release or an edit cannot leave it pointing at
 * the wrong thing. scripts/test-plugin.mjs starts it and calls a tool.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { REPORT_BASE } from '../../src/lib/usage-report.js';
import { packagedAs, usageSwitch } from '../../src/lib/usage-stats.js';

const path = (name: string): URL => new URL(`../../${name}`, import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(path(name), 'utf8')) as T;

interface Manifest {
  name: string;
  version: string;
  icon: string;
  network: { hosts: string[] };
  userConfig?: unknown;
}
interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

const manifest = read<Manifest>('plugin/.claude-plugin/plugin.json');
const mcpText = readFileSync(path('plugin/.mcp.json'), 'utf8');
const servers = Object.values((JSON.parse(mcpText) as McpConfig).mcpServers);
const server = servers[0]!;
const root = read<{ name: string; version: string }>('package.json');

const semver = (v: string): number[] => v.split('.').map(Number);
function notAfter(a: string, b: string): boolean {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return true;
}

describe('Claude plugin', () => {
  it('runs the server with npx at the exact version plugin.json declares', () => {
    expect(servers).toHaveLength(1);
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', `${root.name}@${manifest.version}`]);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('never pins a version after the one in this repository', () => {
    // The pin names a release already on npm (scripts/pin-plugin.mjs), so it
    // can trail package.json during a release, never lead it.
    expect(notAfter(manifest.version, root.version)).toBe(true);
  });

  it('uses no plugin settings, which Claude Desktop does not support', () => {
    // Claude Desktop drops a plugin server whose config references
    // ${user_config.*}, so Cowork would never start it.
    expect(manifest.userConfig).toBeUndefined();
    expect(mcpText).not.toContain('${user_config.');
  });

  it('ships no package.json or lockfile', () => {
    // Claude Code would install them into the plugin, and npx does not use them.
    for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock']) {
      expect(existsSync(path(`plugin/${name}`)), name).toBe(false);
    }
  });

  it('tells the server it runs as the plugin, with usage stats on unless turned off', () => {
    const env = { ...server.env };
    expect(packagedAs(env)).toBe('plugin');
    expect(usageSwitch(env)).toEqual({ mode: 'on' });
    expect(usageSwitch({ ...env, OPA_MCP_TELEMETRY: 'off' }).mode).toBe('off');
  });

  it('declares the hosts the server reaches', () => {
    expect(manifest.network.hosts).toContain(new URL(REPORT_BASE).host);
    expect(manifest.network.hosts).toContain('api.github.com');
  });

  it('is listed in the repository marketplace under its own name', () => {
    const market = read<{ plugins: Array<{ name: string; source: string }> }>(
      '.claude-plugin/marketplace.json',
    );
    expect(market.plugins).toContainEqual(
      expect.objectContaining({ name: manifest.name, source: './plugin' }),
    );
  });

  it('carries the files a directory listing needs', () => {
    expect(existsSync(path('plugin/LICENSE'))).toBe(true);
    const readme = readFileSync(path('plugin/README.md'), 'utf8');
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    expect(readme).toContain(`/plugin install ${manifest.name} --marketplace`);
    // A square PNG: the signature, then the IHDR width and height.
    const icon = readFileSync(path(`plugin/${manifest.icon.replace(/^\.\//, '')}`));
    expect(icon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(icon.readUInt32BE(16)).toBe(icon.readUInt32BE(20));
    expect(icon.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
  });
});
