import { describe, expect, it } from 'vitest';

import {
  mapSubprocessFailure,
  sanitizeInlinePath,
  sanitizeInlinePathsDeep,
  sanitizeInlineText,
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

describe('sanitizeInlineText', () => {
  const sep = String.fromCharCode(92);
  const win = (...parts: string[]): string => parts.join(sep);

  it('replaces the temp path inside a diagnostic line, on either separator', () => {
    expect(
      sanitizeInlineText('1 error occurred: /tmp/orygn-opa-mcp-xyz789/input.rego:3: bad'),
    ).toBe('1 error occurred: <inline>:3: bad');
    const p = win(
      'C:',
      'Users',
      'op',
      'AppData',
      'Local',
      'Temp',
      'orygn-regal-mcp-ab12',
      'input.rego',
    );
    expect(sanitizeInlineText(`${p}:1:1 x`)).toBe('<inline>:1:1 x');
  });

  it('replaces the whole path when a directory on it holds a space', () => {
    // A Windows temp directory sits under the user's profile.
    const p = win(
      'C:',
      'Users',
      'Daniel Okwor',
      'AppData',
      'Local',
      'Temp',
      'orygn-opa-mcp-ab12',
      'input.rego',
    );
    expect(sanitizeInlineText(`1 error occurred: ${p}:3:5: rego_parse_error`)).toBe(
      '1 error occurred: <inline>:3:5: rego_parse_error',
    );
    expect(sanitizeInlineText('at /Users/a b/Library/Caches/orygn-opa-mcp-q/input.rego:1')).toBe(
      'at <inline>:1',
    );
  });

  it('keeps the text around a path that is the whole of a string', () => {
    expect(sanitizeInlineText('error: could not open /tmp/orygn-opa-mcp-x1/input.rego')).toBe(
      'error: could not open <inline>',
    );
  });

  it('leaves other paths alone', () => {
    expect(sanitizeInlineText('/srv/policies/input.rego:3: bad')).toBe(
      '/srv/policies/input.rego:3: bad',
    );
  });
});

describe('sanitizeInlineText, the spellings a diagnostic can carry', () => {
  const sep = String.fromCharCode(92);
  const win = (...parts: string[]): string => parts.join(sep);
  const temp = win('C:', 'Users', 'Daniel Okwor', 'AppData', 'Local', 'Temp');

  it('replaces a JSON-encoded path, where every backslash is doubled', () => {
    const p = win(
      'C:',
      'Users',
      'op',
      'AppData',
      'Local',
      'Temp',
      'orygn-opa-mcp-ab12',
      'input.rego',
    );
    const encoded = JSON.stringify({ location: { file: p, row: 3 } });
    expect(sanitizeInlineText(encoded)).toBe('{"location":{"file":"<inline>","row":3}}');
  });

  it('replaces the schema and bundle-verify temp files as well', () => {
    expect(
      sanitizeInlineText(`schema error at ${win(temp, 'orygn-schema-x1', 'schema.json')}:1`),
    ).toBe('schema error at <inline>:1');
    expect(
      sanitizeInlineText('cannot open /tmp/orygn-opa-mcp-verify-q/verified.tar.gz for reading'),
    ).toBe('cannot open <inline> for reading');
  });

  it('replaces a UNC path whole and a relative spelling', () => {
    expect(
      sanitizeInlineText(win('', '', 'srv', 'tmp', 'orygn-opa-mcp-z', 'input.rego') + ':1'),
    ).toBe('<inline>:1');
    expect(sanitizeInlineText('in orygn-opa-mcp-z/input.rego:2')).toBe('in <inline>:2');
  });

  it('keeps distinct keys distinct in sanitizeInlinePathsDeep', () => {
    const p = '/tmp/orygn-opa-mcp-a/input.rego';
    const out = sanitizeInlinePathsDeep({
      [p]: 1,
      [`1 error occurred: ${p}`]: 2,
      [win(temp, 'orygn-opa-mcp-a', 'input.rego')]: 3,
    }) as Record<string, number>;
    expect(Object.keys(out).sort()).toEqual(['1 error occurred: <inline>', '<inline>'].sort());
    expect(out['1 error occurred: <inline>']).toBe(2);
  });

  it("keeps the prose and the caller's own path around a slash path", () => {
    expect(
      sanitizeInlineText('loading /policies/a.rego failed at /tmp/orygn-opa-mcp-a/input.rego:3'),
    ).toBe('loading /policies/a.rego failed at <inline>:3');
    // A profile directory with a space is still taken whole on a backslash
    // path, under a drive letter, and in its JSON-encoded form.
    const p = win(
      'C:',
      'Users',
      'Daniel Okwor',
      'AppData',
      'Local',
      'Temp',
      'orygn-opa-mcp-a',
      'input.rego',
    );
    expect(sanitizeInlineText(`x ${p}:1`)).toBe('x <inline>:1');
    expect(sanitizeInlineText(JSON.stringify({ file: p }))).toBe('{"file":"<inline>"}');
    expect(
      sanitizeInlineText('x C:/Users/Daniel Okwor/AppData/Local/Temp/orygn-opa-mcp-a/input.rego:1'),
    ).toBe('x <inline>:1');
  });

  it('does not take the last letter of a word for a drive', () => {
    expect(
      sanitizeInlineText(`see abc:${win('', 'Users', 'op', 'orygn-opa-mcp-a', 'input.rego')}:1`),
    ).toBe('see abc:<inline>:1');
    expect(sanitizeInlineText('at file:///tmp/orygn-opa-mcp-a/input.rego:1')).toBe(
      'at file:<inline>:1',
    );
  });

  it('is linear on a long line of markers that never complete', () => {
    const line = 'orygn-opa-mcp-aaaaaaaaaaaaaaaaaaaa '.repeat(30_000);
    const started = performance.now();
    expect(sanitizeInlineText(line)).toBe(line);
    expect(performance.now() - started).toBeLessThan(300);
  });

  it('is linear on a long line of separators', () => {
    const line = '/a'.repeat(200_000) + ' orygn-';
    const started = performance.now();
    expect(sanitizeInlineText(line)).toBe(line);
    expect(performance.now() - started).toBeLessThan(200);
    const withPath = '/a'.repeat(200_000) + '/orygn-opa-mcp-q/input.rego';
    const again = performance.now();
    expect(sanitizeInlineText(withPath)).toBe('<inline>');
    expect(performance.now() - again).toBeLessThan(200);
  });
});
