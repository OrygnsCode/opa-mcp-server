/**
 * Shared test helpers for the per-tool unit tests.
 *
 * The pattern is the same for every tool: construct an McpServer,
 * register the tool, mock the CLI wrapper to a deterministic outcome,
 * invoke the registered handler, parse the JSON envelope from the
 * MCP result.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../../src/config.js';
import type { ToolEnvelope } from '../../../src/types.js';

/**
 * Resolve the absolute path to `tests/fixtures/`. Real files there
 * satisfy `mustExist` checks the tool layer makes via validatePath.
 */
export const fixturesDir = resolve(fileURLToPath(new URL('../../fixtures/', import.meta.url)));

export const baseConfig: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: 'opa',
  regalBinary: 'regal',
  conftestBinary: 'conftest',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [fixturesDir],
  logFile: '/tmp/test.log',
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

/**
 * Resolve a path beneath the fixtures directory. Returned paths are
 * absolute and exist on disk.
 */
export const fixturePath = (...segments: string[]): string => resolve(fixturesDir, ...segments);

export const okSpawn = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  durationMs: 1,
};

export function makeServer(): McpServer {
  return new McpServer({ name: 'test-server', version: '0.0.0' });
}

type ToolHandler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

interface RegisteredToolLike {
  handler: ToolHandler;
}

interface ServerWithTools {
  _registeredTools: Record<string, RegisteredToolLike>;
}

/**
 * Find a registered tool's handler by name. Throws if not registered
 * so the test fails loudly instead of silently passing.
 */
export function getToolHandler(server: McpServer, name: string): ToolHandler {
  const registry = (server as unknown as ServerWithTools)._registeredTools;
  const entry = registry[name];
  if (!entry) {
    throw new Error(`Tool ${name} was not registered on this server.`);
  }
  return entry.handler;
}

/**
 * Invoke a registered tool with the given input, parse the MCP
 * envelope from the JSON-encoded text content. The MCP transport
 * always wraps tool returns in `{ content: [{ type: 'text', text:
 * '<json>' }] }`, so the test envelope is the parsed text.
 */
export async function callTool<T = unknown>(
  server: McpServer,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolEnvelope<T>> {
  const handler = getToolHandler(server, name);
  const result = await handler(input, { signal: new AbortController().signal });
  const textChunk = result.content.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  );
  if (!textChunk) throw new Error(`Tool ${name} returned no text content.`);
  return JSON.parse(textChunk.text) as ToolEnvelope<T>;
}

/**
 * Common spawn-result builders for use in mocked subprocess returns.
 */
export const spawnSuccess = (stdout = '', stderr = '') => ({
  ...okSpawn,
  stdout,
  stderr,
});

export const spawnFailure = (exitCode: number, stderr = '', stdout = '') => ({
  ...okSpawn,
  exitCode,
  stderr,
  stdout,
});

export const spawnUnreachable = () => ({
  ...okSpawn,
  exitCode: null,
  stderr: 'spawn ENOENT',
});

export const spawnTimedOut = () => ({
  ...okSpawn,
  exitCode: 137,
  timedOut: true,
});
