import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';

/**
 * Make the project's index as fresh as it can get, then publish the honest
 * readiness snapshot as an artifact — the ENSURE half of "this craftbook
 * depends on a current index".
 *
 * Meant as an `onEnter` hook on a review craftbook's first step: the
 * runtime re-scans the static index, drives the AI tiers (embed, shadows,
 * summaries, per-file reviews) with a bounded awake-time wait, and lands
 * the resulting report at `outFile` before the model's first turn. The
 * report separates what IS current from what CAN become current — on a
 * crew with no Boekwachter the AI-review counts can never drain, and a
 * review that waited on them would hang forever. The consuming step reads
 * the artifact and cites its coverage numbers and caveats instead of
 * assuming the index is complete.
 *
 * Never rejects for ordinary states (unstaffed crew, paused job, expired
 * budget): those are recorded in the report's `notes`. A throw here means
 * infrastructure — and step hooks are logged-and-swallowed, so the
 * consuming prompt must treat a missing artifact as "freshness unknown",
 * not as permission to invent coverage.
 */

export const meta = defineScript({
  name: 'ensureIndexFresh',
  description:
    "Action: bring the project's static + AI index as up to date as it can get within an awake-time budget, then publish the readiness snapshot (coverage counts, achievable tiers, caveats) as a JSON artifact for the consuming step to cite.",
  kind: 'action',
  inputs: {
    outFile: {
      type: 'string',
      description:
        'Artifact path to write the readiness report to (e.g. {{workPath}}/review/index-readiness.json).',
      required: true,
    },
    waitBudgetSeconds: {
      type: 'number',
      description:
        'Awake-time budget to wait for the AI tiers, in seconds (default 180, capped service-side below the script run timeout). 0 = refresh the static index and snapshot without waiting.',
      integer: true,
      min: 0,
    },
    reviews: {
      type: 'boolean',
      description: 'Also wait for the per-file AI review tier (default true).',
    },
  },
  outputs: {
    ok: { type: 'boolean', description: 'True when the report artifact was written.' },
    outFile: { type: 'string', description: 'Artifact path that was written.' },
    staticState: { type: 'string', description: 'Structural index state after the ensure pass.' },
    drained: {
      type: 'boolean',
      description: 'Every achievable index tier drained inside the budget.',
    },
    aiAchievable: {
      type: 'boolean',
      description: 'The AI tiers can progress at all (staffed, enabled, not paused).',
    },
    notes: { type: 'number', description: 'Number of coverage caveats recorded in the report.' },
  },
  requires: ['index.refresh', 'artifacts.write'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;

function fail(message: string): never {
  throw new Error(message);
}

const outFile = String(input.outFile ?? '')
  .replace(/\\+/g, '/')
  .replace(/^\.?\/+/, '')
  .replace(/^artifacts\/+/i, '')
  .trim();
if (!outFile) fail('outFile must be a non-empty artifact-relative path.');
if (outFile.split('/').includes('..')) fail("outFile must not contain '..' segments.");
// An uninterpolated placeholder means the craftbook's param wiring is broken;
// writing a `{{workPath}}/…` literal would strand the artifact where no gate
// or reader will ever look.
if (outFile.includes('{{')) {
  fail(`outFile still contains an uninterpolated placeholder: ${outFile}`);
}

const report = await gezel.index.ensureFresh({
  ...(typeof input.waitBudgetSeconds === 'number'
    ? { waitBudgetMs: input.waitBudgetSeconds * 1000 }
    : {}),
  ...(typeof input.reviews === 'boolean' ? { reviews: input.reviews } : {}),
});

await gezel.artifacts.write(outFile, `${JSON.stringify(report, null, 2)}\n`);

gezel.output({
  ok: true,
  outFile,
  staticState: report.staticState,
  drained: report.wait.drained,
  aiAchievable: report.aiTier.achievable,
  notes: report.notes.length,
});
