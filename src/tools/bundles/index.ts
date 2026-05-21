/**
 * Category C -- Bundle operations.
 *
 * Wraps `opa build`, `opa sign`, and bundle signature verification for
 * packaging, signing, and verifying deployable bundles.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { registerOpaBundleBuild } from './build.js';
import { registerOpaBundleSign } from './sign.js';
import { registerOpaBundleVerify } from './verify.js';

export function registerBundleTools(server: McpServer, config: Config): void {
  registerOpaBundleBuild(server, config);
  registerOpaBundleSign(server, config);
  registerOpaBundleVerify(server, config);
}
