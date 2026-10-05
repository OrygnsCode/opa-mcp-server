/**
 * Unknown arguments are refused, through the SDK's own validation, for every
 * tool: an argument the tool does not declare used to be dropped silently.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { registerTools } from '../../../src/tools/index.js';
import { baseConfig } from './_helpers.js';

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0' });
  registerTools(server, baseConfig);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientSide);
  return client;
}

describe('unknown tool arguments', () => {
  it('are refused with the offending key named', async () => {
    const c = await connect();
    // A misspelling of `strict`: dropped silently, the check ran without it.
    const result = await c.callTool({
      name: 'rego_check',
      arguments: { source: 'package p\n\nallow if true\n', stirct: true },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/Unrecognized key/);
    expect(text).toMatch(/stirct/);
  });

  it('apply to every tool, and declared arguments still pass validation', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.length).toBe(52);
    for (const tool of tools) {
      expect(tool.inputSchema['additionalProperties'], tool.name).toBe(false);
    }
    // No OPA server is running, so opa_health fails either way; what matters
    // is whether the failure is the argument check.
    const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
      (r.content as Array<{ text: string }>)[0]!.text;
    const declared = await c.callTool({ name: 'opa_health', arguments: {} });
    expect(text(declared)).not.toMatch(/Unrecognized key/);
    const unknown = await c.callTool({ name: 'opa_health', arguments: { verbose: true } });
    expect(text(unknown)).toMatch(/Unrecognized key.*verbose/);
  });
});
