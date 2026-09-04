#!/usr/bin/env node

/**
 * Stage the batteries-included model pack into packages/app/dist/model-pack/.
 *
 * Only the app-store lanes run this. The Developer ID / NSIS / Linux builds
 * deliberately ship no weights: those users download the models they choose,
 * and adding ~3 GB to a direct download we pay to serve would be the wrong
 * trade. A store package is served by the store's own CDN, which is what makes
 * "complete on first boot" affordable there and only there.
 *
 * Modeled on packages/app/scripts/fetch-node.mjs: pinned URL + sha256, cached
 * between runs, verified before staging, hard failure on a placeholder pin.
 *
 *   node scripts/stage-model-pack.mjs            stage everything
 *   node scripts/stage-model-pack.mjs --check    validate the manifest only
 *
 *   GEZEL_MODEL_PACK_SKIP=1   skip entirely (dev iteration; the store lanes
 *                             must never set it — the package would ship
 *                             advertising models that are not inside it)
 *   GEZEL_MODEL_PACK_CACHE    override the download cache directory
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(root, 'packages', 'app', 'model-pack.json');
const DIST = join(root, 'packages', 'app', 'dist', 'model-pack');
const PLACEHOLDER_SHA = '0'.repeat(64);

export function validateManifest(manifest) {
  const problems = [];
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    problems.push('model-pack.json declares no entries');
    return problems;
  }
  const seenIds = new Set();
  const seenPaths = new Set();
  for (const entry of manifest.entries) {
    const label = entry.id ?? '<unnamed>';
    if (!entry.id) problems.push('an entry has no id');
    else if (seenIds.has(entry.id)) problems.push(`duplicate entry id ${entry.id}`);
    else seenIds.add(entry.id);

    if (!entry.targetPath) {
      problems.push(`${label} has no targetPath`);
    } else {
      if (seenPaths.has(entry.targetPath)) {
        problems.push(`two entries stage to ${entry.targetPath}`);
      }
      seenPaths.add(entry.targetPath);
      // A staged path escaping the pack directory would write into the app
      // tree — or anywhere — from a data file.
      if (entry.targetPath.startsWith('/') || entry.targetPath.includes('..')) {
        problems.push(`${label} targetPath must be a relative path inside the pack`);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
      problems.push(`${label} has no valid sha256`);
    }
  }
  return problems;
}

/** Entries that are declared but not yet pinned to real bytes. */
export function unpinnedEntries(manifest) {
  return manifest.entries.filter((e) => !e.url || e.sha256 === PLACEHOLDER_SHA);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`[model-pack] ${url} returned ${res.status}`);
  }
  const tmp = `${destPath}.download`;
  await mkdir(dirname(destPath), { recursive: true });
  const { createWriteStream } = await import('node:fs');
  await pipeline(res.body, createWriteStream(tmp));
  await rename(tmp, destPath);
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    console.error(`[model-pack] manifest is invalid:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  if (checkOnly) {
    const pending = unpinnedEntries(manifest);
    console.log(
      `[model-pack] manifest valid: ${manifest.entries.length} entries, ` +
        `${pending.length} awaiting a real pin`,
    );
    return;
  }

  if (process.env.GEZEL_MODEL_PACK_SKIP === '1') {
    console.log('[model-pack] GEZEL_MODEL_PACK_SKIP=1 — skipping the pack.');
    return;
  }

  const pending = unpinnedEntries(manifest);
  if (pending.length > 0) {
    // Deliberately fatal, matching fetch-node.mjs's placeholder rule. A store
    // package that shipped an unpinned or missing weight would be signed,
    // reviewed, and distributed before anyone noticed — and the fix would be
    // another review cycle.
    const list = pending.map((e) => `  - ${e.id} (${e.targetPath})`).join('\n');
    const remedy =
      'pin them in packages/app/model-pack.json, or set GEZEL_MODEL_PACK_SKIP=1 to build without the pack (never in a store lane).';
    console.error(
      `[model-pack] these entries have no pinned url+sha256 yet:\n${list}\n[model-pack] ${remedy}`,
    );
    process.exit(1);
  }

  const cacheDir =
    process.env.GEZEL_MODEL_PACK_CACHE ?? join(homedir(), '.cache', 'gezel-model-pack');
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  let staged = 0;
  for (const entry of manifest.entries) {
    const cached = join(cacheDir, `${entry.sha256}.bin`);
    if (!(await exists(cached))) {
      console.log(`[model-pack] downloading ${entry.id} …`);
      await download(entry.url, cached);
    }
    const actual = await sha256File(cached);
    if (actual !== entry.sha256) {
      // Remove it so a corrupted cache entry cannot poison every later build
      // on this machine.
      await rm(cached, { force: true });
      throw new Error(
        `[model-pack] sha256 mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}`,
      );
    }
    const dest = join(DIST, entry.targetPath);
    await mkdir(dirname(dest), { recursive: true });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(cached, dest);
    staged += 1;
    console.log(`[model-pack] staged ${entry.targetPath} (sha256 verified)`);
  }

  // A manifest beside the payload so the daemon can tell what it was given
  // without hashing multi-gigabyte files at boot.
  await writeFile(
    join(DIST, 'pack.json'),
    `${JSON.stringify(
      {
        packVersion: manifest.packVersion,
        entries: manifest.entries.map(({ id, kind, targetPath, sha256 }) => ({
          id,
          kind,
          targetPath,
          sha256,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`[model-pack] ✓ staged ${staged} entries into ${DIST}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
