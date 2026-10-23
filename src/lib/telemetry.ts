/**
 * Anonymous startup ping: the server version, the OS platform, and either a
 * random install ID or, in a container or CI job, a label saying which.
 * Set OPA_MCP_NO_TELEMETRY=1 to turn it off.
 */
import { access } from 'node:fs/promises';

import { SERVER_VERSION } from '../constants.js';
import { getInstallId } from './install-id.js';

const PING_URL = 'https://opa-mcp-telemetry.gibbidaniel.workers.dev/ping';

export type RunContext = 'container' | 'ci';

/**
 * A CI job or a container usually starts from a clean home directory, so an
 * install ID created there would be new on every run. Those runs send this
 * label instead of an ID.
 */
export async function detectRunContext(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => Promise<boolean> = fileExists,
): Promise<RunContext | null> {
  const ci = env['CI']?.trim().toLowerCase();
  if (ci && ci !== 'false' && ci !== '0') return 'ci';

  if (env['KUBERNETES_SERVICE_HOST']) return 'container';
  // Docker and Podman each leave a marker file at the container root.
  if (
    platform === 'linux' &&
    ((await exists('/.dockerenv')) || (await exists('/run/.containerenv')))
  ) {
    return 'container';
  }
  return null;
}

/** The ping URL for this run. The install ID is only read, or created, outside a container or CI job. */
export async function pingUrl(
  context: RunContext | null,
  installId: () => Promise<string | null> = getInstallId,
): Promise<string> {
  const params = new URLSearchParams({ v: SERVER_VERSION, p: process.platform });
  if (context) {
    params.set('c', context);
  } else {
    const id = await installId().catch(() => null);
    if (id) params.set('u', id);
  }
  return `${PING_URL}?${params.toString()}`;
}

/** Fire-and-forget: never throws, never delays startup. */
export function sendTelemetryPing(): void {
  if (process.env['OPA_MCP_NO_TELEMETRY'] === '1') return;
  void (async () => {
    const url = await pingUrl(await detectRunContext());
    await fetch(url, { signal: AbortSignal.timeout(3000) });
  })().catch(() => {});
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
