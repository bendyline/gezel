#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// These classes encode one durable policy and must have one canonical
// production implementation. Add entries when another single-owner service
// becomes important enough that a parallel implementation would be dangerous.
const invariants = [
  {
    symbol: 'ReportActionManager',
    canonical: 'packages/service/src/report-actions/report-action-manager.ts',
    searchRoot: 'packages/service/src',
  },
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (
      /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

const failures = [];
for (const invariant of invariants) {
  const files = await walk(resolve(root, invariant.searchRoot));
  const declaration = new RegExp(`\\b(?:export\\s+)?class\\s+${invariant.symbol}\\b`);
  const owners = [];
  for (const file of files) {
    if (declaration.test(await readFile(file, 'utf8'))) {
      owners.push(relative(root, file).replaceAll('\\', '/'));
    }
  }

  if (owners.length !== 1 || owners[0] !== invariant.canonical) {
    failures.push(
      `${invariant.symbol}: expected only ${invariant.canonical}; found ${owners.length > 0 ? owners.join(', ') : 'no implementation'}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Single-owner source guard failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('Single-owner source guard passed.\n');
}
