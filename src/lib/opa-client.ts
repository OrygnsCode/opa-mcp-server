/**
 * HTTP client for a running OPA server (the `opa run --server` REST API).
 *
 * Used by tools in the `opa_*` server-management category. CLI-only
 * tools (`rego_*`) do not touch this module.
 *
 * Connection failures map to `OPA_UNREACHABLE`, the client's own timeout to
 * `TIMEOUT`, and 401s to `OPA_AUTH_FAILED`.
 * Per-tool error mapping happens at the call site.
 */
import type { Config } from '../config.js';

/**
 * The URL with any username and password removed. OPA_URL is shown in error
 * envelopes and in the startup log; a credential embedded in it must not
 * travel with it. Returns the input unchanged when it holds none, or does
 * not parse.
 */
export function redactUrlCredentials(url: string): string {
  if (!urlHasCredentials(url)) return url;
  // Drop the userinfo textually rather than re-serialising through the
  // parser, which would lowercase the scheme and host and drop a default
  // port; the operator should recognise the URL they set. The authority
  // ends at the first `/`, `?` or `#`, and its last `@` closes the userinfo,
  // so a password holding `@` is removed whole.
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/, '$1');
}

/** Whether the URL carries a username or password. */
export function urlHasCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

export class OpaUnreachableError extends Error {
  public readonly url: string;
  constructor(url: string, cause?: unknown) {
    const shown = redactUrlCredentials(url);
    super(`OPA server unreachable at ${shown}`);
    this.name = 'OpaUnreachableError';
    this.url = shown;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * OPA_URL holds a username and password. The HTTP client refuses such a
 * URL outright, so every call failed as "unreachable" with a hint to start a
 * server; the real fix is to move the secret to OPA_TOKEN.
 */
export class OpaUrlCredentialsError extends Error {
  public readonly url: string;
  constructor(url: string) {
    const shown = redactUrlCredentials(url);
    super(`OPA_URL holds a username and password, which the HTTP client refuses (${shown})`);
    this.name = 'OpaUrlCredentialsError';
    this.url = shown;
  }
}

export class OpaAuthError extends Error {
  constructor() {
    super('OPA rejected the request with 401 Unauthorized');
    this.name = 'OpaAuthError';
  }
}

export class OpaHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`OPA returned HTTP ${status}`);
    this.name = 'OpaHttpError';
  }
}

/** The server did not answer within `httpTimeoutMs`. It may well be up. */
export class OpaTimeoutError extends Error {
  /** The URL with any credentials removed, like every error here. */
  readonly url: string;
  constructor(
    url: string,
    public readonly timeoutMs: number,
  ) {
    const shown = redactUrlCredentials(url);
    super(`OPA at ${shown} did not answer within ${timeoutMs} ms`);
    this.name = 'OpaTimeoutError';
    this.url = shown;
  }
}

export class OpaCancelledError extends Error {
  constructor() {
    super('OPA request was cancelled by the client');
    this.name = 'OpaCancelledError';
  }
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /**
   * JSON body to serialize. Mutually exclusive with `rawBody`.
   */
  body?: unknown;
  /**
   * Raw string body sent verbatim. Used for endpoints that accept
   * non-JSON content -- notably `PUT /v1/policies/{id}` which expects
   * Rego source as `text/plain`.
   */
  rawBody?: string;
  /** Content-Type for `rawBody`. Defaults to `text/plain`. */
  rawContentType?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** External cancellation signal from the MCP client. */
  signal?: AbortSignal;
}

export class OpaClient {
  constructor(private readonly config: Config) {}

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    // Refuse before anything is built from the URL: fetch would throw with the
    // credentials in its message.
    if (urlHasCredentials(this.config.opaUrl)) {
      throw new OpaUrlCredentialsError(this.config.opaUrl);
    }
    const url = this.buildUrl(opts.path, opts.query);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(opts.headers ?? {}),
    };
    if (this.config.opaToken) {
      headers['Authorization'] = `Bearer ${this.config.opaToken}`;
    }

    let bodyToSend: string | undefined;
    if (opts.rawBody !== undefined) {
      if (opts.body !== undefined) {
        throw new Error('OpaClient.request: pass either `body` or `rawBody`, not both.');
      }
      bodyToSend = opts.rawBody;
      if (!headers['Content-Type']) {
        headers['Content-Type'] = opts.rawContentType ?? 'text/plain';
      }
    } else if (opts.body !== undefined) {
      bodyToSend = JSON.stringify(opts.body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);

    const combinedSignal = opts.signal
      ? AbortSignal.any([controller.signal, opts.signal])
      : controller.signal;

    const init: RequestInit = {
      method: opts.method,
      headers,
      signal: combinedSignal,
    };
    if (bodyToSend !== undefined) {
      init.body = bodyToSend;
    }

    // The client's own timer and the caller's signal both surface as an
    // abort. Which one fired decides the answer: a cancellation, a server
    // that is up but slow, or no server at all. Reporting the slow case as
    // unreachable sent people to start a server that was already running.
    // The caller's signal is trusted as is (a caller may abort with a reason
    // of its own); the timer is blamed only for a rejection that is an abort,
    // so a refusal or a parse error that lands just after it fired keeps its
    // own name.
    const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';
    const classifyAbort = (e: unknown): Error | undefined => {
      if (opts.signal?.aborted) return new OpaCancelledError();
      if (controller.signal.aborted && isAbort(e)) {
        return new OpaTimeoutError(this.config.opaUrl, this.config.httpTimeoutMs);
      }
      return undefined;
    };

    let response: Response;
    let payload: unknown;
    try {
      try {
        response = await fetch(url, init);
      } catch (e) {
        throw classifyAbort(e) ?? new OpaUnreachableError(this.config.opaUrl, e);
      }

      if (response.status === 401) {
        throw new OpaAuthError();
      }

      // The body is read under the same timer: a server that sends headers
      // and then stalls is as slow as one that never answers.
      const contentType = response.headers.get('content-type') ?? '';
      const isJson = contentType.includes('application/json');
      try {
        payload = isJson ? await response.json() : await response.text();
      } catch (e) {
        throw classifyAbort(e) ?? e;
      }
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new OpaHttpError(response.status, payload);
    }

    return payload as T;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = this.config.opaUrl.replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${base}${normalizedPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}
