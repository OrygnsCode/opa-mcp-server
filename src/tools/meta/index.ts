/**
 * Category F -- Meta / server info.
 *
 * Tools that expose information about the MCP server itself rather than
 * the OPA runtime or Rego policies.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { registerMcpServerInfo } from './server-info.js';

export function registerMetaTools(server: McpServer, config: Config): void {
  registerMcpServerInfo(server, config);
}
