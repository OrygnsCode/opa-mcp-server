/**
 * Wrapper around the optional `regal` binary (Rego linter, by Styra).
 *
 * Regal is OPTIONAL — only the `rego_lint` tool requires it. Other tools
 * work without Regal installed. If absent, `rego_lint` should return a
 * structured `REGAL_NOT_FOUND` error with an install hint.
 */
import type { Config } from '../config.js';
import { runBinary, type SpawnResult } from './subprocess.js';

export class RegalCli {
  constructor(private readonly config: Config) {}

  async version(): Promise<string | null> {
    const result = await this.run(['version']);
    if (result.exitCode !== 0) return null;
    const match = /Version:\s*(\S+)/i.exec(result.stdout) ?? /v?(\d+\.\d+\.\d+\S*)/i.exec(result.stdout);
    return match?.[1] ?? null;
  }

  async run(args: string[], stdin?: string): Promise<SpawnResult> {
    const opts: Parameters<typeof runBinary>[1] = {
      args,
      timeoutMs: this.config.subprocessTimeoutMs,
    };
    if (stdin !== undefined) opts.stdin = stdin;
    return await runBinary(this.config.regalBinary, opts);
  }
}
