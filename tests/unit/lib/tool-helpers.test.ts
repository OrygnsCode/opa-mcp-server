import { describe, expect, it } from 'vitest';

import { sanitizeInlinePath, sanitizeInlinePathsDeep } from '../../../src/lib/tool-helpers.js';

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
