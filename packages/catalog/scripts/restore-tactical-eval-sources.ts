/**
 * Recover tactical eval authoring sources from the last good released
 * sidecars after an older `tasks/eval` fixture was found in authoring.
 * Craftbook payloads remain immutable; a subsequent wave bump publishes the
 * recovered sidecars as new append-only releases.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCraftbookTestSpec } from '@bendyline/gezel';
import { TacticalWaveConfigSchema } from '../src/tactical-workflows.js';
import { requireGildeCheckout } from './gilde-checkout.js';

function previousPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[3]) === 0) throw new Error(`cannot decrement ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) - 1}`;
}

function parseSpec(id: string, bytes: string) {
  const parsed = parseCraftbookTestSpec(JSON.parse(bytes) as unknown);
  if (!parsed.ok) throw new Error(`${id}: invalid eval sidecar:\n${parsed.errors.join('\n')}`);
  return parsed.spec;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const gilde = requireGildeCheckout();
  const authoringRoot = join(gilde.root, 'authoring', 'tactical');
  const wave = TacticalWaveConfigSchema.parse(
    JSON.parse(await readFile(join(authoringRoot, 'wave.json'), 'utf8')) as unknown,
  );

  for (const book of wave.books) {
    const evalPath = join(authoringRoot, 'evals', `${book.id}.json`);
    const currentSpec = parseSpec(book.id, await readFile(evalPath, 'utf8'));
    if (currentSpec.setup.craftbookParams?.workPath !== 'tasks/eval') {
      throw new Error(`${book.id}: authoring source no longer has the expected stale workPath`);
    }

    const goodVersion = previousPatch(book.version);
    const goodPath = join(
      gilde.dataDir,
      'craftbook-templates',
      book.id.slice(0, 2),
      book.id,
      'versions',
      goodVersion,
      'test.json',
    );
    const goodSpec = parseSpec(book.id, await readFile(goodPath, 'utf8'));
    if (goodSpec.setup.craftbookParams?.workPath !== undefined) {
      throw new Error(`${book.id}@${goodVersion}: expected runtime-owned workPath to be omitted`);
    }
    const bytes = `${JSON.stringify(goodSpec, null, 2)}\n`;
    console.log(`${dryRun ? 'would recover' : 'recovering'} ${book.id} from ${goodVersion}`);
    if (!dryRun) await writeFile(evalPath, bytes);
  }
}

await main();
