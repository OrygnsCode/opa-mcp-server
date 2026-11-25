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

// A test run is not use. Servers the tests start inherit this, including the
// installed copy the distribution test runs, which would otherwise count as
// a real install. Tests of the switch itself pass their own environment.
process.env['OPA_MCP_TELEMETRY'] = 'off';
