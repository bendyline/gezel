#!/usr/bin/env node

/**
 * Write the store-build marker that tells a packaged app which channel it was
 * built for.
 *
 * The marker is what makes "is this a store build?" a property of the ARTIFACT
 * rather than of the environment it launches in. Electron's own `process.mas` /
 * `process.windowsStore` corroborate it, but `process.windowsStore` is
 * unverified under a full-trust MSIX, so it cannot be the only signal — and an
 * environment variable must never be able to talk a store build out of its
 * restrictions.
 *
 * Staged into the app's resources via each store config's extraResources, so
 * it lands beside `licenses/` at `Contents/Resources/` (macOS) or
 * `resources/` (Windows) — exactly where src/store-build.ts looks.
 *
 *   node scripts/write-store-build-marker.mjs mac-app-store
 *   node scripts/write-store-build-marker.mjs microsoft-store
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORE_CHANNELS = Object.freeze(['mac-app-store', 'microsoft-store']);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(root, 'packages', 'app', 'dist', 'store-build');

async function main() {
  const channel = process.argv[2];
  if (!STORE_CHANNELS.includes(channel)) {
    console.error(`usage: node scripts/write-store-build-marker.mjs <${STORE_CHANNELS.join('|')}>`);
    process.exit(2);
  }
  await mkdir(OUT_DIR, { recursive: true });
  const marker = {
    channel,
    // Informational only. The app reads `channel` and nothing else, so adding
    // fields here can never change how a build behaves.
    builtAt: new Date().toISOString(),
  };
  const path = join(OUT_DIR, 'store-build.json');
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  console.log(`[store-build] wrote ${channel} marker to ${path}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
