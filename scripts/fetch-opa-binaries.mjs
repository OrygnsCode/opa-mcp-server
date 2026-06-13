#!/usr/bin/env node
/**
 * Fetch and verify the OPA binaries for the platform-specific packages.
 *
 * For each target package, downloads the asset from OPA's official GitHub
 * release, verifies its sha256 against the pinned value in
 * opa-binaries.json (fail closed on any mismatch), writes it into the
 * matching `packages/<dir>` as the bundled binary, and copies the OPA
 * LICENSE alongside it. The pinned hashes are OPA's own published
 * `<asset>.sha256` values.
 *
 * Binaries are never committed; this runs in CI before publishing the
 * platform packages, and locally for the dry-run.
 *
 * Usage:
 *   node scripts/fetch-opa-binaries.mjs            # all platforms
 *   node scripts/fetch-opa-binaries.mjs --current  # only this host's platform
 *   node scripts/fetch-opa-binaries.mjs --package @orygn/opa-mcp-win32-x64
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const manifest = JSON.parse(readFileSync(join(here, 'opa-binaries.json'), 'utf8'));

function currentPackageName() {
  const key = `${process.platform}-${process.arch}`;
  const match = Object.entries(manifest.packages).find(([, m]) => `${m.os}-${m.cpu}` === key);
  return match?.[0];
}

function resolveTargets() {
  const args = process.argv.slice(2);
  if (args.includes('--current')) {
    const name = currentPackageName();
    if (!name) {
      // An unsupported host simply has no bundle to fetch. Not an error.
      console.log(
        `No bundled OPA package for ${process.platform}-${process.arch}; nothing to fetch.`,
      );
      process.exit(0);
    }
    return [name];
  }
  const pkgIdx = args.indexOf('--package');
  if (pkgIdx !== -1) {
    const name = args[pkgIdx + 1];
    if (!name || !manifest.packages[name]) {
      console.error(
        `Unknown package "${name}". Known: ${Object.keys(manifest.packages).join(', ')}`,
      );
      process.exit(1);
    }
    return [name];
  }
  return Object.keys(manifest.packages);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchOne(name) {
  const m = manifest.packages[name];
  const destDir = join(repoRoot, m.dir);
  if (!existsSync(destDir)) throw new Error(`package directory missing: ${m.dir}`);
  const destBin = join(destDir, m.binary);
  const url = `${manifest.baseUrl}/v${manifest.opaVersion}/${m.asset}`;

  process.stdout.write(`  ${name}: ${m.asset} ... `);
  const buf = await download(url);
  const actual = sha256(buf);
  if (actual !== m.sha256) {
    throw new Error(`sha256 mismatch\n    expected ${m.sha256}\n    actual   ${actual}`);
  }
  writeFileSync(destBin, buf);
  chmodSync(destBin, 0o755);
  copyFileSync(join(repoRoot, manifest.license), join(destDir, 'LICENSE'));
  console.log(`ok (${(buf.length / 1048576).toFixed(1)}MB, sha256 verified)`);
}

async function main() {
  const licenseSrc = join(repoRoot, manifest.license);
  if (!existsSync(licenseSrc)) throw new Error(`LICENSE source missing: ${manifest.license}`);

  const names = resolveTargets();
  console.log(`Fetching OPA ${manifest.opaVersion} for: ${names.join(', ')}`);

  for (const name of names) {
    try {
      await fetchOne(name);
    } catch (e) {
      // Never leave a half-written or unverified binary behind.
      const m = manifest.packages[name];
      try {
        rmSync(join(repoRoot, m.dir, m.binary), { force: true });
      } catch {
        /* best effort */
      }
      console.error(`\nFAILED ${name}: ${e.message}`);
      process.exit(1);
    }
  }
  console.log('All requested binaries fetched and verified.');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
