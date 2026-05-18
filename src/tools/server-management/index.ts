/**
 * Category D -- OPA server management.
 *
 * Tools in this category talk to a running OPA server via its REST
 * API. They require `OPA_URL` to point at a reachable server (default
 * `http://localhost:8181`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { registerDataTools } from './data.js';
import { registerDecisionTools } from './decisions.js';
import { registerPolicyTools } from './policies.js';
import { registerStatusTools } from './status.js';

export function registerServerManagementTools(server: McpServer, config: Config): void {
  registerPolicyTools(server, config);
  registerDataTools(server, config);
  registerDecisionTools(server, config);
  registerStatusTools(server, config);
}
