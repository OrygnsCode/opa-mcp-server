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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { logger } from './lib/logger.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools } from './tools/index.js';

const SERVER_NAME = 'orygn-opa-mcp';
const SERVER_VERSION = '0.1.0';

async function main(): Promise<void> {
  const config = loadConfig();

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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('connected to stdio transport, ready for requests');
}

main().catch((cause: unknown) => {
  logger.error('fatal error in server entry', { error: cause });
  console.error('orygn-opa-mcp fatal error:', cause);
  process.exit(1);
});
