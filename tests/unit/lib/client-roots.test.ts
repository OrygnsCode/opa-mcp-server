/**
 * MCP roots as the allow-list when OPA_MCP_ALLOWED_PATHS is unset.
 *
 * The end-to-end cases drive a real server through an in-memory transport
 * with a client that answers `roots/list`. They tell an allowed path from a
 * refused one by asking rego_check about a file that does not exist: inside
 * the roots that is PATH_NOT_FOUND, outside them PATH_NOT_ALLOWED, and no
 * binary is ever run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { Config } from '../../../src/config.js';
import {
  ROOTS_REQUEST_TIMEOUT_MS,
  ROOTS_RETRY_AFTER_MS,
  ROOTS_WAIT_MS,
  rootsToPaths,
} from '../../../src/lib/client-roots.js';
import { buildServer } from '../../../src/server.js';
import type { ToolEnvelope } from '../../../src/types.js';

const WINDOWS = process.platform === 'win32';

const scratch = mkdtempSync(join(tmpdir(), 'opa-mcp-roots-'));
const dirA = mkdtempSync(join(scratch, 'a-'));
const dirB = mkdtempSync(join(scratch, 'b-'));
const dirC = mkdtempSync(join(scratch, 'c-'));
const missingBinary = join(scratch, 'no-such-binary');

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

const baseConfig: Config = {
  opaUrl: 'http://localhost:8181',
  // Absolute paths that do not exist: mcp_server_info probes the binaries,
  // and a test must neither find a real one nor wait on a PATH search.
  opaBinary: missingBinary,
  regalBinary: missingBinary,
  conftestBinary: missingBinary,
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(scratch, 'server.log'),
  logLevel: 'error',
  maxResponseBytes: 100_000,
  maxSubprocessBytes: 32 * 1024 * 1024,
};

const uri = (p: string) => pathToFileURL(p).href;

type RootsResult = { roots: Array<{ uri: string; name?: string }> };
type RootsAnswer = () => RootsResult | Promise<RootsResult>;

/** Connect a client to a fresh server. `answer` undefined means a client without roots. */
async function connect(config: Config, answer?: RootsAnswer) {
  const server = buildServer(config);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'roots-test', version: '0.0.0' },
    answer === undefined ? {} : { capabilities: { roots: { listChanged: true } } },
  );
  const handler = vi.fn(answer ?? (() => ({ roots: [] })));
  if (answer !== undefined) client.setRequestHandler(ListRootsRequestSchema, handler);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, handler, server, clientTransport, close: () => client.close() };
}

async function call<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolEnvelope<T>> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as ToolEnvelope<T>;
}

/** rego_check on a file that does not exist: the error code says whether the path was allowed. */
async function access(client: Client, dir: string): Promise<string | undefined> {
  const env = await call(client, 'rego_check', { paths: [join(dir, 'missing.rego')] });
  return env.error?.code;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ServerInfo {
  allowedPaths: string[];
  allowedPathsSource: string;
}

describe('rootsToPaths', () => {
  it('keeps absolute file: URIs and decodes them', () => {
    const spaced = join(dirA, 'My Policies');
    const { paths, skipped } = rootsToPaths([{ uri: uri(dirA) }, { uri: uri(spaced) }]);
    expect(paths).toEqual([dirA, spaced]);
    expect(skipped).toEqual([]);
  });

  it('skips anything that is not a file: URI naming an absolute path', () => {
    const { paths, skipped } = rootsToPaths([
      { uri: 'https://example.com/policies' },
      { uri: 'not a uri' },
      { uri: '' },
      // An encoded separator cannot be placed exactly, so it is refused.
      { uri: WINDOWS ? 'file:///c%3A/src%2Fx' : 'file:///src%2Fx' },
    ]);
    expect(paths).toEqual([]);
    expect(skipped.map((s) => s.uri)).toEqual([
      'https://example.com/policies',
      'not a uri',
      '',
      WINDOWS ? 'file:///c%3A/src%2Fx' : 'file:///src%2Fx',
    ]);
  });

  it('drops duplicates, including a trailing slash and dot segments', () => {
    const { paths } = rootsToPaths([
      { uri: uri(dirA) },
      { uri: uri(dirA) + '/sub/..' },
      { uri: uri(dirA) + '/' },
    ]);
    expect(paths).toEqual([dirA]);
  });

  it.runIf(WINDOWS)('decodes a percent-encoded drive colon, as VS Code sends it', () => {
    const { paths } = rootsToPaths([{ uri: 'file:///c%3A/src/posts-api' }]);
    expect(paths).toEqual(['c:\\src\\posts-api']);
  });

  it.runIf(WINDOWS)('treats drive letters of either case as the same root', () => {
    const { paths } = rootsToPaths([
      { uri: 'file:///C:/src/posts-api' },
      { uri: 'file:///c%3A/src/posts-api' },
    ]);
    expect(paths).toEqual(['C:\\src\\posts-api']);
  });

  it.runIf(WINDOWS)('keeps a UNC share as the share the client named', () => {
    expect(rootsToPaths([{ uri: 'file://server/share/policies' }]).paths).toEqual([
      '\\\\server\\share\\policies',
    ]);
  });

  it.runIf(!WINDOWS)('skips a file: URI with a host off Windows', () => {
    const { paths, skipped } = rootsToPaths([{ uri: 'file://server/share/policies' }]);
    expect(paths).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it.runIf(WINDOWS)('refuses a POSIX path on Windows', () => {
    expect(rootsToPaths([{ uri: 'file:///home/me/policies' }]).paths).toEqual([]);
  });

  it.runIf(!WINDOWS)('takes a drive-like path literally off Windows', () => {
    // On POSIX `/C:/x` is a legal absolute path; nothing is guessed.
    expect(rootsToPaths([{ uri: 'file:///C:/x' }]).paths).toEqual(['/C:/x']);
  });
});

describe('client roots with OPA_MCP_ALLOWED_PATHS unset', () => {
  it('allows exactly the folders the client lists', async () => {
    const { client, handler, close } = await connect(baseConfig, () => ({
      roots: [{ uri: uri(dirA), name: 'a' }],
    }));
    expect(await access(client, dirA)).toBe('PATH_NOT_FOUND');
    const refused = await call(client, 'rego_check', { paths: [join(dirB, 'missing.rego')] });
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(refused.error?.hint).toContain('MCP roots');
    expect(handler).toHaveBeenCalledTimes(1);

    const info = await call<ServerInfo>(client, 'mcp_server_info', {});
    expect(info.data?.allowedPaths).toEqual([dirA]);
    expect(info.data?.allowedPathsSource).toBe('client-roots');
    await close();
  });

  it.runIf(WINDOWS)(
    'accepts either drive-letter case against a root sent as VS Code sends it',
    async () => {
      // The VS Code extension sends `file:///c%3A/...`; a model often writes `C:\...`.
      const rest = encodeURI(dirA.slice(2).replace(/\\/g, '/'));
      const vscodeUri = `file:///${dirA[0]!.toLowerCase()}%3A${rest}`;
      const { client, close } = await connect(baseConfig, () => ({ roots: [{ uri: vscodeUri }] }));
      const upper = dirA[0]!.toUpperCase() + dirA.slice(1);
      const lower = dirA[0]!.toLowerCase() + dirA.slice(1);
      expect(await access(client, upper)).toBe('PATH_NOT_FOUND');
      expect(await access(client, lower)).toBe('PATH_NOT_FOUND');
      expect(await access(client, dirB)).toBe('PATH_NOT_ALLOWED');
      await close();
    },
  );

  it('waits for a slow first answer instead of refusing the first tool call', async () => {
    const { client, close } = await connect(baseConfig, async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { roots: [{ uri: uri(dirA) }] };
    });
    expect(await access(client, dirA)).toBe('PATH_NOT_FOUND');
    await close();
  });

  it('asks again when the client reports a change, and uses only the new list', async () => {
    let roots = [{ uri: uri(dirA) }];
    const { client, handler, close } = await connect(baseConfig, () => ({ roots }));
    expect(await access(client, dirA)).toBe('PATH_NOT_FOUND');

    roots = [{ uri: uri(dirB) }];
    await client.sendRootsListChanged();
    expect(await access(client, dirB)).toBe('PATH_NOT_FOUND');
    expect(await access(client, dirA)).toBe('PATH_NOT_ALLOWED');
    expect(handler).toHaveBeenCalledTimes(2);
    await close();
  });

  it('does not let a slow old answer overwrite a newer one', async () => {
    let calls = 0;
    const { client, close } = await connect(baseConfig, async () => {
      calls++;
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 300));
        return { roots: [{ uri: uri(dirA) }] };
      }
      return { roots: [{ uri: uri(dirB) }] };
    });
    // The change arrives while the first request is still unanswered.
    await client.sendRootsListChanged();
    expect(await access(client, dirB)).toBe('PATH_NOT_FOUND');
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(2);
    expect(await access(client, dirB)).toBe('PATH_NOT_FOUND');
    expect(await access(client, dirA)).toBe('PATH_NOT_ALLOWED');
    await close();
  });

  it('refuses a removed root while a second change is still being answered', async () => {
    // Roots go A -> B -> C. A call on A made between the two changes must not
    // be checked against the list from before both of them.
    let roots = [{ uri: uri(dirA) }];
    let delay = 0;
    const { client, handler, close } = await connect(baseConfig, async () => {
      const answer = { roots };
      await sleep(delay);
      return answer;
    });
    expect(await access(client, dirA)).toBe('PATH_NOT_FOUND');

    roots = [{ uri: uri(dirB) }];
    delay = 200;
    await client.sendRootsListChanged();
    const onA = access(client, dirA);
    await sleep(50);
    roots = [{ uri: uri(dirC) }];
    delay = 400;
    await client.sendRootsListChanged();

    expect(await onA).toBe('PATH_NOT_ALLOWED');
    expect(await access(client, dirC)).toBe('PATH_NOT_FOUND');
    expect(await access(client, dirB)).toBe('PATH_NOT_ALLOWED');
    // One request at a time: the initial one, the one the first change
    // started, and one more for the change that arrived while it was out.
    expect(handler).toHaveBeenCalledTimes(3);
    await close();
  });

  it('keeps one request outstanding when changes arrive faster than answers', async () => {
    let roots = [{ uri: uri(dirA) }];
    let delay = 0;
    const { client, handler, close } = await connect(baseConfig, async () => {
      const answer = { roots };
      await sleep(delay);
      return answer;
    });
    expect(await access(client, dirA)).toBe('PATH_NOT_FOUND');
    roots = [{ uri: uri(dirB) }];
    delay = 100;
    for (let i = 0; i < 10; i++) await client.sendRootsListChanged();
    expect(await access(client, dirB)).toBe('PATH_NOT_FOUND');
    expect(await access(client, dirA)).toBe('PATH_NOT_ALLOWED');
    expect(handler.mock.calls.length).toBeLessThanOrEqual(3);
    await close();
  });

  it('asks again on a later call once a failure is old enough', async () => {
    let fail = true;
    const { client, handler, close } = await connect(baseConfig, () => {
      if (fail) throw new McpError(-32603, 'not ready');
      return { roots: [{ uri: uri(dirA) }] };
    });
    expect(await access(client, dirA)).toBe('PATH_NOT_ALLOWED');
    fail = false;
    // Too soon: no new request, still refused.
    expect(await access(client, dirA)).toBe('PATH_NOT_ALLOWED');
    expect(handler).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ROOTS_RETRY_AFTER_MS + 1_000);
    expect(await access(client, dirA)).toBe('PATH_NOT_FOUND');
    expect(handler).toHaveBeenCalledTimes(2);
    await close();
  });

  it('refuses everything when the wait runs out with a change still unanswered', async () => {
    let answer = true;
    const { client, close } = await connect(baseConfig, () =>
      answer ? { roots: [{ uri: uri(dirA) }] } : new Promise<RootsResult>(() => {}),
    );
    expect(await access(client, dirA)).toBe('PATH_NOT_FOUND');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    answer = false;
    await client.sendRootsListChanged();
    const pending = call(client, 'rego_check', { paths: [join(dirA, 'missing.rego')] });
    // A second change before the first request times out keeps a request
    // outstanding past the call's wait.
    await vi.advanceTimersByTimeAsync(ROOTS_REQUEST_TIMEOUT_MS - 1_000);
    await client.sendRootsListChanged();
    await vi.advanceTimersByTimeAsync(ROOTS_WAIT_MS);
    const refused = await pending;
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(refused.error?.message).toContain('not yet answered');
    await close();
  });

  it('ignores a change notice from a client that never declared roots', async () => {
    const { client, server, clientTransport, close } = await connect(baseConfig);
    const listRoots = vi.spyOn(server.server, 'listRoots');
    // The SDK client will not send this without the capability, so it goes
    // straight onto the transport.
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
    expect(await access(client, dirA)).toBe('PATH_NOT_ALLOWED');
    expect(listRoots).not.toHaveBeenCalled();
    await close();
  });

  it('disables file tools when a refresh fails, rather than keeping the old list', async () => {
    let fail = false;
    const { client, close } = await connect(baseConfig, () => {
      if (fail) throw new McpError(-32603, 'workspace unavailable');
      return { roots: [{ uri: uri(dirA) }] };
    });
    expect(await access(client, dirA)).toBe('PATH_NOT_FOUND');

    fail = true;
    await client.sendRootsListChanged();
    const refused = await call(client, 'rego_check', { paths: [join(dirA, 'missing.rego')] });
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(refused.error?.message).toContain('could not be read');
    expect(refused.error?.message).toContain('workspace unavailable');
    await close();
  });

  it('says so when the client shares no folders', async () => {
    const { client, close } = await connect(baseConfig, () => ({ roots: [] }));
    const refused = await call(client, 'rego_check', { paths: [join(dirA, 'missing.rego')] });
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(refused.error?.message).toContain('shares no folders');
    const info = await call<ServerInfo>(client, 'mcp_server_info', {});
    expect(info.data?.allowedPathsSource).toBe('none');
    expect(info.data?.allowedPaths).toEqual([]);
    await close();
  });

  it('refuses everything when the answer is malformed', async () => {
    const { client, close } = await connect(baseConfig, () => ({
      roots: [{ uri: uri(dirA) }, { uri: 'https://example.com/x' }],
    }));
    // The SDK rejects the whole answer: roots must be file:// URIs.
    const refused = await call(client, 'rego_check', { paths: [join(dirA, 'missing.rego')] });
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(refused.error?.message).toContain('could not be read');
    await close();
  });

  it('uses the good roots and skips one it cannot place', async () => {
    const bad = WINDOWS ? 'file:///c%3A/src%2Fx' : 'file:///src%2Fx';
    const { client, close } = await connect(baseConfig, () => ({
      roots: [{ uri: bad }, { uri: uri(dirA) }],
    }));
    expect(await access(client, dirA)).toBe('PATH_NOT_FOUND');
    const info = await call<ServerInfo>(client, 'mcp_server_info', {});
    expect(info.data?.allowedPaths).toEqual([dirA]);
    await close();
  });

  it('gives up on a client that never answers, and fails closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, close } = await connect(baseConfig, () => new Promise(() => {}));
    const pending = call(client, 'rego_check', { paths: [join(dirA, 'missing.rego')] });
    await vi.advanceTimersByTimeAsync(ROOTS_REQUEST_TIMEOUT_MS + 100);
    const refused = await pending;
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(refused.error?.message).toContain('could not be read');
    await close();
  });

  it('keeps file tools disabled for a client without roots', async () => {
    const { client, close } = await connect(baseConfig);
    const refused = await call(client, 'rego_check', { paths: [join(dirA, 'missing.rego')] });
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(refused.error?.message).toBe(
      'File-based tools are disabled because OPA_MCP_ALLOWED_PATHS is empty.',
    );
    const info = await call<ServerInfo>(client, 'mcp_server_info', {});
    expect(info.data?.allowedPathsSource).toBe('none');
    await close();
  });

  it('keeps the roots of two servers built from one config apart', async () => {
    const one = await connect(baseConfig, () => ({ roots: [{ uri: uri(dirA) }] }));
    const two = await connect(baseConfig, () => ({ roots: [{ uri: uri(dirB) }] }));
    expect(await access(one.client, dirA)).toBe('PATH_NOT_FOUND');
    expect(await access(one.client, dirB)).toBe('PATH_NOT_ALLOWED');
    expect(await access(two.client, dirB)).toBe('PATH_NOT_FOUND');
    expect(await access(two.client, dirA)).toBe('PATH_NOT_ALLOWED');
    await one.close();
    await two.close();
  });
});

describe('client roots with OPA_MCP_NO_CLIENT_ROOTS=1', () => {
  it('never asks the client and keeps file tools off', async () => {
    const config = { ...baseConfig, ignoreClientRoots: true };
    const { client, handler, close } = await connect(config, () => ({
      roots: [{ uri: uri(dirA) }],
    }));
    const refused = await call(client, 'rego_check', { paths: [join(dirA, 'missing.rego')] });
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(refused.error?.message).toBe(
      'File-based tools are disabled because OPA_MCP_ALLOWED_PATHS is empty.',
    );
    await client.sendRootsListChanged();
    expect(await access(client, dirA)).toBe('PATH_NOT_ALLOWED');
    expect(handler).not.toHaveBeenCalled();
    const info = await call<ServerInfo>(client, 'mcp_server_info', {});
    expect(info.data?.allowedPathsSource).toBe('none');
    await close();
  });
});

describe('client roots with OPA_MCP_ALLOWED_PATHS set', () => {
  it('uses the environment list and never asks the client', async () => {
    const config = { ...baseConfig, allowedPaths: [dirB] };
    const { client, handler, close } = await connect(config, () => ({
      roots: [{ uri: uri(dirA) }],
    }));
    expect(await access(client, dirB)).toBe('PATH_NOT_FOUND');
    const refused = await call(client, 'rego_check', { paths: [join(dirA, 'missing.rego')] });
    expect(refused.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(refused.error?.hint).toContain('OPA_MCP_ALLOWED_PATHS');
    expect(refused.error?.hint).not.toContain('MCP roots');

    await client.sendRootsListChanged();
    expect(await access(client, dirA)).toBe('PATH_NOT_ALLOWED');
    expect(handler).not.toHaveBeenCalled();

    const info = await call<ServerInfo>(client, 'mcp_server_info', {});
    expect(info.data?.allowedPaths).toEqual([dirB]);
    expect(info.data?.allowedPathsSource).toBe('env');
    await close();
  });
});
