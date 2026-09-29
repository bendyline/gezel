/**
 * Repair the two gstack eval sources that injected an undeclared workPath and
 * consequently graded artifact folders their generated books never write.
 * Also advances the append-only wave version so the normal importer can
 * publish regenerated craftbook+test pairs without touching 2.0.8.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireGildeCheckout } from './gilde-checkout.js';

const SOURCE_VERSION = '2.0.8';
const TARGET_VERSION = '2.0.9';
const RELEASED_AT = '2026-09-26T14:00:00Z';

interface RepairSpec {
  source: string;
  oldPrefix: string;
  newPrefix: string;
}

const REPAIRS: RepairSpec[] = [
  { source: 'plan-ceo-review', oldPrefix: 'tasks/eval/reviews/', newPrefix: 'reviews/' },
  { source: 'cso', oldPrefix: 'tasks/eval/security/', newPrefix: 'security/' },
];

function replaceStrings(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, from, to));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      replaceStrings(child, from, to),
    ]),
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const checkout = requireGildeCheckout();
  const root = join(checkout.root, 'authoring', 'gstack');
  const wavePath = join(root, 'wave.json');
  const wave = JSON.parse(await readFile(wavePath, 'utf8')) as Record<string, unknown>;
  if (wave.version !== SOURCE_VERSION) {
    throw new Error(`expected gstack wave ${SOURCE_VERSION}, found ${String(wave.version)}`);
  }

  const writes: Array<{ path: string; bytes: string }> = [];
  for (const repair of REPAIRS) {
    const path = join(root, 'evals', `${repair.source}.json`);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const params = (raw.setup as { craftbookParams?: unknown } | undefined)?.craftbookParams;
    if (JSON.stringify(params) !== JSON.stringify({ workPath: 'tasks/eval' })) {
      throw new Error(`${repair.source}: expected the stale workPath-only fixture parameter`);
    }
    const migrated = replaceStrings(raw, repair.oldPrefix, repair.newPrefix) as Record<
      string,
      unknown
    >;
    delete (migrated.setup as Record<string, unknown>).craftbookParams;
    const bytes = `${JSON.stringify(migrated, null, 2)}\n`;
    if (bytes.includes(repair.oldPrefix)) {
      throw new Error(`${repair.source}: old graded path survived migration`);
    }
    writes.push({ path, bytes });
  }
  wave.version = TARGET_VERSION;
  wave.releasedAt = RELEASED_AT;
  writes.push({ path: wavePath, bytes: `${JSON.stringify(wave, null, 2)}\n` });

  console.log(`planned ${REPAIRS.length} gstack eval path repairs and wave ${TARGET_VERSION}`);
  for (const repair of REPAIRS) {
    console.log(`  ${repair.source}: ${repair.oldPrefix} -> ${repair.newPrefix}`);
  }
  if (dryRun) return;
  for (const write of writes) await writeFile(write.path, write.bytes);
}

await main();
