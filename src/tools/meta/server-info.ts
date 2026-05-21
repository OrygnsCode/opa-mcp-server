/**
 * `mcp_server_info` -- return version and runtime info for this MCP
 * server instance so a connected LLM can answer "what version am I on"
 * without inspecting the initialize handshake directly.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { SERVER_NAME, SERVER_VERSION } from '../../constants.js';
import { ok } from '../../lib/errors.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { RegalCli } from '../../lib/regal-cli.js';
import { withToolEnvelope } from '../../lib/tool-helpers.js';

export interface McpServerInfoOutput {
  name: string;
  version: string;
  opaVersion: string | null;
  regalVersion: string | null;
  transport: 'stdio';
  node: string;
}

export function registerMcpServerInfo(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);
  const regal = new RegalCli(config);

  server.registerTool(
    'mcp_server_info',
    {
      title: 'MCP server info',
      description:
        'Return the name, version, and runtime details of this opa-mcp server instance. Use this when you need to confirm which version of opa-mcp is running, or to verify that the OPA and Regal binaries are reachable.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_input, { signal }) => {
      return withToolEnvelope<McpServerInfoOutput>(config, async () => {
        const [opaVersion, regalVersion] = await Promise.all([
          opa.version(signal).catch(() => null),
          regal.version(signal).catch(() => null),
        ]);

        return ok<McpServerInfoOutput>({
          name: SERVER_NAME,
          version: SERVER_VERSION,
          opaVersion,
          regalVersion,
          transport: 'stdio',
          node: process.version,
        });
      });
    },
  );
}
