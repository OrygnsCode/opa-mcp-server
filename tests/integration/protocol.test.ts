/**
 * MCP protocol conformance tests.
 *
 * The unit tests under `tests/unit/tools/` invoke each tool's handler
 * directly and bypass the MCP SDK's request/response machinery. These
 * tests connect a real Client to our server through an in-memory
 * linked transport, drive every protocol method (`tools/list`,
 * `tools/call`, `prompts/list`, `prompts/get`, `resources/list`,
 * `resources/read`), and verify both the wire shapes and the SDK's
 * Zod input validation layer.
 *
 * Mocks `node:child_process` and `globalThis.fetch` to keep tool
 * invocations deterministic — the focus here is the protocol, not
 * the underlying CLI/HTTP behavior (which is covered by Phase 2 and
 * the OpaCli/RegalCli integration tests).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../src/config.js';
import type { ToolEnvelope } from '../../src/types.js';
import { registerTools } from '../../src/tools/index.js';
import { registerPrompts } from '../../src/prompts/index.js';
import { registerResources } from '../../src/resources/index.js';

vi.mock('../../src/lib/subprocess.js', () => ({
  runBinary: vi.fn(),
}));
import { runBinary } from '../../src/lib/subprocess.js';
const mockRun = vi.mocked(runBinary);

// Mock global fetch for HTTP-bound tools.
let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

const baseConfig: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: 'opa',
  regalBinary: 'regal',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: ['/abs'],
  logFile: '/tmp/protocol-test.log',
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

const okSpawn = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  durationMs: 1,
};

/**
 * Narrow a resource content item to its text form. The MCP SDK types
 * the content union as `{text}` xor `{blob}`; every resource we ship
 * is text-based so we throw if the runtime ever sees a blob entry.
 */
function asText(item: { text?: string; blob?: string }): string {
  if (typeof item.text !== 'string') {
    throw new Error('Expected resource content with `text` field; got blob or empty.');
  }
  return item.text;
}

async function buildServerAndClient(): Promise<{
  client: Client;
  server: McpServer;
}> {
  const server = new McpServer({ name: 'orygn-opa-mcp-test', version: '0.0.0' });
  registerTools(server, baseConfig);
  registerPrompts(server, baseConfig);
  registerResources(server, baseConfig);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const okJsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

beforeAll(() => {
  // Suppress any stray logger init.
  process.env['OPA_MCP_LOG_FILE'] = '/tmp/protocol-test.log';
});

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue(okSpawn);
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ─── tools/list ────────────────────────────────────────────────────────────

describe('tools/list', () => {
  it('returns all 32 registered tools with required protocol fields', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.listTools();
    expect(result.tools).toHaveLength(32);
    for (const tool of result.tools) {
      expect(tool.name).toMatch(/^(rego_|opa_)/);
      expect(typeof tool.description).toBe('string');
      expect((tool.description ?? '').length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('exposes the five planned categories', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    // Authoring (Category A)
    expect(names).toEqual(
      expect.arrayContaining([
        'rego_format',
        'rego_check',
        'rego_lint',
        'rego_parse_ast',
        'rego_inspect',
        'rego_capabilities',
        'rego_deps',
      ]),
    );
    // Evaluation (Category B)
    expect(names).toEqual(
      expect.arrayContaining([
        'rego_eval',
        'rego_eval_with_explain',
        'rego_eval_with_profile',
        'rego_eval_with_coverage',
        'rego_test',
        'rego_bench',
        'rego_compile_query',
      ]),
    );
    // Bundles (Category C)
    expect(names).toEqual(expect.arrayContaining(['opa_bundle_build', 'opa_bundle_sign']));
    // Server management (Category D)
    expect(names).toEqual(
      expect.arrayContaining([
        'opa_list_policies',
        'opa_get_policy',
        'opa_put_policy',
        'opa_delete_policy',
        'opa_get_data',
        'opa_put_data',
        'opa_patch_data',
        'opa_query_decision',
        'opa_compile_query',
        'opa_health',
        'opa_status',
        'opa_config',
      ]),
    );
    // Helpers (Category E)
    expect(names).toEqual(
      expect.arrayContaining([
        'rego_explain_decision',
        'rego_generate_test_skeleton',
        'rego_describe_policy',
        'rego_suggest_fix',
      ]),
    );
  });

  it('produces JSON Schema with property descriptions for input fields', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.listTools();
    const fmt = result.tools.find((t) => t.name === 'rego_format');
    expect(fmt).toBeDefined();
    const schema = fmt!.inputSchema as {
      properties?: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(schema.properties?.['source']?.description).toMatch(/Rego source/);
    expect(schema.required).toContain('source');
  });
});

// ─── tools/call: dispatch + envelope shape ────────────────────────────────

describe('tools/call', () => {
  it('dispatches to the registered handler and wraps the envelope in MCP content', async () => {
    mockRun.mockResolvedValueOnce({ ...okSpawn, stdout: 'package x\n\nallow := true\n' });
    const { client } = await buildServerAndClient();
    const result = await client.callTool({
      name: 'rego_format',
      arguments: { source: 'package x\nallow{true}' },
    });
    expect(Array.isArray(result.content)).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(text?.type).toBe('text');
    const envelope = JSON.parse(text!.text!) as ToolEnvelope<{
      formatted: string;
      changed: boolean;
    }>;
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.changed).toBe(true);
  });

  it('returns isError: true when the tool envelope is an error', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.callTool({
      name: 'rego_check',
      arguments: {}, // missing both source and paths — runtime validation rejects
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0];
    const envelope = JSON.parse(text!.text!) as ToolEnvelope<unknown>;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('returns isError for unknown tool names with the SDK error code in the message', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.callTool({ name: 'nonexistent_tool', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(text).toMatch(/Tool nonexistent_tool not found/i);
    expect(text).toMatch(/-32602/);
  });

  it('rejects malformed input via the SDK Zod layer (before our handler runs)', async () => {
    const { client } = await buildServerAndClient();
    // rego_format requires `source: string` with min length 1.
    // Passing a number violates the type, which the SDK Zod layer
    // catches before our handler.
    const result = await client.callTool({
      name: 'rego_format',
      arguments: { source: 12345 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(text?.text).toMatch(/(Invalid|expected|string)/i);
  });

  it('rejects empty source via Zod min-length validation', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.callTool({
      name: 'rego_format',
      arguments: { source: '' },
    });
    expect(result.isError).toBe(true);
  });

  it('passes structured input through to the handler intact', async () => {
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      stdout: JSON.stringify({ result: [{ expressions: [{ value: 'ok' }] }] }),
    });
    const { client } = await buildServerAndClient();
    const result = await client.callTool({
      name: 'rego_eval',
      arguments: {
        query: 'data.x.allow',
        source: 'package x\nimport rego.v1\nallow := true',
        input: { user: 'alice', meta: { tier: 'pro' } },
      },
    });
    const envelope = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    ) as ToolEnvelope<unknown>;
    expect(envelope.ok).toBe(true);
    // The handler should have received the structured input and
    // serialized it through to stdin.
    const opts = mockRun.mock.calls.at(-1)![1];
    expect(opts.stdin).toBe(JSON.stringify({ user: 'alice', meta: { tier: 'pro' } }));
  });
});

// ─── tools/call against HTTP-bound tools ──────────────────────────────────

describe('tools/call — server-management tools', () => {
  it('opa_list_policies dispatches and forwards JSON results', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({ result: [{ id: 'rbac' }] }),
    );
    const { client } = await buildServerAndClient();
    const result = await client.callTool({ name: 'opa_list_policies', arguments: {} });
    const env = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    ) as ToolEnvelope<{ policies: Array<{ id: string }> }>;
    expect(env.ok).toBe(true);
    expect(env.data?.policies[0]?.id).toBe('rbac');
  });

  it('opa_health surfaces OPA_UNREACHABLE on connection failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { client } = await buildServerAndClient();
    const result = await client.callTool({ name: 'opa_health', arguments: {} });
    const env = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    ) as ToolEnvelope<unknown>;
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
  });
});

// ─── prompts ──────────────────────────────────────────────────────────────

describe('prompts/list and prompts/get', () => {
  it('lists all three registered prompts with arg schemas', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.listPrompts();
    expect(result.prompts).toHaveLength(3);
    const names = result.prompts.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'policy_authoring_assistant',
        'policy_review_checklist',
        'decision_debugging_workflow',
      ]),
    );
    for (const prompt of result.prompts) {
      expect(prompt.description).toBeDefined();
      expect(prompt.arguments).toBeDefined();
    }
  });

  it('renders policy_authoring_assistant with provided args', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.getPrompt({
      name: 'policy_authoring_assistant',
      arguments: {
        description: 'Allow editors to publish drafts',
        package_name: 'cms.publish',
      },
    });
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg?.role).toBe('user');
    const text = (msg?.content as { type: string; text?: string }).text ?? '';
    expect(text).toContain('Allow editors to publish drafts');
    expect(text).toContain('cms.publish');
    expect(text).toContain('rego_format');
    expect(text).toContain('rego_check');
    expect(text).toContain('rego_test');
  });

  it('falls back to placeholder text when prompt args are omitted', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.getPrompt({
      name: 'decision_debugging_workflow',
      arguments: {},
    });
    const text = (
      result.messages[0]?.content as { type: string; text?: string }
    ).text ?? '';
    expect(text).toContain('not provided');
    expect(text).toContain('rego_explain_decision');
  });

  it('rejects unknown prompt names', async () => {
    const { client } = await buildServerAndClient();
    await expect(
      client.getPrompt({ name: 'no_such_prompt', arguments: {} }),
    ).rejects.toThrow();
  });
});

// ─── resources ────────────────────────────────────────────────────────────

describe('resources/list and resources/read', () => {
  it('lists all three registered resources with required protocol fields', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.listResources();
    expect(result.resources).toHaveLength(3);
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining(['opa://builtins', 'opa://style-guide', 'opa://patterns']),
    );
    for (const resource of result.resources) {
      expect(resource.name).toBeDefined();
      expect(resource.description).toBeDefined();
      expect(resource.mimeType).toBeDefined();
    }
  });

  it('reads opa://style-guide and returns markdown content', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.readResource({ uri: 'opa://style-guide' });
    expect(result.contents).toHaveLength(1);
    const item = result.contents[0]!;
    expect(item.uri).toBe('opa://style-guide');
    expect(item.mimeType).toBe('text/markdown');
    const text = asText(item);
    expect(text.length).toBeGreaterThan(500);
    expect(text).toContain('# Rego style guide');
  });

  it('reads opa://patterns and returns the curated pattern library', async () => {
    const { client } = await buildServerAndClient();
    const result = await client.readResource({ uri: 'opa://patterns' });
    const text = asText(result.contents[0]!);
    expect(text).toContain('# Rego pattern library');
    expect(text).toContain('## 1. Role-based access control');
    expect(text).toContain('## 6. Rate limiting');
  });

  it('reads opa://builtins by invoking opa capabilities --current', async () => {
    mockRun.mockResolvedValueOnce({
      ...okSpawn,
      stdout: JSON.stringify({
        builtins: [
          { name: 'http.send', categories: ['http'] },
          { name: 'count', categories: ['aggregates'] },
        ],
        future_keywords: ['contains', 'in'],
        features: [],
        wasm_abi_versions: [],
      }),
    });
    const { client } = await buildServerAndClient();
    const result = await client.readResource({ uri: 'opa://builtins' });
    const item = result.contents[0]!;
    expect(item.mimeType).toBe('application/json');
    const parsed = JSON.parse(asText(item)) as {
      builtin_count: number;
      categories: Record<string, string[]>;
      security_sensitive_builtins: string[];
    };
    expect(parsed.builtin_count).toBe(2);
    expect(parsed.categories['http']).toEqual(['http.send']);
    expect(parsed.security_sensitive_builtins).toContain('http.send');
  });

  it('rejects unknown resource URIs', async () => {
    const { client } = await buildServerAndClient();
    await expect(client.readResource({ uri: 'opa://nonexistent' })).rejects.toThrow();
  });
});
