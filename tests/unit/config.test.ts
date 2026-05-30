/**
 * Tests for the env-var loader.
 *
 * loadConfig() is the single entry point that turns operator-supplied
 * environment variables into a typed Config object. Bugs here are
 * silent — the server boots with subtly wrong settings — so this
 * surface deserves explicit coverage of every branch the parser walks.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';

const ENV_KEYS = [
  'OPA_URL',
  'OPA_TOKEN',
  'OPA_BINARY',
  'REGAL_BINARY',
  'OPA_MCP_TIMEOUT_MS',
  'OPA_MCP_HTTP_TIMEOUT_MS',
  'OPA_MCP_ALLOWED_PATHS',
  'OPA_MCP_LOG_FILE',
  'OPA_MCP_LOG_LEVEL',
  'OPA_MCP_MAX_RESPONSE_BYTES',
] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  vi.restoreAllMocks();
});

describe('loadConfig — defaults', () => {
  it('produces sensible defaults when no env vars are set', () => {
    const config = loadConfig();
    expect(config.opaUrl).toBe('http://localhost:8181');
    expect(config.opaBinary).toBe('opa');
    expect(config.regalBinary).toBe('regal');
    expect(config.subprocessTimeoutMs).toBe(30_000);
    expect(config.httpTimeoutMs).toBe(15_000);
    expect(config.maxResponseBytes).toBe(100_000);
    expect(config.logLevel).toBe('info');
    expect(config.logFile).toBe(join(tmpdir(), 'orygn-opa-mcp.log'));
  });

  it('defaults allowedPaths to an empty array (fail-secure)', () => {
    const config = loadConfig();
    expect(config.allowedPaths).toEqual([]);
  });

  it('defaults opaToken to undefined (no auth)', () => {
    const config = loadConfig();
    expect(config.opaToken).toBeUndefined();
  });
});

describe('loadConfig — env var overrides', () => {
  it('reads OPA_URL and validates it as a URL', () => {
    process.env['OPA_URL'] = 'https://opa.prod.example.com:443';
    expect(loadConfig().opaUrl).toBe('https://opa.prod.example.com:443');
  });

  it('reads OPA_BINARY and REGAL_BINARY paths verbatim', () => {
    process.env['OPA_BINARY'] = '/usr/local/bin/opa-custom';
    process.env['REGAL_BINARY'] = '/opt/regal';
    const config = loadConfig();
    expect(config.opaBinary).toBe('/usr/local/bin/opa-custom');
    expect(config.regalBinary).toBe('/opt/regal');
  });

  it('reads OPA_TOKEN and surfaces it on the config', () => {
    process.env['OPA_TOKEN'] = 'bearer-token-value';
    expect(loadConfig().opaToken).toBe('bearer-token-value');
  });

  it('coerces numeric env vars from strings', () => {
    process.env['OPA_MCP_TIMEOUT_MS'] = '5000';
    process.env['OPA_MCP_HTTP_TIMEOUT_MS'] = '2000';
    process.env['OPA_MCP_MAX_RESPONSE_BYTES'] = '256000';
    const config = loadConfig();
    expect(config.subprocessTimeoutMs).toBe(5000);
    expect(config.httpTimeoutMs).toBe(2000);
    expect(config.maxResponseBytes).toBe(256_000);
  });

  it('reads log level enum values', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      process.env['OPA_MCP_LOG_LEVEL'] = level;
      expect(loadConfig().logLevel).toBe(level);
    }
  });

  it('reads OPA_MCP_LOG_FILE path verbatim', () => {
    process.env['OPA_MCP_LOG_FILE'] = '/var/log/orygn-opa-mcp.log';
    expect(loadConfig().logFile).toBe('/var/log/orygn-opa-mcp.log');
  });
});

describe('loadConfig — OPA_MCP_ALLOWED_PATHS parsing', () => {
  it('parses comma-separated paths', () => {
    process.env['OPA_MCP_ALLOWED_PATHS'] = '/a,/b,/c';
    expect(loadConfig().allowedPaths).toEqual(['/a', '/b', '/c']);
  });

  it('parses semicolon-separated paths', () => {
    process.env['OPA_MCP_ALLOWED_PATHS'] = '/a;/b;/c';
    expect(loadConfig().allowedPaths).toEqual(['/a', '/b', '/c']);
  });

  it('handles a mix of commas and semicolons', () => {
    process.env['OPA_MCP_ALLOWED_PATHS'] = '/a,/b;/c,/d';
    expect(loadConfig().allowedPaths).toEqual(['/a', '/b', '/c', '/d']);
  });

  it('trims whitespace around each entry', () => {
    process.env['OPA_MCP_ALLOWED_PATHS'] = ' /a , /b , /c ';
    expect(loadConfig().allowedPaths).toEqual(['/a', '/b', '/c']);
  });

  it('drops empty entries from trailing or doubled separators', () => {
    process.env['OPA_MCP_ALLOWED_PATHS'] = '/a,,/b,';
    expect(loadConfig().allowedPaths).toEqual(['/a', '/b']);
  });

  it('falls back to the default empty array when the variable is whitespace-only', () => {
    process.env['OPA_MCP_ALLOWED_PATHS'] = '   ';
    expect(loadConfig().allowedPaths).toEqual([]);
  });

  it('falls back to the default when the variable is set to empty string', () => {
    process.env['OPA_MCP_ALLOWED_PATHS'] = '';
    expect(loadConfig().allowedPaths).toEqual([]);
  });
});

describe('loadConfig — validation failures', () => {
  it('exits with code 2 when OPA_URL is not a valid URL', () => {
    process.env['OPA_URL'] = 'not-a-url';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorSpy).toHaveBeenCalledWith('opa-mcp: invalid configuration');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('OPA_URL'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--help'));
  });

  it('exits with code 2 when OPA_URL uses a non-http scheme (file://)', () => {
    process.env['OPA_URL'] = 'file:///etc/passwd';
    vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadConfig()).toThrow('process.exit called');
  });

  it('exits with code 2 when OPA_URL uses a non-http scheme (javascript:)', () => {
    process.env['OPA_URL'] = 'javascript:alert(1)';
    vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadConfig()).toThrow('process.exit called');
  });

  it('exits with code 2 when OPA_MCP_TIMEOUT_MS is negative', () => {
    process.env['OPA_MCP_TIMEOUT_MS'] = '-100';
    vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => {
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadConfig()).toThrow('exit');
  });

  it('exits with code 2 when OPA_MCP_TIMEOUT_MS is non-numeric', () => {
    process.env['OPA_MCP_TIMEOUT_MS'] = 'forever';
    vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => {
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadConfig()).toThrow('exit');
  });

  it('exits with code 2 when OPA_MCP_LOG_LEVEL is unknown', () => {
    process.env['OPA_MCP_LOG_LEVEL'] = 'verbose';
    vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => {
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadConfig()).toThrow('exit');
  });

  it('exits with code 2 when OPA_MCP_MAX_RESPONSE_BYTES is zero', () => {
    process.env['OPA_MCP_MAX_RESPONSE_BYTES'] = '0';
    vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => {
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadConfig()).toThrow('exit');
  });
});

describe('loadConfig — combined real-world configurations', () => {
  it('handles a typical Claude Desktop config (URL + allowed paths)', () => {
    process.env['OPA_URL'] = 'http://127.0.0.1:8181';
    process.env['OPA_MCP_ALLOWED_PATHS'] = '/Users/alice/policies';
    const config = loadConfig();
    expect(config.opaUrl).toBe('http://127.0.0.1:8181');
    expect(config.allowedPaths).toEqual(['/Users/alice/policies']);
  });

  it('handles a fully-customized production config', () => {
    process.env['OPA_URL'] = 'https://opa.example.com';
    process.env['OPA_TOKEN'] = 'prod-token';
    process.env['OPA_BINARY'] = '/usr/local/bin/opa';
    process.env['REGAL_BINARY'] = '/usr/local/bin/regal';
    process.env['OPA_MCP_ALLOWED_PATHS'] = '/srv/policies;/srv/data';
    process.env['OPA_MCP_LOG_FILE'] = '/var/log/orygn-opa-mcp.log';
    process.env['OPA_MCP_LOG_LEVEL'] = 'warn';
    process.env['OPA_MCP_TIMEOUT_MS'] = '60000';
    process.env['OPA_MCP_HTTP_TIMEOUT_MS'] = '10000';
    process.env['OPA_MCP_MAX_RESPONSE_BYTES'] = '500000';

    const config = loadConfig();
    expect(config).toEqual({
      opaUrl: 'https://opa.example.com',
      opaToken: 'prod-token',
      opaBinary: '/usr/local/bin/opa',
      regalBinary: '/usr/local/bin/regal',
      conftestBinary: 'conftest',
      subprocessTimeoutMs: 60_000,
      httpTimeoutMs: 10_000,
      allowedPaths: ['/srv/policies', '/srv/data'],
      logFile: '/var/log/orygn-opa-mcp.log',
      logLevel: 'warn',
      maxResponseBytes: 500_000,
    });
  });
});
