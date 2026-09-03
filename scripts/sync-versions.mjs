#!/usr/bin/env node
/**
 * Keep the main package's optionalDependencies pointing at the exact platform
 * package versions that exist, so a release never resolves to a version that
 * was never published.
 *
 * A platform package contains one thing: the OPA binary. Its version therefore
 * tracks the bundled OPA version, not the server version. Releasing a server
 * fix does not change those packages, and republishing five byte-identical
 * tarballs under a new number says a change happened when none did.
 *
 * So the version of a platform package moves only when the binary it carries
 * moves. `opaVersion` in each platform package.json records which binary is in
 * there, and the manifest is the source of truth for what it should be.
 *
 * Writes plain 2-space JSON; run `prettier --write` afterwards (the release
 * flow already formats).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const manifest = JSON.parse(readFileSync(join(here, 'opa-binaries.json'), 'utf8'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

const mainPath = join(repoRoot, 'package.json');
const main = readJson(mainPath);
const releaseVersion = main.version;
const bundledOpa = manifest.opaVersion;

const names = Object.keys(manifest.packages);
const optionalDependencies = { ...(main.optionalDependencies ?? {}) };

const bumped = [];
const held = [];

for (const name of names) {
  const pkgPath = join(repoRoot, manifest.packages[name].dir, 'package.json');
  const pkg = readJson(pkgPath);

  if (pkg.opaVersion === undefined) {
    // First run against a package that predates this field. It already holds
    // the manifest's binary and is published at its current version, so record
    // what is in there without inventing a version change.
    pkg.opaVersion = bundledOpa;
    writeJson(pkgPath, pkg);
    held.push(`${name}@${pkg.version}`);
  } else if (pkg.opaVersion !== bundledOpa) {
    // The binary changed, so the package contents changed. Take the release
    // version, which keeps platform versions readable against the server line.
    pkg.version = releaseVersion;
    pkg.opaVersion = bundledOpa;
    writeJson(pkgPath, pkg);
    bumped.push(`${name}@${releaseVersion}`);
  } else {
    held.push(`${name}@${pkg.version}`);
  }

  // Always an exact pin, and always at the version the package actually has.
  optionalDependencies[name] = pkg.version;
}

main.optionalDependencies = optionalDependencies;
writeJson(mainPath, main);

if (bumped.length) {
  console.log(
    `Bundled OPA is ${bundledOpa}; bumped ${bumped.length} platform package(s) to ${releaseVersion}.`,
  );
}
if (held.length) {
  console.log(`Unchanged, left as published: ${held.join(', ')}.`);
}
console.log(`optionalDependencies pinned to the current platform versions.`);
