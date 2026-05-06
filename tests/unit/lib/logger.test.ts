/**
 * Logger tests.
 *
 * The single most important contract: NEVER write to stdout. Stdout is
 * the MCP protocol channel — anything else there breaks the client
 * connection. We assert this directly by capturing process.stdout.write.
 *
 * Other contracts:
 *  - Pre-init logs are silently dropped (no throw, no output).
 *  - Append-only file writes.
 *  - JSON Lines format with timestamp, level, message, optional context.
 *  - Filesystem failures (permission, disk full) never throw.
 *  - Level filtering works per-call.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initLogger, logger } from '../../../src/lib/logger.js';

let workDir: string;
let logFile: string;

beforeEach(async () => {
  workDir = join(tmpdir(), `orygn-logger-test-${Date.now()}-${Math.random()}`);
  await mkdir(workDir, { recursive: true });
  logFile = join(workDir, 'test.log');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Stdout discipline', () => {
  it('never writes to process.stdout when logging at any level', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    initLogger(logFile, 'debug');
    logger.debug('debug-message', { ctx: 'a' });
    logger.info('info-message');
    logger.warn('warn-message', { ctx: { nested: 1 } });
    logger.error('error-message');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('never writes to process.stdout even with a missing log file (write fails)', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    initLogger('/nonexistent/dir/that/cannot/be/created/log.log', 'debug');
    // Filesystem write will throw internally; logger must swallow it
    // and absolutely not fall back to stdout.
    expect(() => {
      logger.error('this should not crash the server');
    }).not.toThrow();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

describe('Pre-init behavior', () => {
  it('drops log calls silently when initLogger has not been called', () => {
    // Force the singleton state back to undefined by initing to a
    // throwaway target then importing again would not work because
    // ESM caches; instead we test by writing before the next init.
    // The key contract: even when state is uninitialized in a fresh
    // process, calling logger.info must not throw.
    expect(() => logger.info('pre-init')).not.toThrow();
  });
});

describe('File output', () => {
  it('appends JSON Lines to the configured file', async () => {
    initLogger(logFile, 'debug');
    logger.info('first message');
    logger.info('second message');
    const content = await readFile(logFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as {
      ts: string;
      level: string;
      msg: string;
    };
    expect(first.level).toBe('info');
    expect(first.msg).toBe('first message');
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });

  it('preserves an existing log file and appends to it', async () => {
    await writeFile(logFile, '{"existing":true}\n', 'utf8');
    initLogger(logFile, 'debug');
    logger.info('appended');
    const content = await readFile(logFile, 'utf8');
    expect(content).toContain('{"existing":true}');
    expect(content).toContain('appended');
  });

  it('embeds the context object under "ctx"', async () => {
    initLogger(logFile, 'debug');
    logger.info('with-ctx', { request_id: 'abc-123', count: 5 });
    const content = await readFile(logFile, 'utf8');
    const entry = JSON.parse(content.trim()) as {
      ctx?: Record<string, unknown>;
    };
    expect(entry.ctx).toEqual({ request_id: 'abc-123', count: 5 });
  });

  it('omits ctx field when no context is provided', async () => {
    initLogger(logFile, 'debug');
    logger.info('no-ctx');
    const content = await readFile(logFile, 'utf8');
    const entry = JSON.parse(content.trim()) as Record<string, unknown>;
    expect('ctx' in entry).toBe(false);
  });
});

describe('Level filtering', () => {
  it('drops debug entries when minLevel is info', async () => {
    initLogger(logFile, 'info');
    logger.debug('hidden');
    logger.info('shown');
    const content = await readFile(logFile, 'utf8');
    expect(content).not.toContain('hidden');
    expect(content).toContain('shown');
  });

  it('drops everything below error when minLevel is error', async () => {
    initLogger(logFile, 'error');
    logger.debug('hidden-debug');
    logger.info('hidden-info');
    logger.warn('hidden-warn');
    logger.error('shown-error');
    const content = await readFile(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('shown-error');
  });

  it('writes everything when minLevel is debug', async () => {
    initLogger(logFile, 'debug');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    const content = await readFile(logFile, 'utf8');
    expect(content.trim().split('\n').filter(Boolean)).toHaveLength(4);
  });
});

describe('Robustness', () => {
  it('does not throw when context contains a circular reference', () => {
    initLogger(logFile, 'debug');
    const ctx: Record<string, unknown> = { name: 'cycle' };
    ctx['self'] = ctx;
    expect(() => {
      // The current implementation would throw on JSON.stringify with
      // a circular structure — verify the logger handles this without
      // crashing the server (silently drops the line is acceptable;
      // crashing is not).
      logger.info('cycle-test', ctx);
    }).not.toThrow();
  });

  it('does not throw when the log file path is unreachable', () => {
    initLogger('/this/path/does/not/exist/log.log', 'debug');
    expect(() => logger.info('unreachable')).not.toThrow();
  });
});
