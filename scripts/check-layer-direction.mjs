#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Cross-package layering is machine-enforced by workspace dependencies, but
// inside packages/service it was convention only — and the convention broke in
// the direction that matters most: fs/store.ts (storage, the lowest layer)
// grew runtime imports from chat/ (orchestration). Those helpers now live in
// src/references/; this guard keeps the breach from reappearing. Type-only
// imports are allowed — they are erased at runtime and a storage type
// annotation referencing an orchestration interface is coupling of a much
// weaker kind than executing its code.
export const LAYER_RULES = [
  {
    sourceDir: 'packages/service/src/fs',
    forbidden: ['chat', 'http', 'providers'],
    hint: 'storage must not execute orchestration code; move shared helpers to a leaf module (e.g. src/references/)',
  },
];

const IMPORT_PATTERN = /(?:^|\n)\s*(import|export)\s+([^;]*?)\bfrom\s+['"]([^'"]+)['"]/g;

export function findForbiddenImports(source, forbidden) {
  const failures = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const [, , clause, specifier] = match;
    const target = forbidden.find(
      (dir) => specifier === `../${dir}` || specifier.startsWith(`../${dir}/`),
    );
    if (!target) continue;
    if (/^type\s/.test(clause.trim())) continue;
    const line = source.slice(0, match.index + match[0].indexOf('from')).split('\n').length;
    failures.push({ specifier, line });
  }
  return failures;
}

async function listSourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listSourceFiles(path)));
    else if (/\.[cm]?ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

export async function checkLayerDirection({ rootDir = root, rules = LAYER_RULES } = {}) {
  const failures = [];
  for (const rule of rules) {
    const files = await listSourceFiles(join(rootDir, rule.sourceDir));
    for (const path of files) {
      const key = relative(rootDir, path).replaceAll('\\', '/');
      if (/\.test\.[cm]?ts$/.test(key)) continue;
      const source = await readFile(path, 'utf8');
      for (const failure of findForbiddenImports(source, rule.forbidden)) {
        failures.push(
          `${key}:${failure.line}: runtime import from '${failure.specifier}' breaks layer direction (${rule.hint})`,
        );
      }
    }
  }
  return failures.sort();
}

export async function main() {
  const failures = await checkLayerDirection();
  if (failures.length > 0) {
    process.stderr.write(
      `Layer-direction guard failed:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('Layer-direction guard passed.\n');
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
