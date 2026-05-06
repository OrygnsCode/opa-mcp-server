import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseConfig, callTool, makeServer } from './_helpers.js';
import { registerServerManagementTools } from '../../../src/tools/server-management/index.js';

/**
 * Mock the global fetch so we exercise the real OpaClient code paths
 * (URL construction, header handling, body serialization, error
 * mapping) and only stub the network boundary.
 */
type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;
const realFetch = globalThis.fetch;

const okResponse = (body: unknown, init: { status?: number; contentType?: string } = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': init.contentType ?? 'application/json' },
  });

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const lastFetchCall = (): { url: string; init: RequestInit } => {
  const call = fetchMock.mock.calls.at(-1)!;
  const [url, init] = call;
  return { url: typeof url === 'string' ? url : (url as URL).toString(), init };
};

// ─── Policies ─────────────────────────────────────────────────────────────

describe('opa_list_policies', () => {
  it('GETs /v1/policies and returns the array', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ result: [{ id: 'rbac', raw: 'package rbac' }] }),
    );
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool<{ policies: Array<{ id: string }> }>(
      server,
      'opa_list_policies',
      {},
    );
    expect(env.ok).toBe(true);
    expect(env.data?.policies).toHaveLength(1);
    expect(env.data?.policies[0]?.id).toBe('rbac');

    const { url, init } = lastFetchCall();
    expect(url).toBe('http://localhost:8181/v1/policies');
    expect(init.method).toBe('GET');
  });

  it('maps connection failure to OPA_UNREACHABLE', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_list_policies', {});
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
  });

  it('maps 401 to OPA_AUTH_FAILED', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ error: 'unauthorized' }, { status: 401 }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_list_policies', {});
    expect(env.error?.code).toBe('OPA_AUTH_FAILED');
  });
});

describe('opa_get_policy', () => {
  it('URL-encodes the policy ID and returns the policy', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ result: { id: 'auth/main', raw: 'package auth' } }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool<{ policy: { id: string } }>(server, 'opa_get_policy', {
      id: 'auth/main',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.policy.id).toBe('auth/main');

    const { url } = lastFetchCall();
    expect(url).toBe('http://localhost:8181/v1/policies/auth%2Fmain');
  });

  it('maps 404 to POLICY_NOT_FOUND', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ message: 'not found' }, { status: 404 }),
    );
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_get_policy', { id: 'missing' });
    expect(env.error?.code).toBe('POLICY_NOT_FOUND');
  });
});

describe('opa_put_policy', () => {
  it('PUTs raw Rego source as text/plain', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const source = 'package rbac\nimport rego.v1\nallow := true';
    await callTool(server, 'opa_put_policy', { id: 'rbac', source });

    const { url, init } = lastFetchCall();
    expect(url).toBe('http://localhost:8181/v1/policies/rbac');
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/plain');
    expect(init.body).toBe(source);
  });

  it('attaches the bearer token when OPA_TOKEN is set', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const server = makeServer();
    registerServerManagementTools(server, { ...baseConfig, opaToken: 'secret-token' });
    await callTool(server, 'opa_put_policy', { id: 'rbac', source: 'package rbac' });

    const { init } = lastFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
  });

  it('surfaces a connection failure as OPA_UNREACHABLE through the catch path', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_put_policy', {
      id: 'rbac',
      source: 'package rbac',
    });
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
  });

  it('surfaces a 5xx as UNKNOWN_ERROR with status in details', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ message: 'internal error' }, { status: 500 }),
    );
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_put_policy', {
      id: 'rbac',
      source: 'package rbac',
    });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    const details = env.error?.details as { status?: number };
    expect(details.status).toBe(500);
  });
});

describe('opa_delete_policy', () => {
  it('issues DELETE and reports deletion', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool<{ deleted: boolean }>(server, 'opa_delete_policy', {
      id: 'rbac',
    });
    expect(env.ok).toBe(true);
    expect(env.data?.deleted).toBe(true);
    expect(lastFetchCall().init.method).toBe('DELETE');
  });

  it('maps 404 to POLICY_NOT_FOUND', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ message: 'not found' }, { status: 404 }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_delete_policy', { id: 'missing' });
    expect(env.error?.code).toBe('POLICY_NOT_FOUND');
  });
});

// ─── Data ─────────────────────────────────────────────────────────────────

describe('opa_get_data', () => {
  it('translates dotted path to slash form', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ result: { id: 'alice' } }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_get_data', { path: 'users.alice' });
    expect(lastFetchCall().url).toBe('http://localhost:8181/v1/data/users/alice');
  });

  it('handles slash-form paths transparently', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ result: 'ok' }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_get_data', { path: '/users/alice' });
    expect(lastFetchCall().url).toBe('http://localhost:8181/v1/data/users/alice');
  });

  it('strips a leading data. prefix', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ result: 'ok' }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_get_data', { path: 'data.users.alice' });
    expect(lastFetchCall().url).toBe('http://localhost:8181/v1/data/users/alice');
  });
});

describe('opa_put_data', () => {
  it('PUTs JSON body at the data path', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_put_data', {
      path: 'users.alice',
      value: { roles: ['admin'] },
    });
    const { url, init } = lastFetchCall();
    expect(url).toBe('http://localhost:8181/v1/data/users/alice');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ roles: ['admin'] });
  });
});

describe('data tools — error paths', () => {
  it('opa_get_data surfaces OPA_UNREACHABLE on connection failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_get_data', { path: 'users.alice' });
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
  });

  it('opa_put_data surfaces a 5xx as UNKNOWN_ERROR with details', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ error: 'oops' }, { status: 500 }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_put_data', {
      path: 'users.alice',
      value: { roles: ['admin'] },
    });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect((env.error?.details as { status?: number }).status).toBe(500);
  });

  it('opa_patch_data surfaces a 4xx as UNKNOWN_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ error: 'bad patch' }, { status: 400 }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_patch_data', {
      path: 'users',
      operations: [{ op: 'add', path: '/x', value: 1 }],
    });
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
  });
});

describe('opa_query_decision and opa_compile_query — error paths', () => {
  it('opa_query_decision surfaces OPA_UNREACHABLE on connection failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_query_decision', {
      path: 'rbac.allow',
      input: { user: 'alice' },
    });
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
  });

  it('opa_query_decision sends an empty body when no input is provided', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ result: true }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_query_decision', { path: 'rbac.allow' });
    const body = JSON.parse(lastFetchCall().init.body as string) as Record<string, unknown>;
    expect(body).toEqual({});
  });

  it('opa_compile_query surfaces OPA_AUTH_FAILED on 401', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ error: 'no auth' }, { status: 401 }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_compile_query', {
      query: 'data.rbac.allow',
    });
    expect(env.error?.code).toBe('OPA_AUTH_FAILED');
  });
});

describe('opa_patch_data', () => {
  it('sends application/json-patch+json with the operations array', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_patch_data', {
      path: 'users',
      operations: [{ op: 'add', path: '/alice', value: { roles: ['admin'] } }],
    });
    const { init } = lastFetchCall();
    expect(init.method).toBe('PATCH');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json-patch+json');
    expect(JSON.parse(init.body as string)).toEqual([
      { op: 'add', path: '/alice', value: { roles: ['admin'] } },
    ]);
  });
});

// ─── Decisions ────────────────────────────────────────────────────────────

describe('opa_query_decision', () => {
  it('POSTs {input} to the data path and returns result + explanation + metrics', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ result: true, explanation: ['enter'], metrics: { eval_ns: 12345 } }),
    );
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool<{
      result: unknown;
      explanation?: unknown;
      metrics?: unknown;
    }>(server, 'opa_query_decision', {
      path: 'rbac.allow',
      input: { user: 'alice' },
      explain: 'full',
      metrics: true,
    });
    expect(env.ok).toBe(true);
    expect(env.data?.result).toBe(true);
    expect(env.data?.explanation).toEqual(['enter']);

    const { url, init } = lastFetchCall();
    expect(url).toContain('/v1/data/rbac/allow');
    expect(url).toContain('explain=full');
    expect(url).toContain('metrics=true');
    expect(JSON.parse(init.body as string)).toEqual({ input: { user: 'alice' } });
  });
});

describe('opa_compile_query (server-side partial eval)', () => {
  it('POSTs to /v1/compile with default unknowns ["input"]', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ result: { queries: [] } }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_compile_query', { query: 'data.rbac.allow == true' });
    const { url, init } = lastFetchCall();
    expect(url).toBe('http://localhost:8181/v1/compile');
    const body = JSON.parse(init.body as string) as { unknowns: string[] };
    expect(body.unknowns).toEqual(['input']);
  });

  it('honors caller-provided unknowns', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ result: {} }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_compile_query', {
      query: 'data.rbac.allow',
      unknowns: ['input.user', 'input.action'],
    });
    const body = JSON.parse(lastFetchCall().init.body as string) as { unknowns: string[] };
    expect(body.unknowns).toEqual(['input.user', 'input.action']);
  });
});

// ─── Status ───────────────────────────────────────────────────────────────

describe('opa_health', () => {
  it('hits /health on success and returns healthy: true', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool<{ healthy: boolean }>(server, 'opa_health', {});
    expect(env.ok).toBe(true);
    expect(env.data?.healthy).toBe(true);
    expect(lastFetchCall().url).toMatch(/\/health/);
  });

  it('appends bundles=true when set', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_health', { bundles: true });
    expect(lastFetchCall().url).toContain('bundles=true');
  });

  it('reports OPA_UNREACHABLE when the connection is refused', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_health', {});
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
  });

  it('reports unhealthy with a non-Unreachable error (e.g. /health 503)', async () => {
    // /health responses below 2xx are propagated as OpaHttpError, which
    // is NOT OpaUnreachableError — opa_health has a special branch that
    // maps these to OPA_UNREACHABLE with an "OPA reported unhealthy"
    // message rather than the generic mapping.
    fetchMock.mockResolvedValueOnce(
      okResponse({ status: 'unhealthy' }, { status: 503 }),
    );
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_health', {});
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
    expect(env.error?.message).toMatch(/unhealthy/i);
  });

  it('forwards both bundles and plugins when both are set', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    await callTool(server, 'opa_health', { bundles: true, plugins: true });
    const url = lastFetchCall().url;
    expect(url).toContain('bundles=true');
    expect(url).toContain('plugins=true');
  });
});

describe('opa_status and opa_config', () => {
  it('opa_status fetches /v1/config and wraps it', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ result: { plugins: {} } }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool<{ status: unknown }>(server, 'opa_status', {});
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBeDefined();
    expect(lastFetchCall().url).toBe('http://localhost:8181/v1/config');
  });

  it('opa_status surfaces OPA_UNREACHABLE through the catch path', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_status', {});
    expect(env.error?.code).toBe('OPA_UNREACHABLE');
  });

  it('opa_config returns the unwrapped result', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ result: { plugins: { bundle: {} } } }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool<{ config: { plugins?: unknown } }>(server, 'opa_config', {});
    expect(env.ok).toBe(true);
    expect(env.data?.config).toEqual({ plugins: { bundle: {} } });
  });

  it('opa_config falls back to the raw response when there is no result wrapper', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ default_decision: '/system/main' }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool<{ config: { default_decision?: string } }>(
      server,
      'opa_config',
      {},
    );
    expect(env.ok).toBe(true);
    expect(env.data?.config.default_decision).toBe('/system/main');
  });

  it('opa_config surfaces OPA_AUTH_FAILED on 401', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ error: 'no auth' }, { status: 401 }));
    const server = makeServer();
    registerServerManagementTools(server, baseConfig);
    const env = await callTool(server, 'opa_config', {});
    expect(env.error?.code).toBe('OPA_AUTH_FAILED');
  });
});
