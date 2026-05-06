/**
 * Direct unit tests for OpaClient.
 *
 * The tool-layer tests already exercise OpaClient through fetch
 * mocks. These tests pin the wire-level details — URL construction,
 * header propagation, body serialization, error mapping — so a future
 * refactor of OpaClient can't silently change them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../../src/config.js';
import {
  OpaAuthError,
  OpaClient,
  OpaHttpError,
  OpaUnreachableError,
} from '../../../src/lib/opa-client.js';

const baseConfig: Config = {
  opaUrl: 'http://opa.example.com:8181',
  opaBinary: 'opa',
  regalBinary: 'regal',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 5_000,
  allowedPaths: [],
  logFile: '/tmp/test.log',
  logLevel: 'error',
  maxResponseBytes: 100_000,
};

let fetchMock: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Response>>>;
const realFetch = globalThis.fetch;

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const lastCall = (): { url: string; init: RequestInit } => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return {
    url: typeof url === 'string' ? url : (url as URL).toString(),
    init: init as RequestInit,
  };
};

describe('URL construction', () => {
  it('joins base URL and path correctly with leading slash', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ result: [] }));
    const client = new OpaClient(baseConfig);
    await client.request({ method: 'GET', path: '/v1/policies' });
    expect(lastCall().url).toBe('http://opa.example.com:8181/v1/policies');
  });

  it('prepends a slash when path is missing one', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    await client.request({ method: 'GET', path: 'health' });
    expect(lastCall().url).toBe('http://opa.example.com:8181/health');
  });

  it('strips a trailing slash from the configured base URL', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient({ ...baseConfig, opaUrl: 'http://opa.example.com:8181/' });
    await client.request({ method: 'GET', path: '/v1/policies' });
    expect(lastCall().url).toBe('http://opa.example.com:8181/v1/policies');
  });

  it('strips multiple trailing slashes from the configured base URL', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient({ ...baseConfig, opaUrl: 'http://opa.example.com:8181///' });
    await client.request({ method: 'GET', path: '/v1/policies' });
    expect(lastCall().url).toBe('http://opa.example.com:8181/v1/policies');
  });

  it('appends query string parameters from the query option', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    await client.request({
      method: 'GET',
      path: '/v1/data/x',
      query: { explain: 'full', metrics: true, count: 10 },
    });
    const url = new URL(lastCall().url);
    expect(url.searchParams.get('explain')).toBe('full');
    expect(url.searchParams.get('metrics')).toBe('true');
    expect(url.searchParams.get('count')).toBe('10');
  });

  it('drops query params with undefined values', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    await client.request({
      method: 'GET',
      path: '/v1/data/x',
      query: { explain: undefined, metrics: true },
    });
    const url = new URL(lastCall().url);
    expect(url.searchParams.has('explain')).toBe(false);
    expect(url.searchParams.has('metrics')).toBe(true);
  });
});

describe('Headers', () => {
  it('always sends Accept: application/json', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    await client.request({ method: 'GET', path: '/v1/policies' });
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/json');
  });

  it('attaches a bearer token when opaToken is set', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient({ ...baseConfig, opaToken: 'secret' });
    await client.request({ method: 'GET', path: '/v1/policies' });
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret');
  });

  it('does not attach Authorization when opaToken is unset', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    await client.request({ method: 'GET', path: '/v1/policies' });
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('caller-supplied headers override the defaults', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    await client.request({
      method: 'POST',
      path: '/v1/data',
      body: { x: 1 },
      headers: { 'Content-Type': 'application/json-patch+json' },
    });
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json-patch+json');
  });
});

describe('Body serialization', () => {
  it('JSON-stringifies the body and sets application/json by default', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    await client.request({
      method: 'POST',
      path: '/v1/data/x',
      body: { input: { user: 'alice' } },
    });
    const init = lastCall().init;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ input: { user: 'alice' } });
  });

  it('sends rawBody verbatim with text/plain when configured', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    const rego = 'package x\nimport rego.v1\nallow := true';
    await client.request({
      method: 'PUT',
      path: '/v1/policies/x',
      rawBody: rego,
    });
    const init = lastCall().init;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
    expect(init.body).toBe(rego);
  });

  it('honors a custom rawContentType', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    await client.request({
      method: 'POST',
      path: '/v1/things',
      rawBody: '<xml>',
      rawContentType: 'application/xml',
    });
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/xml');
  });

  it('throws if both body and rawBody are provided', async () => {
    const client = new OpaClient(baseConfig);
    await expect(
      client.request({
        method: 'POST',
        path: '/v1/x',
        body: { a: 1 },
        rawBody: 'raw',
      }),
    ).rejects.toThrow(/either `body` or `rawBody`/);
  });

  it('omits the body entirely on GET when neither is set', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    const client = new OpaClient(baseConfig);
    await client.request({ method: 'GET', path: '/v1/policies' });
    expect(lastCall().init.body).toBeUndefined();
  });
});

describe('Response handling', () => {
  it('parses JSON responses', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ result: [{ id: 'x' }] }));
    const client = new OpaClient(baseConfig);
    const data = await client.request<{ result: Array<{ id: string }> }>({
      method: 'GET',
      path: '/v1/policies',
    });
    expect(data.result[0]?.id).toBe('x');
  });

  it('returns text payload when Content-Type is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('plain text body', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    const client = new OpaClient(baseConfig);
    const data = await client.request<string>({ method: 'GET', path: '/x' });
    expect(data).toBe('plain text body');
  });
});

describe('Error mapping', () => {
  it('throws OpaUnreachableError on fetch network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new OpaClient(baseConfig);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
      OpaUnreachableError,
    );
  });

  it('OpaUnreachableError carries the configured opaUrl and the underlying cause', async () => {
    const cause = new Error('ETIMEDOUT');
    fetchMock.mockRejectedValueOnce(cause);
    const client = new OpaClient(baseConfig);
    try {
      await client.request({ method: 'GET', path: '/x' });
      expect.fail('expected throw');
    } catch (e) {
      const err = e as OpaUnreachableError;
      expect(err).toBeInstanceOf(OpaUnreachableError);
      expect(err.url).toBe(baseConfig.opaUrl);
      expect((err as { cause?: unknown }).cause).toBe(cause);
    }
  });

  it('throws OpaAuthError on 401 response', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ message: 'no auth' }, 401));
    const client = new OpaClient(baseConfig);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
      OpaAuthError,
    );
  });

  it('throws OpaHttpError with status and body for non-2xx non-401 responses', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ message: 'bad request' }, 400));
    const client = new OpaClient(baseConfig);
    try {
      await client.request({ method: 'POST', path: '/x', body: {} });
      expect.fail('expected throw');
    } catch (e) {
      const err = e as OpaHttpError;
      expect(err).toBeInstanceOf(OpaHttpError);
      expect(err.status).toBe(400);
      expect(err.body).toEqual({ message: 'bad request' });
    }
  });

  it('throws OpaHttpError on 5xx', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ message: 'oops' }, 500));
    const client = new OpaClient(baseConfig);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
      OpaHttpError,
    );
  });
});

describe('Timeouts', () => {
  it('aborts the request when httpTimeoutMs elapses', async () => {
    // Build a fetch mock that ignores the abort signal and never
    // resolves on its own — but fetch in real Node does respect the
    // AbortSignal, so we simulate it by rejecting when aborted.
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const client = new OpaClient({ ...baseConfig, httpTimeoutMs: 50 });
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
      OpaUnreachableError,
    );
  });
});
