/**
 * Every Rego snippet this server ships to clients (the pattern library and the
 * style guide) must compile against the OPA we bundle. These are examples an
 * agent will copy verbatim, so a snippet that does not compile is worse than no
 * snippet at all.
 *
 * Three of them were broken before this test existed: two failed to parse and
 * one shadowed the `count` built-in with a rule of the same name.
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { OpaCli } from '../../src/lib/opa-cli.js';
import type { Config } from '../../src/config.js';

const config: Config = {
  opaUrl: 'http://localhost:8181',
  opaBinary: process.env['OPA_BINARY'] ?? 'opa',
  regalBinary: process.env['REGAL_BINARY'] ?? 'regal',
  conftestBinary: process.env['CONFTEST_BINARY'] ?? 'conftest',
  subprocessTimeoutMs: 30_000,
  httpTimeoutMs: 15_000,
  allowedPaths: [],
  logFile: join(tmpdir(), 'orygn-opa-mcp-shipped-rego.log'),
  logLevel: 'error',
  maxResponseBytes: 200_000,
};

const workDir = mkdtempSync(join(tmpdir(), 'orygn-shipped-rego-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** Collect every fenced ```rego block from the files we ship to clients. */
function shippedRegoBlocks(): Array<{ id: string; source: string }> {
  const dirs = ['src/resources', 'src/prompts'];
  const blocks: Array<{ id: string; source: string }> = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    } catch {
      continue;
    }
    for (const file of entries) {
      // Backticks are escaped inside the TypeScript template literals.
      const text = readFileSync(join(dir, file), 'utf8').split('\\`').join('`');
      const re = /```rego\n([\s\S]*?)```/g;
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = re.exec(text)) !== null) {
        const source = (m[1] ?? '').trim();
        if (!source.includes('package ')) continue;
        blocks.push({ id: `${file}#${++i}`, source });
      }
    }
  }
  return blocks;
}

describe('shipped Rego snippets compile against the bundled OPA', () => {
  const opa = new OpaCli(config);
  const blocks = shippedRegoBlocks();

  it('finds the snippets it is meant to guard', () => {
    // Guards the extractor itself: if the fences or file layout change, this
    // fails loudly rather than silently checking nothing.
    expect(blocks.length).toBeGreaterThanOrEqual(8);
  });

  it.each(blocks.map((b) => [b.id, b.source] as const))(
    'compiles %s',
    async (_id, source) => {
      const file = join(workDir, `snippet_${Math.abs(hash(source))}.rego`);
      writeFileSync(file, `${source}\n`, 'utf8');
      const result = await opa.check({ paths: [file] });
      expect(result.stderr.trim() + result.stdout.trim()).not.toMatch(/rego_\w*error/);
      expect(result.exitCode).toBe(0);
    },
    60_000,
  );
});

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
