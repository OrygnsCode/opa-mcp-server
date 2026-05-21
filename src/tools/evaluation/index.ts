/**
 * Category B -- Evaluation & testing.
 *
 * Tools in this category run Rego queries against policies + input,
 * with optional trace/profile/coverage output. They wrap `opa eval`,
 * `opa exec`, `opa test`, and `opa bench`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { registerRegoBench } from './bench.js';
import { registerRegoCompileQuery } from './compile.js';
import { registerOpaExec } from './exec.js';
import { registerRegoEval } from './eval.js';
import { registerRegoTest } from './test.js';

export function registerEvaluationTools(server: McpServer, config: Config): void {
  registerRegoEval(server, config); // registers rego_eval + 3 variants
  registerRegoTest(server, config);
  registerRegoBench(server, config);
  registerRegoCompileQuery(server, config);
  registerOpaExec(server, config);
}
