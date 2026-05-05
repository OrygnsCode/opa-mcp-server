/**
 * Category C — Bundle operations.
 *
 * Wraps `opa build` and `opa sign` for packaging and signing
 * deployable bundles.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';

export function registerBundleTools(_server: McpServer, _config: Config): void {
  // Planned: opa_bundle_build, opa_bundle_sign
}
