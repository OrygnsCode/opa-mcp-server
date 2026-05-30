import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseConfig, callTool, makeServer } from './_helpers.js';
import { registerRegoPlaygroundShare } from '../../../src/tools/helpers/playground-share.js';
import type { RegoPlaygroundShareOutput } from '../../../src/tools/helpers/playground-share.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal but structurally correct GitHub Gist API response. */
function mockGistResponse(
  overrides: Partial<{
    id: string;
    html_url: string;
    rawPolicyUrl: string;
  }> = {},
): object {
  const id = overrides.id ?? 'abc123def456';
  const html_url = overrides.html_url ?? `https://gist.github.com/user/${id}`;
  const raw_url =
    overrides.rawPolicyUrl ?? `https://gist.githubusercontent.com/user/${id}/raw/policy.rego`;
  return {
    id,
    html_url,
    files: {
      'policy.rego': { raw_url },
    },
  };
}

/** Build a mock Response object with the given status and JSON body. */
function okFetchResponse(body: object): Response {
  return {
    ok: true,
    status: 201,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function failFetchResponse(status: number, body = ''): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

const POLICY = 'package authz\n\ndefault allow := false\n';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Ensure GITHUB_TOKEN is unset between tests; individual tests set it.
  delete process.env['GITHUB_TOKEN'];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['GITHUB_TOKEN'];
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('rego_playground_share', () => {
  it('returns GITHUB_TOKEN_MISSING when env var is not set', async () => {
    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    const env = await callTool(server, 'rego_playground_share', { policy: POLICY });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('GITHUB_TOKEN_MISSING');
    expect(env.error?.hint).toMatch(/github\.com\/settings\/tokens/);
  });

  it('creates a Gist and returns gistUrl, rawPolicyUrl, id on success', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    const gistBody = mockGistResponse();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(okFetchResponse(gistBody)));

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    const env = await callTool<RegoPlaygroundShareOutput>(server, 'rego_playground_share', {
      policy: POLICY,
    });

    expect(env.ok).toBe(true);
    expect(env.data?.gistUrl).toBe('https://gist.github.com/user/abc123def456');
    expect(env.data?.rawPolicyUrl).toBe(
      'https://gist.githubusercontent.com/user/abc123def456/raw/policy.rego',
    );
    expect(env.data?.id).toBe('abc123def456');
  });

  it('sends correct Authorization header and Content-Type to GitHub API', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_secret_token';
    const fetchMock = vi.fn().mockResolvedValueOnce(okFetchResponse(mockGistResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    await callTool(server, 'rego_playground_share', { policy: POLICY });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/gists');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer ghp_secret_token',
    );
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('sends only policy.rego file when no optional fields are provided', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    const fetchMock = vi.fn().mockResolvedValueOnce(okFetchResponse(mockGistResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    await callTool(server, 'rego_playground_share', { policy: POLICY });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(body.files)).toEqual(['policy.rego']);
  });

  it('includes metadata.json when query, input, and data are provided', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    const fetchMock = vi.fn().mockResolvedValueOnce(okFetchResponse(mockGistResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    await callTool(server, 'rego_playground_share', {
      policy: POLICY,
      query: 'data.authz.allow',
      input: '{"user":"alice"}',
      data: '{"roles":["admin"]}',
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      files: Record<string, { content: string }>;
    };
    expect(Object.keys(body.files)).toContain('policy.rego');
    expect(Object.keys(body.files)).toContain('metadata.json');

    const metadata = JSON.parse(body.files['metadata.json']!.content) as Record<string, unknown>;
    expect(metadata['query']).toBe('data.authz.allow');
    expect(metadata['input']).toBe('{"user":"alice"}');
    expect(metadata['data']).toBe('{"roles":["admin"]}');
  });

  it('includes metadata.json when only query is provided', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    const fetchMock = vi.fn().mockResolvedValueOnce(okFetchResponse(mockGistResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    await callTool(server, 'rego_playground_share', {
      policy: POLICY,
      query: 'data.authz.allow',
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      files: Record<string, { content: string }>;
    };
    expect(Object.keys(body.files)).toContain('metadata.json');
    const metadata = JSON.parse(body.files['metadata.json']!.content) as Record<string, unknown>;
    expect(metadata['query']).toBe('data.authz.allow');
    expect(metadata['input']).toBeUndefined();
  });

  it('uses provided description in the Gist body', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    const fetchMock = vi.fn().mockResolvedValueOnce(okFetchResponse(mockGistResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    await callTool(server, 'rego_playground_share', {
      policy: POLICY,
      description: 'My RBAC policy demo',
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      description: string;
    };
    expect(body.description).toBe('My RBAC policy demo');
  });

  it('uses default description when none is provided', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    const fetchMock = vi.fn().mockResolvedValueOnce(okFetchResponse(mockGistResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    await callTool(server, 'rego_playground_share', { policy: POLICY });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      description: string;
    };
    expect(body.description).toBe('OPA Rego policy');
  });

  it('returns GIST_CREATE_FAILED on HTTP 401 from GitHub', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_bad_token';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(failFetchResponse(401, '{"message":"Bad credentials"}')),
    );

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    const env = await callTool(server, 'rego_playground_share', { policy: POLICY });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('GIST_CREATE_FAILED');
    expect(env.error?.message).toMatch(/401/);
    expect((env.error?.details as { status?: number })?.status).toBe(401);
  });

  it('returns GIST_CREATE_FAILED on HTTP 422 from GitHub', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(failFetchResponse(422, '{"message":"Validation Failed"}')),
    );

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    const env = await callTool(server, 'rego_playground_share', { policy: POLICY });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('GIST_CREATE_FAILED');
    expect(env.error?.message).toMatch(/422/);
  });

  it('returns UNKNOWN_ERROR when fetch throws a network error', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('connect ETIMEDOUT')));

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    const env = await callTool(server, 'rego_playground_share', { policy: POLICY });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_ERROR');
    expect(env.error?.message).toMatch(/ETIMEDOUT/);
  });

  it('returns GIST_CREATE_FAILED when GitHub returns non-JSON success body', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    const malformedResponse = {
      ok: true,
      status: 201,
      json: () => Promise.reject(new Error('Unexpected token')),
      text: () => Promise.resolve('not json at all'),
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(malformedResponse));

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    const env = await callTool(server, 'rego_playground_share', { policy: POLICY });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('GIST_CREATE_FAILED');
    expect(env.error?.message).toMatch(/unparseable/);
  });

  it('creates a public Gist (public: true)', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token';
    const fetchMock = vi.fn().mockResolvedValueOnce(okFetchResponse(mockGistResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const server = makeServer();
    registerRegoPlaygroundShare(server, baseConfig);
    await callTool(server, 'rego_playground_share', { policy: POLICY });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      public: boolean;
    };
    expect(body.public).toBe(true);
  });
});
