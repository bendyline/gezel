/**
 * Move the root-cause report's citation floor into its pre-terminal gate so
 * the fixing actor can repair the artifact with the tools it actually owns.
 * Also make the two required evidence paths explicit to medium models.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireGildeCheckout } from './gilde-checkout.js';

const SOURCE_VERSION = '2.0.16';
const TARGET_VERSION = '2.0.17';
const RELEASED_AT = '2026-09-27T02:00:00Z';
const REPORT_PATH = '{{workPath}}/reports/root-cause-investigation.md';
const PROMPT_ANCHOR =
  'Record the exact command and observed exit result in the report. If no named script exists, state that explicitly and use the narrowest available execution tool.';
const CITATION_GUIDANCE =
  ' Cite at least two distinct inspected workspace paths in the report using backticks; include `src/cart-total.js` and `tests/cart-total.test.mjs`.';

type Check = Record<string, unknown>;
type InvestigateOverlay = {
  workflow?: {
    phases?: Array<{
      id?: unknown;
      prompt?: unknown;
      output?: { additionalChecks?: Check[] };
    }>;
  };
  steps?: Record<string, { prompt?: unknown; gate?: Record<string, unknown> }>;
};

function addPromptGuidance(prompt: unknown, location: string): string {
  if (typeof prompt !== 'string' || !prompt.includes(PROMPT_ANCHOR)) {
    throw new Error(`${location} no longer matches the expected verification guidance`);
  }
  if (prompt.includes(CITATION_GUIDANCE.trim())) {
    throw new Error(`${location} already contains the citation guidance`);
  }
  return prompt.replace(PROMPT_ANCHOR, `${PROMPT_ANCHOR}${CITATION_GUIDANCE}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const checkout = requireGildeCheckout();
  const root = join(checkout.root, 'authoring', 'gstack');
  const wavePath = join(root, 'wave.json');
  const overlayPath = join(root, 'overlays', 'investigate.json');
  const latestPath = join(
    checkout.root,
    'data',
    'craftbook-templates',
    'ro',
    'root-cause-investigation',
    'versions',
    SOURCE_VERSION,
    'craftbook.json',
  );
  const wave = JSON.parse(await readFile(wavePath, 'utf8')) as Record<string, unknown>;
  if (wave.version !== SOURCE_VERSION) {
    throw new Error(`expected gstack wave ${SOURCE_VERSION}, found ${String(wave.version)}`);
  }

  const overlay = JSON.parse(await readFile(overlayPath, 'utf8')) as InvestigateOverlay;
  const phase = overlay.workflow?.phases?.find((candidate) => candidate.id === 'fix-and-verify');
  const step = overlay.steps?.['fix-and-verify'];
  if (!phase?.output || !step) throw new Error('root-cause fix-and-verify authoring is missing');
  phase.prompt = addPromptGuidance(phase.prompt, 'workflow phase prompt');
  step.prompt = addPromptGuidance(step.prompt, 'step override prompt');

  const citationCheck: Check = {
    kind: 'citationsResolve',
    file: REPORT_PATH,
    minCitations: 2,
    artifact: true,
  };
  const authoredChecks = phase.output.additionalChecks ?? [];
  if (authoredChecks.some((check) => check.kind === 'citationsResolve')) {
    throw new Error('workflow phase already has a citation gate');
  }
  phase.output.additionalChecks = [...authoredChecks, citationCheck];

  const latest = JSON.parse(await readFile(latestPath, 'utf8')) as {
    steps?: Array<{ id?: unknown; gate?: Record<string, unknown> }>;
  };
  const latestStep = latest.steps?.find((candidate) => candidate.id === 'fix-and-verify');
  const gate = latestStep?.gate as { checks?: Check[] } | undefined;
  if (!gate?.checks || gate.checks.some((check) => check.kind === 'citationsResolve')) {
    throw new Error('latest root-cause fix gate is missing or already has a citation check');
  }
  step.gate = { ...latestStep!.gate, checks: [...gate.checks, citationCheck] };

  wave.version = TARGET_VERSION;
  wave.releasedAt = RELEASED_AT;
  console.log(`planned root-cause citation-gate wave ${TARGET_VERSION}`);
  if (dryRun) return;
  await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
  await writeFile(wavePath, `${JSON.stringify(wave, null, 2)}\n`);
}

await main();
