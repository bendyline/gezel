#!/usr/bin/env node
/**
 * Prove a built sqlite-vec extension works the way the service uses it
 * (packages/service/src/index-store/sqlite-driver.ts): loaded into
 * node:sqlite, it reports the pinned version and source commit, a vec0 table
 * answers a nearest-neighbor query in cosine order, and Hamming distance
 * counts all 64 bits of a word, the case build.ps1 patches for MSVC on ARM.
 *
 * A library has no `--help` to run, so this replaces smoke-native-help.mjs
 * for it. Node must match the extension's architecture: an x64 Node cannot
 * load an ARM64 DLL, and that failure names the process architecture.
 *
 * usage: node scripts/smoke-sqlite-vec.mjs <vec0.dll|.so|.dylib>
 *          [--version-file native/engines/sqlite-vec/VERSION]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  let extension;
  let versionFile = resolve(repoRoot, 'native', 'engines', 'sqlite-vec', 'VERSION');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--version-file') versionFile = resolve(argv[++index]);
    else if (!extension) extension = resolve(argv[index]);
    else throw new Error(`unexpected argument: ${argv[index]}`);
  }
  if (!extension) {
    throw new Error('usage: smoke-sqlite-vec.mjs <extension> [--version-file <VERSION>]');
  }
  return { extension, versionFile };
}

function readPin(path) {
  const pin = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^([a-z0-9_]+)=(.+)$/);
    if (match) pin[match[1]] = match[2].trim();
  }
  if (!pin.tag || !pin.commit) throw new Error(`${path} must contain tag= and commit=`);
  return pin;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const { extension, versionFile } = parseArgs(process.argv.slice(2));
  const pin = readPin(versionFile);
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  try {
    try {
      db.loadExtension(extension);
    } catch (error) {
      throw new Error(
        `could not load ${extension} into Node ${process.version} (${process.platform}-${process.arch}): ${error.message}`,
      );
    }

    const version = db.prepare('SELECT vec_version() AS v').get().v;
    check(version === pin.tag, `vec_version() is ${version}, VERSION pins ${pin.tag}`);
    const debug = db.prepare('SELECT vec_debug() AS d').get().d;
    check(
      debug.includes(`Commit: ${pin.commit}`),
      `vec_debug() does not report commit ${pin.commit}:\n${debug}`,
    );

    // The service's own query shape: cosine vec0 table, MATCH + ORDER BY
    // distance. A REAL rowid is refused by vec0, hence the BigInts.
    db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[3] distance_metric=cosine)');
    const insert = db.prepare('INSERT INTO v (rowid, embedding) VALUES (?, ?)');
    insert.run(1n, '[1, 0, 0]');
    insert.run(2n, '[0, 1, 0]');
    insert.run(3n, '[0.9, 0.1, 0]');
    const rows = db
      .prepare('SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 3')
      .all('[1, 0, 0]');
    const order = rows.map((row) => Number(row.rowid));
    check(order.join(',') === '1,3,2', `nearest-neighbor order is ${order}, expected 1,3,2`);
    check(Math.abs(rows[0].distance) < 1e-6, `self distance is ${rows[0].distance}, expected 0`);

    const hamming = db
      .prepare(
        "SELECT vec_distance_hamming(vec_bit(X'FFFFFFFFFFFFFFFF'), vec_bit(X'0000000000000000')) AS d",
      )
      .get().d;
    check(hamming === 64, `Hamming distance over one 64-bit word is ${hamming}, expected 64`);

    console.log(`[smoke] ${extension}`);
    console.log(
      `[smoke] ${version} (${pin.commit.slice(0, 12)}) loaded into Node ${process.version} ${process.arch}`,
    );
    console.log('[smoke] cosine nearest-neighbor order and 64-bit Hamming distance correct');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`::error::sqlite extension smoke test failed: ${error.message}`);
  process.exitCode = 1;
}
