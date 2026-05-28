#!/usr/bin/env node
/**
 * @orygn/opa-mcp -- entry point.
 *
 * Initializes the MCP server, registers tools/prompts/resources,
 * and connects the stdio transport.
 *
 * IMPORTANT: never write to stdout from anywhere in this process --
 * stdout is the MCP protocol channel. Use `logger` (file) or stderr.
 */
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { formatHelp, formatStartupBanner, formatVersion, parseCliArgs } from './cli.js';

import { loadConfig, type Config } from './config.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { initLogger, logger } from './lib/logger.js';
import { ConftestCli } from './lib/conftest-cli.js';
import { OpaCli } from './lib/opa-cli.js';
import { RegalCli } from './lib/regal-cli.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools } from './tools/index.js';

export { SERVER_NAME, SERVER_VERSION };

/**
 * Construct an `McpServer`, register every tool / prompt / resource
 * onto it, and return it. Exported for tests so they can drive a
 * fully-loaded server without standing up a stdio transport.
 */
export function buildServer(config: Config): McpServer {
  initLogger(config.logFile, config.logLevel);

  logger.info('starting orygn-opa-mcp', {
    version: SERVER_VERSION,
    opaUrl: config.opaUrl,
    opaBinary: config.opaBinary,
    regalBinary: config.regalBinary,
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        '50 tools split into seven categories. rego_* authoring/analysis tools use the local opa binary (OPA_BINARY) -- no running OPA server required. rego_lint, rego_security_audit, and rego_fix additionally require regal (REGAL_BINARY). rego_verify does formal SMT-based verification using Z3 (bundled as WASM -- no extra install). rego_explain_undefined diagnoses why a query produces no value: it fuses a plain eval, a full-trace eval, and per-condition AST analysis to identify the exact body expression blocking each rule. opa_* server-management tools talk to a live OPA REST server via OPA_URL; start one locally with `opa run --server` or point at a deployed instance; set OPA_TOKEN if bearer-token auth is required. conftest_* tools use the local conftest binary (CONFTEST_BINARY) to test Kubernetes, Terraform, Helm, and Dockerfile configs against Rego policies. File-based tools require paths inside OPA_MCP_ALLOWED_PATHS; inline-source tools work without it. If a tool returns OPA_BINARY_NOT_FOUND, REGAL_NOT_FOUND, or CONFTEST_NOT_FOUND, tell the user which binary is missing and how to install it. Start with rego_check + rego_lint for policy authoring, rego_verify to prove correctness, rego_explain_undefined when a rule returns no value, conftest_test for config validation, mcp_server_info to confirm which binaries are reachable.',
    },
  );

  registerTools(server, config);
  registerPrompts(server, config);
  registerResources(server, config);

  return server;
}

/**
 * Probe the configured `opa` and `regal` binaries at startup and log
 * warnings if either is unreachable. Runs in the background so it
 * doesn't delay the MCP `initialize` handshake. Most users only see
 * the failure when they call a tool; surfacing it early in the log
 * file gives operators a place to look when diagnosing
 * `OPA_BINARY_NOT_FOUND` (most often caused by Claude Desktop's
 * reduced PATH on macOS and Windows).
 *
 * Exported for tests; production callers don't await it.
 */
export async function runStartupSelfCheck(config: Config): Promise<void> {
  const opa = new OpaCli(config);
  const regal = new RegalCli(config);
  const conftest = new ConftestCli(config);
  const [opaVersion, regalVersion, conftestVersion] = await Promise.all([
    opa.version().catch(() => null),
    regal.version().catch(() => null),
    conftest.version().catch(() => null),
  ]);

  if (opaVersion === null) {
    logger.warn('startup self-check: opa binary not reachable; rego_* tools will fail', {
      opaBinary: config.opaBinary,
      hint: 'set OPA_BINARY to an absolute path, or ensure opa is on PATH for the launching process. Most often hit under Claude Desktop, which spawns servers with a reduced PATH on macOS and Windows.',
    });
  } else {
    logger.info('startup self-check: opa OK', { version: opaVersion });
  }

  if (regalVersion === null) {
    logger.warn(
      'startup self-check: regal binary not reachable; rego_lint will return REGAL_NOT_FOUND',
      {
        regalBinary: config.regalBinary,
        hint: 'set REGAL_BINARY to an absolute path, or ensure regal is on PATH. Regal is optional; only rego_lint requires it.',
      },
    );
  } else {
    logger.info('startup self-check: regal OK', { version: regalVersion });
  }

  if (conftestVersion === null) {
    logger.warn(
      'startup self-check: conftest binary not reachable; conftest_* tools will return CONFTEST_NOT_FOUND',
      {
        conftestBinary: config.conftestBinary,
        hint: 'set CONFTEST_BINARY to an absolute path, or ensure conftest is on PATH. Conftest is optional; only conftest_* tools require it.',
      },
    );
  } else {
    logger.info('startup self-check: conftest OK', { version: conftestVersion });
  }
}

/**
 * Entry-point flow: load config from env, build the server, connect
 * to the supplied transport (defaults to stdio for production).
 *
 * Tests pass an in-memory transport so the connection succeeds
 * without touching real stdio. Production callers omit the argument
 * and get the standard stdio transport.
 */
export async function main(transport?: Transport): Promise<McpServer> {
  const config = loadConfig();
  const server = buildServer(config);

  // Print the startup banner to stderr when running from a real terminal,
  // not when a test passes in its own transport.
  if (!transport) {
    process.stderr.write(formatStartupBanner(config, process.stderr.isTTY === true) + '\n');
  }

  const connectTo = transport ?? new StdioServerTransport();
  await server.connect(connectTo);

  logger.info('connected to transport, ready for requests');

  // Fire-and-forget; do not block initialize on subprocess probes.
  void runStartupSelfCheck(config).catch((cause: unknown) => {
    logger.error('startup self-check threw unexpectedly', { error: cause });
  });

  return server;
}

/**
 * Auto-run when this module is invoked as the entry point (`node
 * dist/server.js` or via the `opa-mcp` bin shim). Tests that import
 * `server.ts` directly do not trip this branch.
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const { help, version, unknown } = parseCliArgs(process.argv.slice(2));
  const col = process.stdout.isTTY === true;

  if (unknown.length > 0) {
    process.stderr.write(
      `opa-mcp: unknown flag: ${unknown[0]!}\nRun 'opa-mcp --help' for usage.\n`,
    );
    process.exit(1);
  }

  if (help) {
    process.stdout.write(formatHelp(col) + '\n');
    process.exit(0);
  }

  if (version) {
    process.stdout.write(formatVersion() + '\n');
    process.exit(0);
  }

  main().catch((cause: unknown) => {
    logger.error('fatal error in server entry', { error: cause });
    console.error('orygn-opa-mcp fatal error:', cause);
    process.exit(1);
  });
}
