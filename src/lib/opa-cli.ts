/**
 * Wrapper around the local `opa` binary.
 *
 * Tool implementations call into this module rather than spawning
 * subprocesses directly — keeps argv construction and error mapping
 * in one place.
 *
 * NOTE: Tool implementations are added incrementally. This module
 * defines the surface contract; the per-tool methods are filled in
 * during the build phase.
 */
import type { Config } from '../config.js';
import { runBinary, type SpawnResult } from './subprocess.js';

export class OpaCli {
  constructor(private readonly config: Config) {}

  /**
   * Verify the binary is present and report its version.
   * Returns null if the binary is unreachable.
   */
  async version(): Promise<string | null> {
    const result = await this.run(['version']);
    if (result.exitCode !== 0) return null;
    // OPA prints `Version: x.y.z` followed by other build info.
    const match = /Version:\s*(\S+)/i.exec(result.stdout);
    return match?.[1] ?? null;
  }

  /**
   * Low-level escape hatch. Most tools should call a typed method
   * (added in the build phase) rather than this directly.
   */
  async run(args: string[], stdin?: string): Promise<SpawnResult> {
    const opts: Parameters<typeof runBinary>[1] = {
      args,
      timeoutMs: this.config.subprocessTimeoutMs,
    };
    if (stdin !== undefined) opts.stdin = stdin;
    return await runBinary(this.config.opaBinary, opts);
  }
}
