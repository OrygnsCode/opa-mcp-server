/**
 * Vitest global setup. Runs once per worker before any test file.
 *
 * Keeps tests deterministic by silencing the file logger to a per-worker
 * temp file no test reads.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLogger } from '../src/lib/logger.js';

const logFile = join(tmpdir(), `orygn-opa-mcp-test-${process.pid}.log`);
initLogger(logFile, 'error');
