#!/usr/bin/env node
/**
 * Start the Claude plugin's server the way Claude Code and Claude Desktop do,
 * from a cold npm cache, and talk MCP to it.
 *
 * .mcp.json runs the server with npx at an exact version. This runs that
 * command with the env it sets, an empty npm cache (a first start downloads
 * the package and the OPA that comes with it) and PATH cut down to node's own
 * directory, plus /usr/bin and /bin outside Windows for the shell npm runs a
 * package's bin through. It checks that:
 *
 *   1. .mcp.json uses no plugin settings, which Claude Desktop does not support
 *   2. the server answers initialize, and how long a first start took
 *   3. it lists its tools, reports the pinned version, and runs the OPA that
 *      came with the package, as its startup line on stderr shows
 *   4. rego_eval runs a policy on that OPA
 *
 * Needs network access to the npm registry. Exits 0 on pass, 1 on failure.
 */
import { execSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..', 'plugin');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const windows = process.platform === 'win32';

function fail(msg) {
  throw new Error(msg);
}

const manifest = readJson(join(pluginDir, '.claude-plugin', 'plugin.json'));
const mcpText = readFileSync(join(pluginDir, '.mcp.json'), 'utf8');
const server = Object.values(JSON.parse(mcpText).mcpServers)[0];

const work = mkdtempSync(join(tmpdir(), 'opa-mcp-plugin-test-'));
let child;
let done = false;
const waiting = new Map();
try {
  // 1. Claude Desktop drops a plugin server whose config uses plugin settings.
  if (mcpText.includes('${user_config.')) fail('.mcp.json uses plugin settings (user_config)');
  const pinned = server.args.find((a) => a.startsWith('@orygn/opa-mcp@'))?.split('@')[2];
  if (pinned !== manifest.version) {
    fail(`.mcp.json runs ${pinned}, but plugin.json says ${manifest.version}`);
  }

  // 2. Start it as .mcp.json says, from an empty npm cache.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  env.PATH = windows ? dirname(process.execPath) : `${dirname(process.execPath)}:/usr/bin:/bin`;
  env.npm_config_cache = join(work, 'npm-cache');
  env.npm_config_update_notifier = 'false';
  for (const [k, v] of Object.entries(server.env ?? {})) env[k] = v;
  // A test run is not a use: keep its tool calls out of the usage stats.
  env.DO_NOT_TRACK = '1';
  const started = Date.now();
  // npx is npx.cmd on Windows, which needs a shell, and a shell takes one
  // command line; elsewhere the server gets its own process group so the
  // whole tree can be stopped at the end.
  const words = [server.command, ...server.args];
  if (!words.every((w) => /^[\w@./:-]+$/.test(w))) fail(`unexpected command: ${words.join(' ')}`);
  child = spawn(windows ? words.join(' ') : server.command, windows ? [] : server.args, {
    cwd: work,
    env,
    shell: windows,
    detached: !windows,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    stderrText += chunk;
    process.stderr.write(chunk);
  });
  child.on('exit', (code, signal) => {
    if (done) return;
    const why = new Error(`the server exited early (code ${code}, signal ${signal})`);
    for (const reply of waiting.values()) reply({ error: why });
  });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const request = (method, params, timeoutMs = 30_000) =>
    new Promise((resolveReply, rejectReply) => {
      const id = nextId++;
      const timer = setTimeout(() => rejectReply(new Error(`${method} timed out`)), timeoutMs);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (msg.error) rejectReply(new Error(`${method}: ${msg.error.message}`));
        else resolveReply(msg.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const envelope = (result) => {
    const text = result.content?.find((c) => c.type === 'text')?.text;
    return result.structuredContent ?? (text ? JSON.parse(text) : undefined);
  };

  await request(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'opa-mcp-plugin-test', version: '0' },
    },
    300_000,
  );
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  console.log(`  first start (empty npm cache) in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // 3. Tools, version and OPA.
  const { tools } = await request('tools/list', {});
  if (!tools?.length) fail('the server listed no tools');
  console.log(`  ${tools.length} tools listed`);

  const info = envelope(await request('tools/call', { name: 'mcp_server_info', arguments: {} }));
  const data = info?.data ?? info;
  if (data?.version !== pinned) fail(`mcp_server_info reports ${data?.version}, not ${pinned}`);
  if (!data?.opaVersion) fail('the server could not run the OPA that comes with the package');
  const opaPath = stderrText.match(/\bopa=(.*?)(?:\s{2,}|\r?\n|$)/)?.[1] ?? '';
  if (!/[\\/]@orygn[\\/]opa-mcp-(?:linux|darwin|win32)-(?:x64|arm64)[\\/]/.test(opaPath)) {
    fail(`the server runs opa from "${opaPath}", not the copy that comes with the package`);
  }
  console.log(`  opa-mcp ${data.version}, OPA ${data.opaVersion}`);

  // 4. A policy evaluates on that OPA.
  const evaluated = envelope(
    await request('tools/call', {
      name: 'rego_eval',
      arguments: {
        query: 'data.plugin_test.allow',
        source: 'package plugin_test\n\nallow if input.user == "alice"\n',
        input: { user: 'alice' },
      },
    }),
  );
  if (evaluated?.data?.result?.[0]?.expressions?.[0]?.value !== true) {
    fail(`rego_eval did not allow the test input: ${JSON.stringify(evaluated).slice(0, 300)}`);
  }
  console.log('  rego_eval ok');

  console.log(`PASS: plugin ${manifest.version} starts and runs`);
} catch (e) {
  console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  done = true;
  // Stop the whole tree (npx, the server, its opa): Windows keeps the folder
  // while any of them holds it.
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    try {
      if (windows) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill();
    }
    await exited;
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
