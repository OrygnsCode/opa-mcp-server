/**
 * Category D — OPA server management.
 *
 * Tools in this category talk to a running OPA server via its REST
 * API. They require the `OPA_URL` env var to point at a reachable
 * server (default `http://localhost:8181`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';

export function registerServerManagementTools(_server: McpServer, _config: Config): void {
  // Planned: opa_list_policies, opa_get_policy, opa_put_policy,
  //          opa_delete_policy, opa_get_data, opa_put_data,
  //          opa_patch_data, opa_query_decision, opa_compile_query,
  //          opa_health, opa_status, opa_config
}
