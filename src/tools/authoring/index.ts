/**
 * Category A -- Authoring & static analysis.
 *
 * Tools in this category operate on Rego source code without requiring
 * a running OPA server. They wrap `opa fmt`, `opa check`, `opa parse`,
 * `opa inspect`, `opa capabilities`, `opa deps`, and the `regal` linter.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { registerRegoCapabilities } from './capabilities.js';
import { registerRegoCheck } from './check.js';
import { registerRegoDeps } from './deps.js';
import { registerRegoFormat } from './format.js';
import { registerRegoInspect } from './inspect.js';
import { registerRegoLint } from './lint.js';
import { registerRegoParseAst } from './parse.js';

export function registerAuthoringTools(server: McpServer, config: Config): void {
  registerRegoFormat(server, config);
  registerRegoCheck(server, config);
  registerRegoLint(server, config);
  registerRegoParseAst(server, config);
  registerRegoInspect(server, config);
  registerRegoCapabilities(server, config);
  registerRegoDeps(server, config);
}
