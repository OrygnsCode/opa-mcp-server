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
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { formatHelp, formatStartupBanner, formatVersion, parseCliArgs } from './cli.js';

import { loadConfig, type Config } from './config.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { initLogger, logger } from './lib/logger.js';
import { getInstallId } from './lib/install-id.js';
import { ConftestCli } from './lib/conftest-cli.js';
import { OpaCli } from './lib/opa-cli.js';
import { RegalCli } from './lib/regal-cli.js';
import { isZ3Busy, isZ3Failure, markZ3Unusable, z3RecoveriesLeft } from './lib/rego-z3.js';
import { redactUrlCredentials } from './lib/opa-client.js';
import { terminateChildren } from './lib/subprocess.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools } from './tools/index.js';

export { SERVER_NAME, SERVER_VERSION };

function sendTelemetryPing(): void {
  if (process.env['OPA_MCP_NO_TELEMETRY'] === '1') return;
  void (async () => {
    const params = new URLSearchParams({
      v: SERVER_VERSION,
      p: process.platform,
    });
    const id = await getInstallId().catch(() => null);
    if (id) params.set('u', id);
    await fetch(`https://opa-mcp-telemetry.gibbidaniel.workers.dev/ping?${params.toString()}`, {
      signal: AbortSignal.timeout(3000),
    });
  })().catch(() => {});
}

/**
 * Construct an `McpServer`, register every tool / prompt / resource
 * onto it, and return it. Exported for tests so they can drive a
 * fully-loaded server without standing up a stdio transport.
 */
export function buildServer(config: Config): McpServer {
  initLogger(config.logFile, config.logLevel);

  logger.info('starting orygn-opa-mcp', {
    version: SERVER_VERSION,
    opaUrl: redactUrlCredentials(config.opaUrl),
    opaBinary: config.opaBinary,
    regalBinary: config.regalBinary,
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for writing, testing and debugging Open Policy Agent (OPA) Rego policies. A policy is not done until it has been probed: call rego_eval with an `inputs` batch in which each field the policy reads is absent, null or of the wrong type, and check that nothing that should be denied is allowed; then keep those inputs as rego_test cases. rego_check, rego_lint and rego_security_audit find compile and lint problems, not rules that let a request through. rego_* tools run the local opa binary (OPA_BINARY); rego_lint, rego_security_audit and rego_fix also need regal (REGAL_BINARY); no OPA server is needed. opa_* server tools talk to a running OPA at OPA_URL (OPA_TOKEN for bearer auth). conftest_* tools run conftest (CONFTEST_BINARY) on Kubernetes, Terraform, Helm and Dockerfile configs; a conftest run that evaluated no rule is reported as not passed. File paths must be inside OPA_MCP_ALLOWED_PATHS; inline `source` works without it. rego_explain_undefined says why a rule has no value, fell back to its default, or (for a set such as deny) matched nothing; rego_explain_decision traces a decision as readable lines. rego_migrate_v1 converts pre-1.0 Rego; tools that load Rego take v0Compatible for code not converted yet. rego_verify proves properties of simple equality rules and answers inconclusive for most real policies, which says nothing about safety. If a tool returns OPA_BINARY_NOT_FOUND, REGAL_NOT_FOUND or CONFTEST_NOT_FOUND, tell the user which binary is missing; mcp_server_info shows which are reachable.',
    },
  );

  registerTools(server, config);
  registerPrompts(server, config);
  registerResources(server, config);

  return server;
}

/**
 * Probe the configured `opa`, `regal` and `conftest` binaries at startup
 * and log a warning for each that is unreachable. Runs in the background so it
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
      'startup self-check: regal binary not reachable; rego_lint, rego_security_audit and rego_fix will return REGAL_NOT_FOUND',
      {
        regalBinary: config.regalBinary,
        hint: 'set REGAL_BINARY to an absolute path, or ensure regal is on PATH. Regal is optional; only rego_lint, rego_security_audit and rego_fix require it.',
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

  // A child sits in its own process group (see lib/subprocess.ts), so a
  // signal that stops the server does not reach it by itself. Not when a
  // test drives the server through its own transport: the runner owns the
  // signals then.
  if (!transport) {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => {
        terminateChildren('SIGTERM');
        process.exit(sig === 'SIGINT' ? 130 : 143);
      });
    }

    // Z3 lives in a WASM heap that, exhausted, aborts outside every
    // try/catch. Verification is the only thing on that heap, so give it up
    // and keep the server rather than the reverse. Anything else uncaught is
    // a bug the process must not paper over.
    process.on('uncaughtException', (e: unknown) => {
      const detail = e instanceof Error ? e.message : String(e);
      // Only a WASM fault while a solve is running is Z3's; anything else
      // that happens to land in that window is a bug of its own.
      if (isZ3Busy() && isZ3Failure(e)) {
        markZ3Unusable(detail);
        logger.error(
          z3RecoveriesLeft() > 0
            ? 'Z3 faulted outside a try/catch; the solve in flight is retried on a fresh Z3'
            : 'Z3 faulted outside a try/catch and no recoveries remain; rego_verify is disabled until restart',
          { error: detail, recoveriesLeft: z3RecoveriesLeft() },
        );
        return;
      }
      logger.error('uncaught exception', {
        error: e instanceof Error ? (e.stack ?? detail) : detail,
      });
      process.exit(1);
    });
  }

  const connectTo = transport ?? new StdioServerTransport();
  await server.connect(connectTo);

  logger.info('connected to transport, ready for requests');

  // Fire-and-forget; do not block initialize on subprocess probes.
  void runStartupSelfCheck(config).catch((cause: unknown) => {
    logger.error('startup self-check threw unexpectedly', { error: cause });
  });

  sendTelemetryPing();

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
    // Compare real paths. Node resolves symlinks for the module's own URL but
    // leaves process.argv[1] as it was invoked, so a server reached through a
    // link saw two different strings and started nothing: no --version, no
    // --help, and no transport, which a client sees as a process that exits
    // immediately. npm's bin entry is a symlink on macOS and Linux, and
    // installing globally or running through npx goes through it.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    // A path that cannot be resolved is not this module.
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
