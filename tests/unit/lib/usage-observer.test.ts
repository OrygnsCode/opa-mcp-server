import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Config } from '../../../src/config.js';
import { withToolEnvelope } from '../../../src/lib/tool-helpers.js';
import { observeToolCalls, outcomeOf } from '../../../src/lib/usage-observer.js';
import { __testing as reportTesting } from '../../../src/lib/usage-report.js';
import {
  __testing as stats,
  flush,
  startCounting,
  type DayTally,
} from '../../../src/lib/usage-stats.js';
import { buildServer, main } from '../../../src/server.js';
import { toolNames } from '../../../src/tools/index.js';

const config: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: 'opa',
  regalBinary: 'regal',
  conftestBinary: 'conftest',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-opa-mcp-observer-test.log'),
  logLevel: 'error',
  maxResponseBytes: 100_000,
  maxSubprocessBytes: 32 * 1024 * 1024,
};

const text = (s: string): Record<string, unknown> => ({
  content: [{ type: 'text', text: s }],
  isError: true,
});

describe('outcomeOf()', () => {
  it('is empty for a result that is not an error', () => {
    expect(outcomeOf({ content: [{ type: 'text', text: '{"ok":true}' }] })).toEqual({});
    expect(outcomeOf(undefined)).toEqual({});
  });

  it("reads the server's own error code from the envelope", () => {
    expect(outcomeOf(text('{"ok":false,"error":{"code":"EVAL_ERROR","message":"x"}}'))).toEqual({
      code: 'EVAL_ERROR',
    });
  });

  it('adds where an unexpected error was thrown, only for UNKNOWN_ERROR', () => {
    const unknown = text('{"ok":false,"error":{"code":"UNKNOWN_ERROR","message":"x"}}');
    expect(outcomeOf(unknown, 'TypeError@lib/x.js:1')).toEqual({
      code: 'UNKNOWN_ERROR',
      site: 'TypeError@lib/x.js:1',
    });
    const other = text('{"ok":false,"error":{"code":"EVAL_ERROR","message":"x"}}');
    expect(outcomeOf(other, 'TypeError@lib/x.js:1')).toEqual({ code: 'EVAL_ERROR' });
  });

  it('names the failures the SDK reports itself', () => {
    expect(
      outcomeOf(
        text(
          'MCP error -32602: Input validation error: Invalid arguments for tool rego_eval: [...]',
        ),
      ),
    ).toEqual({ code: 'INVALID_ARGUMENTS' });
    expect(outcomeOf(text('MCP error -32602: Tool nope not found'))).toEqual({
      code: 'UNKNOWN_TOOL',
    });
    expect(outcomeOf(text('something else went wrong'))).toEqual({ code: 'UNRECOGNIZED' });
    expect(outcomeOf(text('{"ok":false,"error":{"code":"has spaces"}}'))).toEqual({
      code: 'UNRECOGNIZED',
    });
  });
});

describe('observeToolCalls() on a real server', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opa-mcp-observer-'));
    stats.reset(dir);
  });

  afterEach(() => {
    stats.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  const tally = (): DayTally => {
    flush();
    const [file] = readdirSync(dir).filter((n) => n.startsWith('day-'));
    return JSON.parse(readFileSync(join(dir, file!), 'utf8')) as DayTally;
  };

  it('counts each call by how it ended, and passes everything through', async () => {
    startCounting({ onToolCall: () => {} });
    const server = buildServer(config);
    // Two tools of the test's own: one that throws, one that waits to be cancelled.
    server.registerTool('rego_crash_probe', { description: 'throws', inputSchema: {} }, () =>
      withToolEnvelope(config, () => {
        throw new TypeError('boom at /home/someone/secret.rego');
      }),
    );
    server.registerTool('rego_slow_probe', { description: 'waits', inputSchema: {} }, (_a, extra) =>
      withToolEnvelope(
        config,
        () =>
          new Promise<never>((_resolve, reject) =>
            extra.signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      ),
    );

    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const names = toolNames(server);
    await server.connect(observeToolCalls(serverSide, (n) => names.has(n)));
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(clientSide);

    const info = await client.callTool({ name: 'mcp_server_info', arguments: {} });
    expect(info.isError).toBeFalsy();
    const infoText = (info.content as Array<{ text: string }>)[0]!.text;
    expect((JSON.parse(infoText) as { ok: boolean }).ok).toBe(true);

    const bad = await client.callTool({ name: 'rego_eval', arguments: { bogus: 1 } });
    expect(bad.isError).toBe(true);
    const missing = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(missing.isError).toBe(true);
    const refused = await client.callTool({
      name: 'rego_check',
      arguments: { paths: [join(tmpdir(), 'nowhere', 'x.rego')] },
    });
    expect(refused.isError).toBe(true);
    const refusedCode = (
      JSON.parse((refused.content as Array<{ text: string }>)[0]!.text) as {
        error: { code: string };
      }
    ).error.code;
    const crashed = await client.callTool({ name: 'rego_crash_probe', arguments: {} });
    expect(crashed.isError).toBe(true);

    const controller = new AbortController();
    const slow = client.callTool({ name: 'rego_slow_probe', arguments: {} }, undefined, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(slow).rejects.toThrow();
    await vi.waitFor(() => expect(tally().failures['rego_slow_probe|CANCELLED']).toBe(1));

    expect(tally()).toEqual({
      tools: {
        mcp_server_info: 1,
        rego_eval: 1,
        other: 1,
        rego_check: 1,
        rego_crash_probe: 1,
        rego_slow_probe: 1,
      },
      failures: {
        'rego_eval|INVALID_ARGUMENTS': 1,
        'other|UNKNOWN_TOOL': 1,
        [`rego_check|${refusedCode}`]: 1,
        'rego_crash_probe|UNKNOWN_ERROR': 1,
        'rego_slow_probe|CANCELLED': 1,
      },
      // The test's stack is in src/ and tests/, not dist/.
      crashes: { 'rego_crash_probe|external': 1 },
      apps: ['claude-code'],
    });
    expect(refusedCode).toMatch(/^PATH_/);
    expect(JSON.stringify(tally())).not.toContain('someone');
    await client.close();
  });
});

describe('main() with usage stats on', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opa-mcp-main-usage-'));
    stats.reset(dir);
    reportTesting.reset();
  });

  afterEach(() => {
    reportTesting.reset();
    stats.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends the day’s report after the first tool call, and only then', async () => {
    const posted: string[] = [];
    reportTesting.use(
      {
        env: { OPA_MCP_TELEMETRY: 'on' },
        post: (_url, body) => {
          posted.push(body);
          return Promise.resolve(204);
        },
      },
      undefined,
      'off',
    );
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const running = main(serverSide);
    const client = new Client({ name: 'cursor-vscode', version: '1.0.0' });
    await client.connect(clientSide);
    await running;

    await client.listTools();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toHaveLength(0);

    await client.callTool({ name: 'mcp_server_info', arguments: {} });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const report = JSON.parse(posted[0]!) as Record<string, unknown>;
    expect(report).toMatchObject({ s: 1, app: 'cursor', install: 'source' });
    // From the real startup check, whatever opa this machine has.
    expect(report['opa_v']).toMatch(/^(?:\d+\.\d+|unknown)$/);

    await client.callTool({ name: 'mcp_server_info', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toHaveLength(1);
    await client.close();
  });

  it('says file tools use the client’s folders when it shares them', async () => {
    const posted: string[] = [];
    reportTesting.use(
      {
        env: { OPA_MCP_TELEMETRY: 'on' },
        post: (_url, body) => {
          posted.push(body);
          return Promise.resolve(204);
        },
      },
      undefined,
      'off',
    );
    const saved = process.env['OPA_MCP_ALLOWED_PATHS'];
    delete process.env['OPA_MCP_ALLOWED_PATHS'];
    try {
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      const running = main(serverSide);
      const client = new Client(
        { name: 'claude-code', version: '1.0.0' },
        { capabilities: { roots: {} } },
      );
      client.setRequestHandler(ListRootsRequestSchema, () => ({
        roots: [{ uri: pathToFileURL(dir).href }],
      }));
      await client.connect(clientSide);
      await running;
      await client.callTool({ name: 'mcp_server_info', arguments: {} });
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      expect((JSON.parse(posted[0]!) as { files: string }).files).toBe('roots');
      await client.close();
    } finally {
      if (saved !== undefined) process.env['OPA_MCP_ALLOWED_PATHS'] = saved;
    }
  });
});
