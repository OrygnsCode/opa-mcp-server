#!/usr/bin/env node
/**
 * Point the Claude plugin at a published opa-mcp release.
 *
 *   node scripts/pin-plugin.mjs [version]    (default: the version in package.json)
 *
 * The plugin does not carry the server: .mcp.json runs it with npx at an exact
 * version, so the pin has to name a version already on npm, and it moves in a
 * commit after the release is published, not in the release commit.
 *
 * Sets that version in plugin/.mcp.json and in plugin/.claude-plugin/plugin.json,
 * whose version Claude Code compares to offer an update.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pluginDir = join(repoRoot, 'plugin');
const PACKAGE = '@orygn/opa-mcp';

function fail(msg) {
  console.error(`pin-plugin: ${msg}`);
  process.exit(1);
}

const version =
  process.argv[2] ?? JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`"${version}" is not an exact x.y.z version`);

let published;
try {
  published = execSync(`npm view ${PACKAGE}@${version} version`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  published = '';
}
if (published !== version) fail(`${PACKAGE}@${version} is not on npm yet; publish it first`);

// Edit the two strings in place, so the files keep their formatting.
function replaceOnce(path, pattern, replacement) {
  const text = readFileSync(path, 'utf8');
  const matches = text.match(new RegExp(pattern.source, 'g')) ?? [];
  if (matches.length !== 1) fail(`expected one match for ${pattern} in ${path}`);
  writeFileSync(path, text.replace(pattern, replacement));
}
replaceOnce(join(pluginDir, '.mcp.json'), /"@orygn\/opa-mcp@[^"]*"/, `"${PACKAGE}@${version}"`);
replaceOnce(
  join(pluginDir, '.claude-plugin', 'plugin.json'),
  /"version": "[^"]*"/,
  `"version": "${version}"`,
);

console.log(`Plugin pinned to ${PACKAGE}@${version}. Run node scripts/test-plugin.mjs to try it.`);
