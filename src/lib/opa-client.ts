/**
 * HTTP client for a running OPA server (the `opa run --server` REST API).
 *
 * Used by tools in the `opa_*` server-management category. CLI-only
 * tools (`rego_*`) do not touch this module.
 *
 * Connection failures map to `OPA_UNREACHABLE`; 401s map to `OPA_AUTH_FAILED`.
 * Per-tool error mapping happens at the call site.
 */
import type { Config } from '../config.js';

export class OpaUnreachableError extends Error {
  constructor(
    public readonly url: string,
    cause?: unknown,
  ) {
    super(`OPA server unreachable at ${url}`);
    this.name = 'OpaUnreachableError';
    if (cause !== undefined) this.cause = cause;
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

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /**
   * JSON body to serialize. Mutually exclusive with `rawBody`.
   */
  body?: unknown;
  /**
   * Raw string body sent verbatim. Used for endpoints that accept
   * non-JSON content — notably `PUT /v1/policies/{id}` which expects
   * Rego source as `text/plain`.
   */
  rawBody?: string;
  /** Content-Type for `rawBody`. Defaults to `text/plain`. */
  rawContentType?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}

export class OpaClient {
  constructor(private readonly config: Config) {}

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
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

    const init: RequestInit = {
      method: opts.method,
      headers,
      signal: controller.signal,
    };
    if (bodyToSend !== undefined) {
      init.body = bodyToSend;
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (e) {
      throw new OpaUnreachableError(this.config.opaUrl, e);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      throw new OpaAuthError();
    }

    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const payload: unknown = isJson ? await response.json() : await response.text();

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
