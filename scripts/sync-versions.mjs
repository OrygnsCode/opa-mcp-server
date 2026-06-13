#!/usr/bin/env node
/**
 * Keep the platform packages and the main package's optionalDependencies in
 * lockstep with the main package version. Run as part of the version bump so
 * a release never points at a platform-package version that was never
 * published. Writes plain 2-space JSON; run `prettier --write` afterwards
 * (the release flow already formats).
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
const version = main.version;

const names = Object.keys(manifest.packages);
const optionalDependencies = { ...(main.optionalDependencies ?? {}) };

for (const name of names) {
  const pkgPath = join(repoRoot, manifest.packages[name].dir, 'package.json');
  const pkg = readJson(pkgPath);
  pkg.version = version;
  writeJson(pkgPath, pkg);
  optionalDependencies[name] = version; // exact pin, in lockstep with main
}

main.optionalDependencies = optionalDependencies;
writeJson(mainPath, main);

console.log(`Synced ${names.length} platform packages + optionalDependencies to ${version}.`);
