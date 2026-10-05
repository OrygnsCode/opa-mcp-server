/**
 * Tests for formatEnvelope — the size-cap and MCP-result wrapper.
 */
import { describe, expect, it } from 'vitest';

import { fitPrefix, formatEnvelope } from '../../../src/lib/output.js';
import type { ToolEnvelope } from '../../../src/types.js';

const okEnvelope = <T>(data: T): ToolEnvelope<T> => ({ ok: true, data });
const errEnvelope = (): ToolEnvelope<never> => ({
  ok: false,
  error: { code: 'INVALID_INPUT', message: 'nope' },
});

describe('formatEnvelope — basic shape', () => {
  it('wraps a success envelope in MCP content with a single text part', () => {
    const result = formatEnvelope(okEnvelope({ x: 1 }), 100_000);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true, data: { x: 1 } });
    expect(result.isError).toBe(false);
  });

  it('sets isError: true for error envelopes', () => {
    const result = formatEnvelope(errEnvelope(), 100_000);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('INVALID_INPUT');
  });

  it('serializes compact JSON, without indentation', () => {
    const result = formatEnvelope(okEnvelope({ a: { nested: 'thing' } }), 100_000);
    expect(result.content[0]!.text).toBe('{"ok":true,"data":{"a":{"nested":"thing"}}}');
  });
});

describe('formatEnvelope — truncation', () => {
  it('does not truncate envelopes that fit within maxBytes', () => {
    const result = formatEnvelope(okEnvelope({ x: 'hello' }), 100_000);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<{ x: string }>;
    expect(parsed.data?.x).toBe('hello');
    expect(parsed.truncated).toBeUndefined();
  });

  it('replaces a too-large data payload with a marker giving the size and the cap', () => {
    const huge = { items: Array.from({ length: 10_000 }, (_, i) => `item-${i}`) };
    const result = formatEnvelope(okEnvelope(huge), 1_000);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<{
      __truncated?: boolean;
      message?: string;
    }>;
    expect(parsed.truncated).toBe(true);
    expect(parsed.data?.__truncated).toBe(true);
    expect(parsed.data?.message).toMatch(/^The response was \d+ bytes, over the 1000-byte cap/);
    expect(parsed.data?.message).not.toMatch(/file/);
  });

  it('lets a tool shrink its own payload, keeping what fits', () => {
    const data = { result: 'kept', lines: Array.from({ length: 500 }, (_, i) => `line ${i}`) };
    const result = formatEnvelope(okEnvelope(data), 1_000, (d, fits) =>
      fitPrefix(d.lines, (lines) => ({ ...d, lines }), fits),
    );
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text) as ToolEnvelope<typeof data>;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000);
    expect(parsed.truncated).toBe(true);
    expect(parsed.data?.result).toBe('kept');
    expect(parsed.data?.lines.length).toBeGreaterThan(10);
    expect(parsed.data?.lines[0]).toBe('line 0');
  });

  it('falls back to the marker when the shrunk payload still does not fit', () => {
    const data = { result: 'x'.repeat(5_000), lines: ['a'] };
    const result = formatEnvelope(okEnvelope(data), 1_000, (d, fits) =>
      fitPrefix(d.lines, (lines) => ({ ...d, lines }), fits),
    );
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<{ __truncated?: boolean }>;
    expect(parsed.data?.__truncated).toBe(true);
  });

  it('drops oversize error details first and keeps the message and code', () => {
    const bigErr: ToolEnvelope<never> = {
      ok: false,
      error: {
        code: 'EVAL_ERROR',
        message: 'opa eval exited with an error.',
        details: { stderr: 'y'.repeat(5000) },
      },
    };
    const result = formatEnvelope(bigErr, 1_000);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<unknown>;
    expect(Buffer.byteLength(result.content[0]!.text, 'utf8')).toBeLessThanOrEqual(1_000);
    expect(parsed.ok).toBe(false);
    expect(parsed.truncated).toBe(true);
    expect(parsed.error?.code).toBe('EVAL_ERROR');
    expect(parsed.error?.message).toBe('opa eval exited with an error.');
    expect((parsed.error?.details as { __truncated?: boolean }).__truncated).toBe(true);
  });

  it('cuts the message last, and only as far as the cap requires', () => {
    // No details to drop; the message alone is over the cap, so it is cut
    // and marked. The cap is a cap for errors too.
    const longMessage = 'x'.repeat(2000);
    const longErr: ToolEnvelope<never> = {
      ok: false,
      error: { code: 'UNKNOWN_ERROR', message: longMessage },
    };
    const result = formatEnvelope(longErr, 1_000);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<unknown>;
    expect(Buffer.byteLength(result.content[0]!.text, 'utf8')).toBeLessThanOrEqual(1_000);
    expect(parsed.ok).toBe(false);
    expect(parsed.truncated).toBe(true);
    expect(parsed.error?.code).toBe('UNKNOWN_ERROR');
    expect(parsed.error?.message).toMatch(/^x{100,}.* \[truncated\]$/);
  });

  it('holds the cap when the message is mostly characters JSON escapes', () => {
    // A newline is two bytes once serialised, a control character six. The
    // cut is measured on the serialised text, so the cap holds anyway.
    for (const filler of ['\n', '"', String.fromCharCode(0)]) {
      const env: ToolEnvelope<never> = {
        ok: false,
        error: { code: 'UNKNOWN_ERROR', message: filler.repeat(3000) },
      };
      const text = formatEnvelope(env, 1_000).content[0]!.text;
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000);
      const parsed = JSON.parse(text) as ToolEnvelope<unknown>;
      expect(parsed.error?.code).toBe('UNKNOWN_ERROR');
      expect(parsed.error?.message).toMatch(/\[truncated\]$/);
    }
  });

  it('bounds a huge hint and huge warnings as well', () => {
    const env: ToolEnvelope<never> = {
      ok: false,
      error: { code: 'EVAL_ERROR', message: 'short', hint: 'h'.repeat(5000) },
      warnings: ['w'.repeat(5000)],
    };
    const text = formatEnvelope(env, 1_000).content[0]!.text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000);
    const parsed = JSON.parse(text) as ToolEnvelope<unknown>;
    expect(parsed.error?.message).toBe('short');
    expect(parsed.error?.hint).toMatch(/\[truncated\]$/);
    expect(parsed.warnings?.[0]).toMatch(/warnings dropped/);
  });

  it('keeps small details next to a huge message, since dropping them would not help', () => {
    const env: ToolEnvelope<never> = {
      ok: false,
      error: { code: 'EVAL_ERROR', message: 'm'.repeat(3000), details: { exitCode: 2 } },
    };
    const text = formatEnvelope(env, 1_000).content[0]!.text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000);
    const parsed = JSON.parse(text) as ToolEnvelope<unknown>;
    expect(parsed.error?.details).toEqual({ exitCode: 2 });
    expect(parsed.error?.message).toMatch(/\[truncated\]$/);
  });

  it('bounds the warnings of a success envelope, keeping small data', () => {
    const env: ToolEnvelope<{ x: number }> = {
      ok: true,
      data: { x: 1 },
      warnings: ['w'.repeat(5000)],
    };
    const text = formatEnvelope(env, 1_000).content[0]!.text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000);
    const parsed = JSON.parse(text) as ToolEnvelope<unknown>;
    expect(parsed.data).toEqual({ x: 1 });
    expect(parsed.warnings?.[0]).toMatch(/warnings dropped/);
    expect(parsed.truncated).toBe(true);
  });

  it('bounds the warnings of an envelope that has no data', () => {
    const env: ToolEnvelope<never> = { ok: true, warnings: Array(200).fill('warning text') };
    const text = formatEnvelope(env, 1_000).content[0]!.text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000);
    expect((JSON.parse(text) as ToolEnvelope<unknown>).warnings).toHaveLength(1);
  });

  it('leaves warnings alone when replacing them would not shrink the envelope', () => {
    const env: ToolEnvelope<never> = {
      ok: false,
      error: { code: 'EVAL_ERROR', message: 'm'.repeat(3000) },
      warnings: ['w'],
    };
    const parsed = JSON.parse(formatEnvelope(env, 1_000).content[0]!.text) as ToolEnvelope<unknown>;
    expect(parsed.warnings).toEqual(['w']);
    expect(parsed.error?.message).toMatch(/\[truncated\]$/);
  });

  it('leaves an error that fits alone', () => {
    const smallErr: ToolEnvelope<never> = {
      ok: false,
      error: { code: 'UNKNOWN_ERROR', message: 'short', details: { a: 1 } },
    };
    const parsed = JSON.parse(
      formatEnvelope(smallErr, 10_000).content[0]!.text,
    ) as ToolEnvelope<unknown>;
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.error?.details).toEqual({ a: 1 });
  });

  it('measures size in UTF-8 bytes (not character count)', () => {
    // Each emoji takes 4 bytes in UTF-8. 300 emoji = 1200 bytes,
    // which exceeds a 1000-byte cap even though it is only 300
    // characters.
    const heavyChars = '🎉'.repeat(300);
    const result = formatEnvelope(okEnvelope({ payload: heavyChars }), 1_000);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<{
      __truncated?: boolean;
    }>;
    expect(parsed.truncated).toBe(true);
    expect(parsed.data?.__truncated).toBe(true);
  });
});

describe('formatEnvelope — warnings preservation', () => {
  it('keeps warnings on the envelope through truncation', () => {
    const env: ToolEnvelope<unknown> = {
      ok: true,
      data: { lots: 'x'.repeat(10_000) },
      warnings: ['stale-cache'],
    };
    const result = formatEnvelope(env, 1_000);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<unknown>;
    expect(parsed.warnings).toEqual(['stale-cache']);
    expect(parsed.truncated).toBe(true);
  });
});

describe('fitPrefix', () => {
  it('finds the longest prefix that fits', () => {
    const got = fitPrefix(
      [1, 2, 3, 4, 5],
      (p) => p,
      (p) => p.length <= 3,
    );
    expect(got).toEqual([1, 2, 3]);
  });

  it('keeps everything when everything fits, and gives up when nothing does', () => {
    expect(
      fitPrefix(
        [1, 2],
        (p) => p,
        () => true,
      ),
    ).toEqual([1, 2]);
    expect(
      fitPrefix(
        [1, 2],
        (p) => p,
        () => false,
      ),
    ).toBeUndefined();
  });
});
