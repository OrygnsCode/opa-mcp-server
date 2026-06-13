#!/usr/bin/env node
/**
 * End-to-end test of the bundled OPA for the CURRENT host platform.
 *
 * Proves the real install path without needing the packages on a registry:
 *   1. the binary for this host was fetched into its package dir
 *   2. `npm pack` produces a tarball that contains the binary
 *   3. installing that tarball into a clean project places the binary
 *   4. with `opa` removed from PATH, the resolver returns the bundled binary
 *   5. the bundled binary executes and reports the pinned OPA version
 *
 * Prereqs (the workflow runs these first):
 *   node scripts/fetch-opa-binaries.mjs --current   # fetch this host's binary
 *   npm run build                                    # produce dist/lib/resolve-binary.js
 *
 * Exits 0 on pass, 1 on failure. On an unsupported host (no package for this
 * platform/arch) it exits 0 with a note -- nothing to test.
 */
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const manifest = JSON.parse(readFileSync(join(here, 'opa-binaries.json'), 'utf8'));

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const key = `${process.platform}-${process.arch}`;
const entry = Object.entries(manifest.packages).find(([, m]) => `${m.os}-${m.cpu}` === key);
if (!entry) {
  console.log(`No bundled package for ${key}; nothing to test.`);
  process.exit(0);
}
const pkg = { name: entry[0], ...entry[1] };
console.log(`Testing bundle for ${key} (${pkg.name}, OPA ${manifest.opaVersion})`);

const pkgDir = join(repoRoot, pkg.dir);
if (!existsSync(join(pkgDir, pkg.binary))) {
  fail(`binary not fetched: ${pkg.dir}/${pkg.binary} (run fetch --current first)`);
}
const builtResolver = join(repoRoot, 'dist', 'lib', 'resolve-binary.js');
if (!existsSync(builtResolver))
  fail('dist/lib/resolve-binary.js missing (run npm run build first)');

const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const tarballName = `${pkg.name.replace('@', '').replace('/', '-')}-${version}.tgz`;

const work = mkdtempSync(join(tmpdir(), 'opa-bundle-test-'));
try {
  // 2. pack the platform package.
  execSync(`npm pack --pack-destination "${work}"`, { cwd: pkgDir, stdio: 'ignore' });
  const tarball = join(work, tarballName);
  if (!existsSync(tarball)) fail(`npm pack did not produce ${tarballName}`);
  console.log('  pack ok');

  // 3. install into a clean project. The binary appearing in node_modules
  //    proves npm pack included it (install extracts what pack wrote).
  execSync('npm init -y', { cwd: work, stdio: 'ignore' });
  execSync(`npm install "${tarball}"`, { cwd: work, stdio: 'ignore' });
  if (!existsSync(join(work, 'node_modules', pkg.name, pkg.binary))) {
    fail(`install did not place ${pkg.name}/${pkg.binary} (pack may have omitted it)`);
  }
  console.log('  pack + install ok: binary present in node_modules');

  // 4. + 5. resolver finds the bundle with no opa on PATH, and it runs.
  const resolverCopy = join(work, 'resolve-binary.mjs');
  cpSync(builtResolver, resolverCopy);
  const { resolveOpaBinary, binOnPath } = await import(pathToFileURL(resolverCopy).href);

  process.env.PATH = ''; // simulate: no opa anywhere on PATH
  if (binOnPath('opa') !== false) fail('binOnPath should be false with empty PATH');
  const resolved = resolveOpaBinary('opa');
  console.log('  resolveOpaBinary("opa") ->', resolved);
  const dirName = pkg.name.replace('@orygn/', '');
  if (!resolved.endsWith(pkg.binary) || !resolved.includes(dirName)) {
    fail(`resolver did not return the bundled binary (got ${resolved})`);
  }
  const ver = execFileSync(resolved, ['version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
  console.log('  bundled binary reports:', ver);
  if (!ver.includes(manifest.opaVersion)) fail(`expected OPA ${manifest.opaVersion}, got: ${ver}`);

  console.log(`PASS: ${pkg.name} resolves and runs OPA ${manifest.opaVersion}.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
