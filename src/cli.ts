/**
 * CLI output: --help, --version, and the startup banner.
 *
 * All output is plain text when the target stream is not a TTY so
 * that log collectors and CI runners never receive raw escape codes.
 */
import type { Config } from './config.js';
import { SERVER_VERSION } from './constants.js';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const CY = '\x1b[36m';

function a(on: boolean, ...codes: string[]): string {
  return on ? codes.join('') : '';
}

// ─── Box header ───────────────────────────────────────────────────────────────

// Visible content of the middle row (between the │ chars):
//   "  opa-mcp  v0.1.5  by Orygn " = 28 chars
// Box top/bottom uses 28 dashes so all three rows are the same width.

function boxHeader(col: boolean): string {
  const border = `${a(col, D)}╭────────────────────────────╮${a(col, R)}`;
  const name = `${a(col, B, CY)}opa-mcp${a(col, R)}`;
  const ver = `${a(col, D)}v${SERVER_VERSION}${a(col, R)}`;
  const by = `${a(col, D)}by Orygn${a(col, R)}`;
  const mid =
    `${a(col, D)}│${a(col, R)}` + `  ${name}  ${ver}  ${by} ` + `${a(col, D)}│${a(col, R)}`;
  const foot = `${a(col, D)}╰────────────────────────────╯${a(col, R)}`;
  return [border, mid, foot].join('\n');
}

// ─── Public formatters ────────────────────────────────────────────────────────

export function formatVersion(): string {
  return `opa-mcp v${SERVER_VERSION}`;
}

export function formatHelp(col: boolean): string {
  const h = (s: string) => `${a(col, B)}${s}${a(col, R)}`;
  const d = (s: string) => `${a(col, D)}${s}${a(col, R)}`;

  const rows: [string, string, string][] = [
    ['OPA_BINARY', 'opa binary path', 'opa'],
    ['REGAL_BINARY', 'regal binary path', 'regal'],
    ['OPA_URL', 'OPA server base URL', 'http://localhost:8181'],
    ['OPA_TOKEN', 'OPA authentication token', ''],
    ['OPA_MCP_ALLOWED_PATHS', 'allowed filesystem roots, comma or semicolon separated', ''],
    ['OPA_MCP_TIMEOUT_MS', 'subprocess timeout in ms', '30000'],
    ['OPA_MCP_HTTP_TIMEOUT_MS', 'OPA HTTP request timeout', '15000'],
    ['OPA_MCP_LOG_FILE', 'log file path', '<tmpdir>/orygn-opa-mcp.log'],
    ['OPA_MCP_LOG_LEVEL', 'log level  (debug|info|warn|error)', 'info'],
    ['OPA_MCP_MAX_RESPONSE_BYTES', 'max response size in bytes', '100000'],
  ];

  // Pad name to 28 and description to 38 so the default column lines up.
  const envLines = rows
    .map(([name, desc, def]) => {
      const namePad = name.padEnd(28);
      const descPad = desc.padEnd(38);
      const defStr = def ? `${d('default: ' + def)}` : '';
      return `  ${namePad}${descPad}${defStr}`;
    })
    .join('\n');

  return [
    boxHeader(col),
    '',
    'Exposes OPA and Regal as MCP tools over stdio.',
    'Add to Claude Code, Cursor, or any MCP-compatible client.',
    '',
    h('Configuration (environment variables):'),
    '',
    envLines,
    '',
    h('Flags:'),
    '',
    '  -h, --help     print this message and exit',
    '  -v, --version  print version and exit',
    '',
    h('Usage:'),
    '',
    '  npx @orygn/opa-mcp',
    '  OPA_MCP_ALLOWED_PATHS=/my/policies npx @orygn/opa-mcp',
    '',
  ].join('\n');
}

export function formatStartupBanner(config: Config, col: boolean): string {
  const paths =
    config.allowedPaths.length > 0 ? config.allowedPaths.join(', ') : '(none configured)';

  const fields = [
    `opa=${config.opaBinary}`,
    `regal=${config.regalBinary}`,
    `paths=${paths}`,
    `log=${config.logFile}`,
  ].join('  ');

  const name = `${a(col, B, CY)}opa-mcp${a(col, R)}`;
  const ver = `${a(col, D)}v${SERVER_VERSION}${a(col, R)}`;
  const rest = `${a(col, D)}${fields}${a(col, R)}`;

  return `${name} ${ver}  ${rest}`;
}

// ─── Arg parser ───────────────────────────────────────────────────────────────

export function parseCliArgs(argv: string[]): { help: boolean; version: boolean } {
  const help = argv.includes('--help') || argv.includes('-h');
  const version = argv.includes('--version') || argv.includes('-v');
  return { help, version };
}
