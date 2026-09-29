/**
 * Align the root-cause eval's immutable fixtures with the craftbook's stated
 * permission to add or strengthen regression coverage, then advance the
 * append-only Gstack wave.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireGildeCheckout } from './gilde-checkout.js';

const SOURCE_VERSION = '2.0.13';
const TARGET_VERSION = '2.0.14';
const RELEASED_AT = '2026-09-26T23:00:00Z';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const checkout = requireGildeCheckout();
  const root = join(checkout.root, 'authoring', 'gstack');
  const wavePath = join(root, 'wave.json');
  const evalPath = join(root, 'evals', 'investigate.json');
  const wave = JSON.parse(await readFile(wavePath, 'utf8')) as Record<string, unknown>;
  if (wave.version !== SOURCE_VERSION) {
    throw new Error(`expected gstack wave ${SOURCE_VERSION}, found ${String(wave.version)}`);
  }

  const spec = JSON.parse(await readFile(evalPath, 'utf8')) as {
    success?: { unchangedFixtures?: unknown };
  };
  const unchanged = spec.success?.unchangedFixtures;
  if (
    !Array.isArray(unchanged) ||
    unchanged.join('\n') !== 'package.json\ntests/cart-total.test.mjs\nsource/incident.md'
  ) {
    throw new Error(
      'root-cause eval unchangedFixtures no longer matches the expected stale contract',
    );
  }
  spec.success!.unchangedFixtures = ['package.json', 'source/incident.md'];
  wave.version = TARGET_VERSION;
  wave.releasedAt = RELEASED_AT;

  console.log(`planned root-cause eval mutation-contract wave ${TARGET_VERSION}`);
  if (dryRun) return;
  await writeFile(evalPath, `${JSON.stringify(spec, null, 2)}\n`);
  await writeFile(wavePath, `${JSON.stringify(wave, null, 2)}\n`);
}

await main();
