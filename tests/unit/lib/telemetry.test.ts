import { afterEach, describe, expect, it, vi } from 'vitest';

import { SERVER_VERSION } from '../../../src/constants.js';
import { detectRunContext, pingUrl, sendTelemetryPing } from '../../../src/lib/telemetry.js';

const none = () => Promise.resolve(false);
const only = (path: string) => (p: string) => Promise.resolve(p === path);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('detectRunContext()', () => {
  it.each(['true', '1', 'True', 'yes'])('treats CI=%s as a CI job', async (value) => {
    expect(await detectRunContext({ CI: value }, 'linux', none)).toBe('ci');
  });

  it.each(['', 'false', 'FALSE', '0', ' '])('ignores CI=%j', async (value) => {
    expect(await detectRunContext({ CI: value }, 'linux', none)).toBeNull();
  });

  it('treats a Kubernetes pod as a container', async () => {
    expect(await detectRunContext({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, 'linux', none)).toBe(
      'container',
    );
  });

  it.each(['/.dockerenv', '/run/.containerenv'])('detects %s on Linux', async (marker) => {
    expect(await detectRunContext({}, 'linux', only(marker))).toBe('container');
  });

  it('checks for marker files only on Linux', async () => {
    const exists = vi.fn(() => Promise.resolve(true));
    expect(await detectRunContext({}, 'darwin', exists)).toBeNull();
    expect(await detectRunContext({}, 'win32', exists)).toBeNull();
    expect(exists).not.toHaveBeenCalled();
  });

  it('prefers CI over container when both apply', async () => {
    expect(await detectRunContext({ CI: 'true' }, 'linux', only('/.dockerenv'))).toBe('ci');
  });

  it('returns null on an ordinary machine', async () => {
    expect(await detectRunContext({}, 'linux', none)).toBeNull();
  });
});

describe('pingUrl()', () => {
  const ID = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';

  it('sends the install ID outside a container or CI job', async () => {
    const url = new URL(await pingUrl(null, () => Promise.resolve(ID)));
    expect(url.origin + url.pathname).toBe(
      'https://opa-mcp-telemetry.gibbidaniel.workers.dev/ping',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      v: SERVER_VERSION,
      p: process.platform,
      u: ID,
    });
  });

  it.each(['container', 'ci'] as const)(
    'sends the %s label and never reads or creates an install ID',
    async (context) => {
      const installId = vi.fn(() => Promise.resolve(ID));
      const url = new URL(await pingUrl(context, installId));
      expect(Object.fromEntries(url.searchParams)).toEqual({
        v: SERVER_VERSION,
        p: process.platform,
        c: context,
      });
      expect(installId).not.toHaveBeenCalled();
    },
  );

  it('omits the ID when none is available', async () => {
    const url = new URL(await pingUrl(null, () => Promise.resolve(null)));
    expect(url.searchParams.has('u')).toBe(false);
  });

  it('omits the ID when reading it fails', async () => {
    const url = new URL(await pingUrl(null, () => Promise.reject(new Error('EACCES'))));
    expect(url.searchParams.has('u')).toBe(false);
  });
});

describe('sendTelemetryPing()', () => {
  it('does nothing when OPA_MCP_NO_TELEMETRY=1', async () => {
    vi.stubEnv('OPA_MCP_NO_TELEMETRY', '1');
    const fetchMock = vi.fn(() => Promise.resolve(new Response('ok')));
    vi.stubGlobal('fetch', fetchMock);
    sendTelemetryPing();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one ping, labelled, without touching the install ID file in CI', async () => {
    vi.stubEnv('OPA_MCP_NO_TELEMETRY', '');
    vi.stubEnv('CI', 'true');
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response('ok')),
    );
    vi.stubGlobal('fetch', fetchMock);
    sendTelemetryPing();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.searchParams.get('c')).toBe('ci');
    expect(url.searchParams.has('u')).toBe(false);
  });

  it('swallows a failed request', async () => {
    vi.stubEnv('OPA_MCP_NO_TELEMETRY', '');
    vi.stubEnv('CI', 'true');
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    vi.stubGlobal('fetch', fetchMock);
    expect(() => sendTelemetryPing()).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
