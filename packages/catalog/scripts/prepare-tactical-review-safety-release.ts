/**
 * Advance the tactical authoring wave for the bounded-review compiler change.
 * The ordinary generator remains responsible for validating sources and
 * writing the append-only craftbook versions after this preflighted bump.
 */

import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TacticalWaveConfigSchema } from '../src/tactical-workflows.js';
import { requireGildeCheckout } from './gilde-checkout.js';

const RELEASED_AT = '2026-09-27T04:00:00Z';

function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`invalid semantic version ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const gilde = requireGildeCheckout();
  const wavePath = join(gilde.root, 'authoring', 'tactical', 'wave.json');
  const wave = TacticalWaveConfigSchema.parse(
    JSON.parse(await readFile(wavePath, 'utf8')) as unknown,
  );
  const books = [];
  for (const book of wave.books) {
    const versionsRoot = join(
      gilde.dataDir,
      'craftbook-templates',
      book.id.slice(0, 2),
      book.id,
      'versions',
    );
    const versions = (await readdir(versionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersions);
    const latest = versions.at(-1);
    if (!latest) throw new Error(`${book.id}: no released versions found in ${versionsRoot}`);
    books.push({ ...book, version: bumpPatch(latest), releasedAt: RELEASED_AT });
  }
  const next = { ...wave, books };

  for (const book of next.books) {
    const versionDir = join(
      gilde.dataDir,
      'craftbook-templates',
      book.id.slice(0, 2),
      book.id,
      'versions',
      book.version,
    );
    try {
      await access(versionDir);
      throw new Error(`${book.id}: refusing to target existing ${versionDir}`);
    } catch (error) {
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error;
    }
    console.log(`${dryRun ? 'would bump' : 'bumping'} ${book.id} to ${book.version}`);
  }

  if (!dryRun) await writeFile(wavePath, `${JSON.stringify(next, null, 2)}\n`);
}

await main();
