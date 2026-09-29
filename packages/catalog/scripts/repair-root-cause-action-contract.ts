/**
 * Make the root-cause mutation step name its workspace inputs and require an
 * immediate edit once the evidence supports one, then advance the append-only
 * Gstack wave.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireGildeCheckout } from './gilde-checkout.js';

const SOURCE_VERSION = '2.0.14';
const TARGET_VERSION = '2.0.15';
const RELEASED_AT = '2026-09-27T00:00:00Z';
const OLD_OPENING =
  'Read both investigation files. Implement the smallest maintainable change that breaks the documented causal chain. Add or strengthen a regression test that fails on the old behavior and passes with the fix.';
const NEW_OPENING =
  'Start by reading these exact workspace files: `investigations/reproduction.md` and `investigations/root-cause-analysis.md`. They are workspace files, not artifacts; do not search the artifacts drawer for them. If either file is missing, stop without editing and record the missing evidence. Once both are read and the evidence supports a change, immediately call the appropriate workspace edit tool and make the smallest maintainable change that breaks the documented causal chain. Do not narrate a plan or repeatedly reconsider equivalent fixes instead of acting. Add or strengthen a regression test that fails on the old behavior and passes with the fix. If an existing test already demonstrates that regression, preserve it; do not rewrite it merely to create churn.';

type InvestigateOverlay = {
  workflow?: { phases?: Array<{ id?: unknown; prompt?: unknown }> };
  steps?: Record<string, Record<string, unknown>>;
};

function updatePrompt(prompt: unknown, location: string): string {
  if (typeof prompt !== 'string' || !prompt.startsWith(OLD_OPENING)) {
    throw new Error(`${location} no longer matches the expected root-cause action contract`);
  }
  return `${NEW_OPENING}${prompt.slice(OLD_OPENING.length)}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const checkout = requireGildeCheckout();
  const root = join(checkout.root, 'authoring', 'gstack');
  const wavePath = join(root, 'wave.json');
  const overlayPath = join(root, 'overlays', 'investigate.json');
  const wave = JSON.parse(await readFile(wavePath, 'utf8')) as Record<string, unknown>;
  if (wave.version !== SOURCE_VERSION) {
    throw new Error(`expected gstack wave ${SOURCE_VERSION}, found ${String(wave.version)}`);
  }

  const overlay = JSON.parse(await readFile(overlayPath, 'utf8')) as InvestigateOverlay;
  const phase = overlay.workflow?.phases?.find((candidate) => candidate.id === 'fix-and-verify');
  if (!phase) throw new Error('investigate overlay fix-and-verify phase is missing');
  const step = overlay.steps?.['fix-and-verify'];
  if (!step) throw new Error('investigate overlay fix-and-verify step override is missing');
  phase.prompt = updatePrompt(phase.prompt, 'workflow phase prompt');
  step.prompt = updatePrompt(step.prompt, 'step override prompt');

  wave.version = TARGET_VERSION;
  wave.releasedAt = RELEASED_AT;
  console.log(`planned root-cause action-contract wave ${TARGET_VERSION}`);
  if (dryRun) return;
  await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
  await writeFile(wavePath, `${JSON.stringify(wave, null, 2)}\n`);
}

await main();
