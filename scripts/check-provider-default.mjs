#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `?? 'copilot'` as a provider fallback predates the Copilot SDK becoming an
// opt-in download: a fresh install has no way to run it, so the literal is a
// wrong answer, not a safe default. Service code resolves the install default
// through resolveDefaultProviderName (providers/default-provider.ts); UI code
// uses UI_FALLBACK_PROVIDER (ui/src/provider-default.ts) for the pre-config
// render. This guard keeps the literal from reappearing.
export const BANNED_PATTERN = /provider\s*\?\?\s*['"`]copilot['"`]/;

const ALLOWLISTED_FILES = new Set([
  // The one place the literal is a deliberate last resort, with the rationale.
  'packages/service/src/providers/default-provider.ts',
]);

const IGNORED_DIRS = new Set(['dist', 'node_modules', 'generated', '__snapshots__']);

async function walk(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
  }
}

export async function checkProviderDefaults({ rootDir = root } = {}) {
  const files = [];
  let packageDirs = [];
  try {
    packageDirs = (await readdir(join(rootDir, 'packages'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(rootDir, 'packages', entry.name, 'src'));
  } catch {
    return [];
  }
  for (const dir of packageDirs) await walk(dir, files);

  const failures = [];
  for (const path of files) {
    const key = relative(rootDir, path).replaceAll('\\', '/');
    if (ALLOWLISTED_FILES.has(key)) continue;
    const source = await readFile(path, 'utf8');
    if (!BANNED_PATTERN.test(source)) continue;
    const line = source.split(/\r?\n/).findIndex((text) => BANNED_PATTERN.test(text)) + 1;
    failures.push(
      `${key}:${line}: provider falls back to the 'copilot' literal; use resolveDefaultProviderName (service) or UI_FALLBACK_PROVIDER (ui)`,
    );
  }
  return failures.sort();
}

export async function main() {
  const failures = await checkProviderDefaults();
  if (failures.length > 0) {
    process.stderr.write(
      `Provider-default guard failed:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('Provider-default guard passed.\n');
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
