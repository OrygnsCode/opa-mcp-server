/**
 * MCP roots as the file allow-list when OPA_MCP_ALLOWED_PATHS is not set.
 *
 * A client that supports roots (Claude Code, VS Code and others) tells the
 * server which folders the user is working in. With no allow-list in the
 * environment, the server asks for those folders once the client reports it
 * is initialized, and again whenever the client says they changed, and lets
 * file tools use exactly those folders. OPA_MCP_ALLOWED_PATHS, when set,
 * always wins and roots are never requested; OPA_MCP_NO_CLIENT_ROOTS=1 keeps
 * file tools off instead. A client without roots support leaves file tools
 * disabled, as before.
 *
 * The list is a security boundary, so it fails closed: while the client's
 * answer to a change is outstanding, and after a request fails, no folder is
 * allowed. A root the client removed must never stay usable because the new
 * list was late or unreadable.
 *
 * State is kept per server, keyed by the config object `buildServer` hands to
 * every tool, so `validatePaths` and `withToolEnvelope` can reach it without
 * each tool knowing about roots.
 */
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Config } from '../config.js';
import { logger } from './logger.js';

/** Where the allowed roots came from. */
export type AllowedPathsSource = 'env' | 'client-roots' | 'none';

/**
 * How long one `roots/list` request may take. Clients that support roots
 * answer from memory, so this only matters for one that advertises roots and
 * then does not reply.
 */
export const ROOTS_REQUEST_TIMEOUT_MS = 5_000;

/**
 * The longest a tool call waits for roots, across back-to-back requests when
 * the client reports changes faster than it answers. After it the call goes
 * ahead with no folders allowed.
 */
export const ROOTS_WAIT_MS = ROOTS_REQUEST_TIMEOUT_MS + 1_000;

/** After a failed request, the next tool call asks again once this much time has passed. */
export const ROOTS_RETRY_AFTER_MS = 30_000;

interface RootsState {
  server: Server;
  /** Allowed directories from the latest answer applied. */
  paths: string[];
  /** An answer, or a failure to get one, has been applied at least once. */
  settled: boolean;
  /** Why the latest request failed, when it did. */
  error?: string;
  /** When the latest failure was applied. */
  failedAt?: number;
  /** The refresh loop, while it runs. Never rejects. */
  inflight?: Promise<void>;
  /** A change was reported that no request has asked about yet. */
  dirty: boolean;
  /** Why the next request is being made, for the log. */
  reason: string;
}

const states = new WeakMap<Config, RootsState>();

const WINDOWS = process.platform === 'win32';

/** Is this a `file:` URI? The scheme is case-insensitive. */
function isFileUri(uri: string): boolean {
  return /^file:/i.test(uri);
}

/**
 * Turn the roots a client listed into absolute directory paths.
 *
 * Only `file:` URIs that name an absolute local path are kept. Windows clients
 * often percent-encode the drive colon (`file:///c%3A/src`), which
 * `fileURLToPath` decodes. Anything else is skipped and reported, never
 * guessed at: a root the server cannot place exactly must not widen access.
 */
export function rootsToPaths(roots: ReadonlyArray<{ uri: string }>): {
  paths: string[];
  skipped: Array<{ uri: string; reason: string }>;
} {
  const paths: string[] = [];
  const skipped: Array<{ uri: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const uri = typeof root?.uri === 'string' ? root.uri : '';
    if (!isFileUri(uri)) {
      skipped.push({ uri, reason: 'not a file: URI' });
      continue;
    }
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch (e) {
      skipped.push({ uri, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!isAbsolute(path)) {
      skipped.push({ uri, reason: 'not an absolute path' });
      continue;
    }
    const resolved = resolve(path);
    const key = WINDOWS ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(resolved);
  }
  return { paths, skipped };
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One `roots/list` request. An answer that arrives after the client reported
 * another change may already be out of date, so it is dropped and the loop
 * asks again.
 */
async function fetchOnce(state: RootsState): Promise<void> {
  const reason = state.reason;
  try {
    const result = await state.server.listRoots(undefined, {
      timeout: ROOTS_REQUEST_TIMEOUT_MS,
    });
    if (state.dirty) return;
    const { paths, skipped } = rootsToPaths(result.roots);
    state.paths = paths;
    state.error = undefined;
    state.failedAt = undefined;
    logger.info('using client roots as allowed paths', { reason, paths, skipped });
  } catch (e) {
    if (state.dirty) return;
    state.paths = [];
    state.error = describeError(e);
    state.failedAt = Date.now();
    logger.warn('could not read client roots; file tools are disabled', {
      reason,
      error: state.error,
    });
  }
}

/** Ask until an answer is applied with no change reported in the meantime. */
async function refreshLoop(state: RootsState): Promise<void> {
  try {
    while (state.dirty) {
      state.dirty = false;
      await fetchOnce(state);
    }
  } finally {
    // Runs in the same turn as the last check of `dirty`, so a change
    // reported from here on starts a new loop rather than being missed.
    state.inflight = undefined;
    state.settled = true;
  }
}

/**
 * Note a change and make sure a request will ask about it. One request at a
 * time: a client that reports changes faster than it answers gets one
 * outstanding request, not one per report.
 */
function refresh(state: RootsState, reason: string): Promise<void> {
  state.dirty = true;
  state.reason = reason;
  // `refreshLoop` always awaits before reaching `finally`, so `inflight` is
  // assigned before the loop can clear it.
  state.inflight ??= refreshLoop(state);
  return state.inflight;
}

/** Does the connected client say it supports roots? */
function clientSupportsRoots(state: RootsState): boolean {
  return state.server.getClientCapabilities()?.roots !== undefined;
}

/**
 * Wire roots support into a server. Does nothing when OPA_MCP_ALLOWED_PATHS
 * is set: that list is used as is and the client is never asked.
 */
export function attachClientRoots(server: McpServer, config: Config): void {
  if (config.allowedPaths.length > 0) return;
  if (config.ignoreClientRoots === true) {
    logger.info('OPA_MCP_NO_CLIENT_ROOTS is set; file tools are disabled');
    return;
  }

  const state: RootsState = {
    server: server.server,
    paths: [],
    settled: false,
    dirty: false,
    reason: '',
  };
  states.set(config, state);

  const previous = server.server.oninitialized;
  server.server.oninitialized = () => {
    previous?.();
    logger.info('client initialized', {
      client: server.server.getClientVersion(),
      roots: server.server.getClientCapabilities()?.roots ?? null,
    });
    if (clientSupportsRoots(state)) {
      void refresh(state, 'initialized');
    } else {
      logger.info(
        'client does not support roots and OPA_MCP_ALLOWED_PATHS is not set; file tools are disabled',
      );
    }
  };

  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    // A client that never declared roots cannot be asked for them.
    if (clientSupportsRoots(state)) void refresh(state, 'roots changed');
  });
}

/**
 * Wait for the client's roots when a request for them is outstanding, or has
 * not been made, or failed long enough ago to try again. Never throws, and
 * returns within ROOTS_WAIT_MS. A tool called straight after the handshake
 * would otherwise be refused before the first answer arrived.
 */
export async function awaitClientRoots(config: Config): Promise<void> {
  const state = states.get(config);
  if (state === undefined || !clientSupportsRoots(state)) return;
  if (state.inflight === undefined) {
    if (!state.settled) {
      // The client called a tool without sending `initialized` first.
      void refresh(state, 'first tool call');
    } else if (
      state.error !== undefined &&
      Date.now() - (state.failedAt ?? 0) >= ROOTS_RETRY_AFTER_MS
    ) {
      void refresh(state, 'retry after failure');
    }
  }
  const pending = state.inflight;
  if (pending === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((done) => {
    timer = setTimeout(done, ROOTS_WAIT_MS);
  });
  try {
    await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The directories file tools may use right now, and where they came from. */
export function allowedRoots(config: Config): {
  paths: string[];
  source: AllowedPathsSource;
  /** Set when the client supports roots but the latest request for them failed. */
  rootsError?: string;
  /** The client said it supports roots. Not looked up when the env list is in use. */
  clientRoots: boolean;
} {
  if (config.allowedPaths.length > 0) {
    return { paths: config.allowedPaths, source: 'env', clientRoots: false };
  }
  const state = states.get(config);
  if (state === undefined) return { paths: [], source: 'none', clientRoots: false };
  const clientRoots = clientSupportsRoots(state);
  if (state.inflight !== undefined) {
    // The list held now predates a change the client reported. Nothing is
    // allowed until the new one arrives.
    return {
      paths: [],
      source: 'none',
      clientRoots,
      rootsError: 'the client has not yet answered with its current roots',
    };
  }
  if (state.paths.length > 0) {
    return { paths: state.paths, source: 'client-roots', clientRoots };
  }
  return {
    paths: [],
    source: 'none',
    clientRoots,
    ...(state.error !== undefined ? { rootsError: state.error } : {}),
  };
}
