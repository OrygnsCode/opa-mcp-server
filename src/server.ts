#!/usr/bin/env node
/**
 * @orygn/opa-mcp — entry point.
 *
 * Initializes the MCP server, registers tools/prompts/resources,
 * and connects the stdio transport.
 *
 * IMPORTANT: never write to stdout from anywhere in this process —
 * stdout is the MCP protocol channel. Use `logger` (file) or stderr.
 */
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { loadConfig, type Config } from './config.js';
import { initLogger, logger } from './lib/logger.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools } from './tools/index.js';

export const SERVER_NAME = 'orygn-opa-mcp';
export const SERVER_VERSION = '0.1.0';

/**
 * Construct an `McpServer`, register every tool / prompt / resource
 * onto it, and return it. Exported for tests so they can drive a
 * fully-loaded server without standing up a stdio transport.
 */
export function buildServer(config: Config): McpServer {
  initLogger(config.logFile, config.logLevel);

  logger.info('starting orygn-opa-mcp', {
    version: SERVER_VERSION,
    opaUrl: config.opaUrl,
    opaBinary: config.opaBinary,
    regalBinary: config.regalBinary,
  });

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerTools(server, config);
  registerPrompts(server, config);
  registerResources(server, config);

  return server;
}

/**
 * Entry-point flow: load config from env, build the server, connect
 * to the supplied transport (defaults to stdio for production).
 *
 * Tests pass an in-memory transport so the connection succeeds
 * without touching real stdio. Production callers omit the argument
 * and get the standard stdio transport.
 */
export async function main(transport?: Transport): Promise<McpServer> {
  const config = loadConfig();
  const server = buildServer(config);

  const connectTo = transport ?? new StdioServerTransport();
  await server.connect(connectTo);

  logger.info('connected to transport, ready for requests');
  return server;
}

/**
 * Auto-run when this module is invoked as the entry point (`node
 * dist/server.js` or via the `opa-mcp` bin shim). Tests that import
 * `server.ts` directly do not trip this branch.
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((cause: unknown) => {
    logger.error('fatal error in server entry', { error: cause });
    console.error('orygn-opa-mcp fatal error:', cause);
    process.exit(1);
  });
}
