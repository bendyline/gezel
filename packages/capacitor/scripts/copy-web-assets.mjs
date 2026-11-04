/**
 * Web assets the host app serves beside this package's code:
 * - Kokoro's pronunciation dictionaries. Speech plans phonemes in the host's
 *   WebView (src/speech.ts); they are the very files the desktop daemon reads,
 *   verified against the inference package's manifest before they are copied.
 * - SQLite's WebAssembly for the knowledge worker (dist/knowledge-worker.js).
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(packageRoot, '../inference/assets/kokoro');
const destination = path.join(packageRoot, 'kokoro-lexicon');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const sha256 = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
await rm(destination, { recursive: true, force: true });
await mkdir(destination);
const files = [
  ...Object.entries(manifest.files).map(([name, entry]) => [name, entry.sha256]),
  [manifest.license.file, manifest.license.sha256],
];
for (const [name, expected] of files) {
  if ((await sha256(path.join(source, name))) !== expected)
    throw new Error(`Kokoro dictionary integrity mismatch: ${name}`);
  await copyFile(path.join(source, name), path.join(destination, name));
}

const require = createRequire(import.meta.url);
const sqlite = path.dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json'));
await copyFile(
  path.join(sqlite, 'dist', 'sqlite3.wasm'),
  path.join(packageRoot, 'dist', 'sqlite3.wasm'),
);
