/**
 * Server identity shared between the entry point and the mcp_server_info
 * tool. Defined here to avoid a circular import
 * (server.ts -> tools -> meta -> server.ts).
 */
import { createRequire } from 'node:module';

export const SERVER_NAME = 'orygn-opa-mcp';

/**
 * Read from package.json, which the release flow bumps, so the server cannot
 * report one version while carrying another. Every packaging places
 * package.json beside dist: the npm tarball, the Docker image and the .mcpb
 * bundle.
 */
function versionFromPackage(): string {
  const pkg: unknown = createRequire(import.meta.url)('../package.json');
  const version =
    typeof pkg === 'object' && pkg !== null ? (pkg as { version?: unknown }).version : undefined;
  if (typeof version !== 'string') throw new Error('package.json beside dist has no version');
  return version;
}

export const SERVER_VERSION: string = versionFromPackage();
