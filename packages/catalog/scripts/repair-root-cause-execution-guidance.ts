/**
 * Add portable, receipt-backed execution guidance to the hand-owned
 * root-cause book and advance the append-only Gstack wave.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireGildeCheckout } from './gilde-checkout.js';

const SOURCE_VERSION = '2.0.11';
const TARGET_VERSION = '2.0.12';
const RELEASED_AT = '2026-09-26T20:00:00Z';

type InvestigateOverlay = Record<string, unknown> & {
  workflow?: { phases?: Array<Record<string, unknown>> };
  steps?: Record<string, Record<string, unknown>>;
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
  const phase = overlay.workflow?.phases?.find(
    (candidate: Record<string, unknown>) => candidate.id === 'fix-and-verify',
  ) as Record<string, unknown> | undefined;
  if (!phase || typeof phase.prompt !== 'string') {
    throw new Error('investigate overlay fix-and-verify phase is missing or unexpected');
  }
  const executionGuidance =
    "Inspect `package.json` before verification. When it exposes an appropriate named test script, call `list_package_scripts` and then execute that script with `run_package_script`; do not substitute a prose claim or a host-side check. Record the exact command and observed exit result in the report. If no named script exists, state that explicitly and use the narrowest available execution tool.\n\nObservable handoff: write the completed result to `{{workPath}}/reports/root-cause-investigation.md` in the project's artifacts drawer with `write_artifact`. Do not merely describe what the file would contain. Re-read it with `read_artifact` before finishing this phase and repair any incomplete sections.";
  if (phase.prompt.includes('run_package_script')) {
    throw new Error('investigate overlay already carries package-script execution guidance');
  }
  phase.prompt = `${phase.prompt.trim()} ${executionGuidance}`;
  overlay.steps = {
    ...(overlay.steps ?? {}),
    'fix-and-verify': { prompt: phase.prompt },
  };

  wave.version = TARGET_VERSION;
  wave.releasedAt = RELEASED_AT;
  console.log(`planned root-cause execution-guidance wave ${TARGET_VERSION}`);
  if (dryRun) return;
  await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
  await writeFile(wavePath, `${JSON.stringify(wave, null, 2)}\n`);
}

await main();
