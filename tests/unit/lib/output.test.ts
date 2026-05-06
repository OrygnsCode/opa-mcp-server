/**
 * Tests for formatEnvelope — the size-cap and MCP-result wrapper.
 */
import { describe, expect, it } from 'vitest';

import { formatEnvelope } from '../../../src/lib/output.js';
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

  it('serializes data as pretty-printed JSON (two-space indent)', () => {
    const result = formatEnvelope(okEnvelope({ a: { nested: 'thing' } }), 100_000);
    const text = result.content[0]!.text;
    expect(text).toContain('\n  ');
  });
});

describe('formatEnvelope — truncation', () => {
  it('does not truncate envelopes that fit within maxBytes', () => {
    const result = formatEnvelope(okEnvelope({ x: 'hello' }), 100_000);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<{ x: string }>;
    expect(parsed.data?.x).toBe('hello');
    expect(parsed.truncated).toBeUndefined();
  });

  it('replaces a too-large data payload with a __truncated marker', () => {
    const huge = { items: Array.from({ length: 10_000 }, (_, i) => `item-${i}`) };
    const result = formatEnvelope(okEnvelope(huge), 1_000);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<{
      __truncated?: boolean;
      message?: string;
    }>;
    expect(parsed.truncated).toBe(true);
    expect(parsed.data?.__truncated).toBe(true);
    expect(parsed.data?.message).toMatch(/exceeded maxResponseBytes/i);
  });

  it('keeps error envelopes intact even when over the size cap (errors must be readable)', () => {
    const longMessage = 'x'.repeat(2000);
    const longErr: ToolEnvelope<never> = {
      ok: false,
      error: { code: 'UNKNOWN_ERROR', message: longMessage },
    };
    const result = formatEnvelope(longErr, 1_000);
    const parsed = JSON.parse(result.content[0]!.text) as ToolEnvelope<unknown>;
    expect(parsed.ok).toBe(false);
    // The truncation flag should be set, but the error stays readable
    // because the truncation only replaces the `data` field.
    expect(parsed.error?.message).toBe(longMessage);
    expect(parsed.truncated).toBe(true);
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
