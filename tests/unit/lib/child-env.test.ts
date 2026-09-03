/**
 * Unit tests for buildChildEnv.
 *
 * The property under test is the one that matters: a secret in the server's own
 * environment must not reach a child process, because Rego can read that
 * environment back through `opa.runtime().env`.
 *
 * tests/integration/env-isolation.test.ts proves the same thing end to end
 * against a real `opa`. These cover the branches that are awkward to reach that
 * way -- Windows casing, the opt-in passthrough, absent variables.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALLOWED_CHILD_ENV_VARS, buildChildEnv } from '../../../src/lib/child-env.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A source environment shaped like a real MCP client's `env` block. */
const source: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/dev',
  LANG: 'en_US.UTF-8',
  HTTPS_PROXY: 'http://proxy.corp:3128',
  // Secrets an operator plausibly has set. None may reach the child.
  OPA_TOKEN: 'bearer-secret',
  GITHUB_TOKEN: 'ghp_secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  AWS_SESSION_TOKEN: 'aws-session',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  NPM_TOKEN: 'npm-secret',
  // Server configuration. The child has no use for any of it.
  OPA_URL: 'http://localhost:8181',
  OPA_MCP_ALLOWED_PATHS: '/policies',
  OPA_MCP_LOG_FILE: '/tmp/x.log',
};

describe('buildChildEnv — secrets', () => {
  it('passes no secret from the server environment to the child', () => {
    const env = buildChildEnv(undefined, source);

    for (const name of [
      'OPA_TOKEN',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'ANTHROPIC_API_KEY',
      'NPM_TOKEN',
    ]) {
      expect(env[name], `${name} must not reach the child`).toBeUndefined();
    }
  });

  it('does not leak a secret value under any key', () => {
    // Guards against a future refactor that renames rather than removes.
    const env = buildChildEnv(undefined, source);
    const values = Object.values(env).join('\u0000');

    for (const secret of ['bearer-secret', 'ghp_secret', 'aws-secret', 'sk-ant-secret']) {
      expect(values).not.toContain(secret);
    }
  });

  it('is an allow-list, so an unknown variable is dropped by default', () => {
    // A blocklist would have to predict every secret-shaped name in advance.
    const env = buildChildEnv(undefined, { ...source, SOME_FUTURE_CREDENTIAL: 'nope' });
    expect(env['SOME_FUTURE_CREDENTIAL']).toBeUndefined();
  });

  it("does not forward the server's own configuration", () => {
    const env = buildChildEnv(undefined, source);
    expect(env['OPA_URL']).toBeUndefined();
    expect(env['OPA_MCP_ALLOWED_PATHS']).toBeUndefined();
    expect(env['OPA_MCP_LOG_FILE']).toBeUndefined();
  });
});

describe('buildChildEnv — what the child still needs', () => {
  it('keeps PATH, HOME and locale', () => {
    const env = buildChildEnv(undefined, source);
    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/home/dev');
    expect(env['LANG']).toBe('en_US.UTF-8');
  });

  it('keeps proxy settings, so http.send and bundle fetches still work', () => {
    const env = buildChildEnv(undefined, source);
    expect(env['HTTPS_PROXY']).toBe('http://proxy.corp:3128');
  });

  it('omits allow-listed names that are absent rather than defining them empty', () => {
    // An empty-string TMPDIR is not the same as an unset one, and some tools
    // treat it as a real path.
    const env = buildChildEnv(undefined, { PATH: '/bin' });
    expect('TMPDIR' in env).toBe(false);
    expect('HTTPS_PROXY' in env).toBe(false);
  });

  it('exposes the allow-list, and it contains no obviously secret name', () => {
    expect(ALLOWED_CHILD_ENV_VARS.length).toBeGreaterThan(0);
    for (const name of ALLOWED_CHILD_ENV_VARS) {
      expect(name).not.toMatch(/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i);
    }
  });
});

describe('buildChildEnv — explicit caller values', () => {
  it('includes variables the caller passes', () => {
    const env = buildChildEnv({ CUSTOM: 'value' }, source);
    expect(env['CUSTOM']).toBe('value');
  });

  it('lets the caller override an allow-listed value', () => {
    const env = buildChildEnv({ PATH: '/override' }, source);
    expect(env['PATH']).toBe('/override');
  });
});

describe('buildChildEnv — OPA_MCP_PASSTHROUGH_ENV opt-in', () => {
  it('forwards a named variable', () => {
    const env = buildChildEnv(undefined, {
      ...source,
      OPA_MCP_PASSTHROUGH_ENV: 'MY_FEATURE_FLAG',
      MY_FEATURE_FLAG: 'on',
    });
    expect(env['MY_FEATURE_FLAG']).toBe('on');
  });

  it('accepts a comma or semicolon separated list and trims whitespace', () => {
    const env = buildChildEnv(undefined, {
      ...source,
      OPA_MCP_PASSTHROUGH_ENV: ' A , B ; C ',
      A: '1',
      B: '2',
      C: '3',
    });
    expect(env['A']).toBe('1');
    expect(env['B']).toBe('2');
    expect(env['C']).toBe('3');
  });

  it('forwards only what was named, not everything', () => {
    const env = buildChildEnv(undefined, { ...source, OPA_MCP_PASSTHROUGH_ENV: 'GITHUB_TOKEN' });
    // The operator asked for this one explicitly, so it goes through...
    expect(env['GITHUB_TOKEN']).toBe('ghp_secret');
    // ...and nothing rides along with it.
    expect(env['OPA_TOKEN']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  it('ignores an empty setting', () => {
    const env = buildChildEnv(undefined, { ...source, OPA_MCP_PASSTHROUGH_ENV: '  ' });
    expect(env['OPA_TOKEN']).toBeUndefined();
  });
});

describe('buildChildEnv — Windows casing', () => {
  it('matches an allow-listed name case-insensitively on win32', () => {
    // Windows environment names are case-insensitive, and the casing in
    // process.env follows whatever the parent process used, so `Path` is as
    // likely as `PATH`.
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const env = buildChildEnv(undefined, {
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      OPA_TOKEN: 'bearer-secret',
    });

    expect(env['PATH']).toBe('C:\\Windows\\System32');
    expect(env['SystemRoot']).toBe('C:\\Windows');
    expect(env['OPA_TOKEN']).toBeUndefined();
  });

  it('blanks the identity variables libuv injects regardless of what we pass', () => {
    // On Windows libuv copies USERNAME, USERDOMAIN, LOGONSERVER and friends from
    // the parent even when spawning with `{}`. They cannot be removed, only
    // overwritten, and an untrusted policy has no business reading the operating
    // system user or the Windows domain.
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const env = buildChildEnv(undefined, { USERNAME: 'daniel', USERDOMAIN: 'CORP' });
    expect(env['USERNAME']).toBe('');
    expect(env['USERDOMAIN']).toBe('');
    expect(env['LOGONSERVER']).toBe('');
  });

  it('lets an explicit passthrough opt back into an identity variable', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const env = buildChildEnv(undefined, {
      OPA_MCP_PASSTHROUGH_ENV: 'USERNAME',
      USERNAME: 'daniel',
    });
    expect(env['USERNAME']).toBe('daniel');
    // The ones not named stay blanked.
    expect(env['USERDOMAIN']).toBe('');
  });

  it('does not blank identity variables off win32', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    // POSIX spawn injects nothing, so an unlisted name is simply absent rather
    // than present-and-empty.
    const env = buildChildEnv(undefined, { USERNAME: 'daniel' });
    expect('USERNAME' in env).toBe(false);
  });

  it('does not fall back to case-insensitive matching off win32', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    // On POSIX, `Path` and `PATH` are genuinely different variables.
    const env = buildChildEnv(undefined, { Path: '/wrong' });
    expect(env['PATH']).toBeUndefined();
  });
});
