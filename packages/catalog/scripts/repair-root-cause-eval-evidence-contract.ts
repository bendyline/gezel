/**
 * Accept ordinary successful-exit wording in the root-cause eval, then
 * advance the append-only Gstack wave. The previous regex rejected the
 * accurate phrase "Exit code: 0" and could turn correct medium-model work
 * into a stale repair loop.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireGildeCheckout } from './gilde-checkout.js';

const SOURCE_VERSION = '2.0.15';
const TARGET_VERSION = '2.0.16';
const RELEASED_AT = '2026-09-27T01:00:00Z';
const OLD_PATTERN =
  '(?:npm\\s+(?:run\\s+)?test|node\\s+(?:--test\\s+)?tests/cart-total\\.test\\.mjs)[\\s\\S]*(?:pass|2\\s+tests?|exit(?:ed)?\\s+0)';
const NEW_PATTERN =
  '(?:npm\\s+(?:run\\s+)?test|node\\s+(?:--test\\s+)?tests/cart-total\\.test\\.mjs)[\\s\\S]*(?:pass(?:ed)?|2\\s+tests?(?:\\s+passed)?|exit(?:ed)?(?:\\s+code)?\\s*:?\\s*0)';

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
    success?: {
      deliverables?: Array<{ checks?: Array<{ label?: unknown; pattern?: unknown }> }>;
    };
  };
  const check = spec.success?.deliverables
    ?.flatMap((deliverable) => deliverable.checks ?? [])
    .find((candidate) => candidate.label === 'verification command and result');
  if (!check || check.pattern !== OLD_PATTERN) {
    throw new Error('root-cause eval verification check no longer matches the expected contract');
  }
  check.pattern = NEW_PATTERN;
  wave.version = TARGET_VERSION;
  wave.releasedAt = RELEASED_AT;

  console.log(`planned root-cause eval evidence-contract wave ${TARGET_VERSION}`);
  if (dryRun) return;
  await writeFile(evalPath, `${JSON.stringify(spec, null, 2)}\n`);
  await writeFile(wavePath, `${JSON.stringify(wave, null, 2)}\n`);
}

await main();
