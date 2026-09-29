/**
 * Make the hand-owned root-cause workflow's enforced document contracts
 * visible to medium models, then advance the append-only Gstack wave.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireGildeCheckout } from './gilde-checkout.js';

const SOURCE_VERSION = '2.0.12';
const TARGET_VERSION = '2.0.13';
const RELEASED_AT = '2026-09-26T22:00:00Z';

type InvestigateOverlay = {
  workflow?: { phases?: Array<{ id?: unknown; prompt?: unknown }> };
  steps?: Record<string, Record<string, unknown>>;
};

const CONTRACTS: Record<string, string> = {
  reproduce: `Use this exact H2 skeleton in the output. Do not rename or remove a heading while revising another section:

## Symptom
## Minimal reproduction
## Expected
## Actual
## Evidence`,
  diagnose: `Use this exact H2 skeleton in the output. Do not rename or remove a heading while revising another section:

## Hypotheses
## Experiments
## Root cause
## Causal chain
## Blast radius`,
  'fix-and-verify': `The primary report is an artifact, not a workspace file: use \`write_artifact\` for \`{{workPath}}/reports/root-cause-investigation.md\`, never \`write_file\` for that path. Use this exact H2 skeleton in the report. Do not rename or remove a heading while revising another section:

## Root cause
## Fix
## Changed files
## Regression coverage
## Verification
## Rollback`,
};

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
  const phases = overlay.workflow?.phases;
  if (!Array.isArray(phases)) throw new Error('investigate overlay phases are missing');
  const steps = { ...(overlay.steps ?? {}) };
  overlay.steps = steps;
  for (const [id, contract] of Object.entries(CONTRACTS)) {
    const phase = phases.find((candidate) => candidate.id === id);
    if (!phase || typeof phase.prompt !== 'string') {
      throw new Error(`investigate overlay phase ${id} is missing or unexpected`);
    }
    if (phase.prompt.includes('Use this exact H2 skeleton')) {
      throw new Error(`investigate overlay phase ${id} already carries the visible contract`);
    }
    phase.prompt = `${phase.prompt.trim()}\n\n${contract}`;
    steps[id] = {
      ...(steps[id] ?? {}),
      prompt: phase.prompt,
    };
  }

  wave.version = TARGET_VERSION;
  wave.releasedAt = RELEASED_AT;
  console.log(`planned root-cause medium-model contract wave ${TARGET_VERSION}`);
  if (dryRun) return;
  await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
  await writeFile(wavePath, `${JSON.stringify(wave, null, 2)}\n`);
}

await main();
