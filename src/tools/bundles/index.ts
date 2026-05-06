/**
 * Category C — Bundle operations.
 *
 * Wraps `opa build` and `opa sign` for packaging and signing
 * deployable bundles.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { registerOpaBundleBuild } from './build.js';
import { registerOpaBundleSign } from './sign.js';

export function registerBundleTools(server: McpServer, config: Config): void {
  registerOpaBundleBuild(server, config);
  registerOpaBundleSign(server, config);
}
