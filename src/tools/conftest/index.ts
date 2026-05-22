import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { registerConftestPull } from './pull.js';
import { registerConftestPush } from './push.js';
import { registerConftestTest } from './test.js';
import { registerConftestVerify } from './verify.js';

export function registerConftestTools(server: McpServer, config: Config): void {
  registerConftestTest(server, config);
  registerConftestVerify(server, config);
  registerConftestPull(server, config);
  registerConftestPush(server, config);
}
