/**
 * Finding `.rego` modules under the paths a caller gave, the way `opa` loads
 * them: a file is taken as is, a directory is walked recursively. Symbolic
 * links are not followed, so a walk stays inside the validated root.
 */
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

export async function findRegoFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findRegoFiles(full)));
    } else if (entry.isFile() && extname(entry.name) === '.rego') {
      files.push(full);
    }
  }
  return files;
}

/** Every `.rego` module named by `paths`, directories expanded. */
export async function expandRegoPaths(paths: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    const info = await stat(path);
    if (info.isDirectory()) files.push(...(await findRegoFiles(path)));
    else if (extname(path) === '.rego') files.push(path);
  }
  return files;
}

/**
 * The package a module declares, read from its text without parsing, as a
 * `data.`-rooted dotted path; undefined when the declaration is not a plain
 * dotted name. Lets a caller skip parsing modules that cannot hold a rule.
 */
export function declaredPackage(source: string): string | undefined {
  const m = /^\s*package\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*(?:#.*)?$/m.exec(source);
  return m ? `data.${m[1]}` : undefined;
}
