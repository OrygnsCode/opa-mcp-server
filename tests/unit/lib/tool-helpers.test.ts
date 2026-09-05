import { describe, expect, it } from 'vitest';

import {
  mapSubprocessFailure,
  sanitizeInlinePath,
  sanitizeInlinePathsDeep,
} from '../../../src/lib/tool-helpers.js';

describe('mapSubprocessFailure', () => {
  const base = { stdout: '', stderr: '', aborted: false, durationMs: 12 };

  it('reports a timed-out process as TIMEOUT, not a missing binary', () => {
    // A killed process reports a null exit code, so checking exitCode first
    // would misreport a slow command (e.g. `opa bench`) as OPA_BINARY_NOT_FOUND
    // and send the user chasing an install problem that does not exist.
    const env = mapSubprocessFailure({ ...base, exitCode: null, timedOut: true }, 'opa');
    expect(env?.error?.code).toBe('TIMEOUT');
  });

  it('still reports a genuine spawn failure as the binary-not-found code', () => {
    const env = mapSubprocessFailure(
      { ...base, exitCode: null, timedOut: false, stderr: 'spawn ENOENT' },
      'opa',
    );
    expect(env?.error?.code).toBe('OPA_BINARY_NOT_FOUND');
  });

  it('maps regal and conftest spawn failures to their own codes', () => {
    expect(
      mapSubprocessFailure({ ...base, exitCode: null, timedOut: false }, 'regal')?.error?.code,
    ).toBe('REGAL_NOT_FOUND');
    expect(
      mapSubprocessFailure({ ...base, exitCode: null, timedOut: false }, 'conftest')?.error?.code,
    ).toBe('CONFTEST_NOT_FOUND');
  });

  it('reports a child killed from outside as SUBPROCESS_KILLED, not a missing binary', () => {
    const env = mapSubprocessFailure(
      { ...base, exitCode: null, timedOut: false, signal: 'SIGKILL' },
      'opa',
    );
    expect(env?.error?.code).toBe('SUBPROCESS_KILLED');
    expect(env?.error?.message).toContain('SIGKILL');
    expect(env?.error?.details).toMatchObject({ signal: 'SIGKILL' });
  });

  it("keeps the server's own kills on their own codes although they carry a signal", () => {
    expect(
      mapSubprocessFailure({ ...base, exitCode: null, timedOut: true, signal: 'SIGTERM' }, 'opa')
        ?.error?.code,
    ).toBe('TIMEOUT');
    expect(
      mapSubprocessFailure(
        { ...base, exitCode: null, timedOut: false, outputTruncated: true, signal: 'SIGTERM' },
        'opa',
      )?.error?.code,
    ).toBe('OUTPUT_TOO_LARGE');
  });

  it('prefers CANCELLED over both when the client aborted', () => {
    const env = mapSubprocessFailure(
      { ...base, exitCode: null, timedOut: true, aborted: true },
      'opa',
    );
    expect(env?.error?.code).toBe('CANCELLED');
  });

  it('returns undefined for a normally-exited process', () => {
    expect(mapSubprocessFailure({ ...base, exitCode: 0, timedOut: false }, 'opa')).toBeUndefined();
    expect(mapSubprocessFailure({ ...base, exitCode: 1, timedOut: false }, 'opa')).toBeUndefined();
  });
});

describe('sanitizeInlinePath', () => {
  it('rewrites a temp inline-source path to <inline> (Windows and POSIX)', () => {
    expect(
      sanitizeInlinePath('C:\\Users\\x\\AppData\\Local\\Temp\\orygn-opa-mcp-AbC123\\input.rego'),
    ).toBe('<inline>');
    expect(sanitizeInlinePath('/tmp/orygn-opa-mcp-AbC123/input.rego')).toBe('<inline>');
    expect(sanitizeInlinePath('/tmp/orygn-regal-mcp-Z9/input.rego')).toBe('<inline>');
  });

  it('leaves a real user file path untouched', () => {
    expect(sanitizeInlinePath('/home/user/policies/authz.rego')).toBe(
      '/home/user/policies/authz.rego',
    );
  });
});

describe('sanitizeInlinePathsDeep', () => {
  const temp = '/tmp/orygn-opa-mcp-Xy9/input.rego';

  it('rewrites temp paths in nested string values (trace shape)', () => {
    const trace = [{ Op: 'Enter', Location: { file: temp, row: 3 } }];
    expect(sanitizeInlinePathsDeep(trace)).toEqual([
      { Op: 'Enter', Location: { file: '<inline>', row: 3 } },
    ]);
  });

  it('rewrites temp paths used as object keys (coverage shape)', () => {
    const coverage = { files: { [temp]: { covered: [{ start: { row: 1 } }] } } };
    expect(sanitizeInlinePathsDeep(coverage)).toEqual({
      files: { '<inline>': { covered: [{ start: { row: 1 } }] } },
    });
  });

  it('leaves real paths and non-string scalars untouched', () => {
    const input = { file: '/etc/policies/p.rego', n: 5, flag: true, nothing: null, list: ['a'] };
    expect(sanitizeInlinePathsDeep(input)).toEqual(input);
  });
});
