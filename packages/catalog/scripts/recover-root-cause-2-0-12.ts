/**
 * Recover the local, never-validated 2.0.12 draft after its frozen step patch
 * replaced the generated artifact-write suffix. Exact guards keep this from
 * becoming a general-purpose immutable-release editor.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireGildeCheckout } from './gilde-checkout.js';

const VERSION = '2.0.12';
const HANDOFF =
  "Observable handoff: write the completed result to `{{workPath}}/reports/root-cause-investigation.md` in the project's artifacts drawer with `write_artifact`. Do not merely describe what the file would contain. Re-read it with `read_artifact` before finishing this phase and repair any incomplete sections.";

type PromptDocument = Record<string, unknown> & {
  steps?: Array<Record<string, unknown>>;
};

type InvestigateOverlay = Record<string, unknown> & {
  workflow?: { phases?: Array<Record<string, unknown>> };
  steps?: Record<string, Record<string, unknown>>;
};

function patchPrompt(doc: PromptDocument, label: string): void {
  const step = doc.steps?.find(
    (candidate: Record<string, unknown>) => candidate.id === 'fix-and-verify',
  );
  if (!step || typeof step.prompt !== 'string' || !step.prompt.includes('run_package_script')) {
    throw new Error(`${label}: expected fix-and-verify execution guidance`);
  }
  if (step.prompt.includes('write_artifact')) {
    throw new Error(`${label}: artifact handoff is already present`);
  }
  step.prompt = `${step.prompt.trim()}\n\n${HANDOFF}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const checkout = requireGildeCheckout();
  const wavePath = join(checkout.root, 'authoring', 'gstack', 'wave.json');
  const overlayPath = join(checkout.root, 'authoring', 'gstack', 'overlays', 'investigate.json');
  const payloadPath = join(
    checkout.dataDir,
    'craftbook-templates',
    'ro',
    'root-cause-investigation',
    'versions',
    VERSION,
    'craftbook.json',
  );
  const wave = JSON.parse(await readFile(wavePath, 'utf8')) as Record<string, unknown>;
  if (wave.version !== VERSION) {
    throw new Error(`expected unreleased gstack wave ${VERSION}, found ${String(wave.version)}`);
  }
  const overlay = JSON.parse(await readFile(overlayPath, 'utf8')) as InvestigateOverlay;
  const phase = overlay.workflow?.phases?.find(
    (candidate: Record<string, unknown>) => candidate.id === 'fix-and-verify',
  ) as Record<string, unknown> | undefined;
  const overlayStep = overlay.steps?.['fix-and-verify'] as Record<string, unknown> | undefined;
  if (!phase || typeof phase.prompt !== 'string' || !overlayStep) {
    throw new Error('investigate authoring source is missing the expected frozen step patch');
  }
  if (phase.prompt.includes('write_artifact') || typeof overlayStep.prompt !== 'string') {
    throw new Error('investigate authoring source no longer matches the invalid draft shape');
  }
  phase.prompt = `${phase.prompt.trim()}\n\n${HANDOFF}`;
  overlayStep.prompt = phase.prompt;

  const payload = JSON.parse(await readFile(payloadPath, 'utf8')) as PromptDocument;
  if (payload.version !== VERSION)
    throw new Error(`unexpected payload version ${String(payload.version)}`);
  patchPrompt(payload, 'root-cause payload');

  console.log(`planned recovery of never-validated root-cause ${VERSION} draft`);
  if (dryRun) return;
  await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
  await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
}

await main();
