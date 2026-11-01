#!/usr/bin/env node
// Publish the reviewed Spark campaign without inference, retries or raw-evidence edits.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';
import { importCampaign } from './import-scorecard-campaigns.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicationId = '2026-10-30-spark-native-0-1-54';
const destination = `docs/handboek/assets/scorecards/${publicationId}`;
const finalRoot = 'evals/runs/scorecard-2026-10-30-spark-native-0.1.54-final-six';
const check = process.argv.includes('--check');
assert(process.argv.slice(2).every((arg) => arg === '--check'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const sourceHashes = {};
const portable = (name) => {
  const path = relative(root, resolve(root, name)).replaceAll('\\', '/');
  assert(!isAbsolute(path) && !path.startsWith('../'), 'Evidence outside checkout');
  return path;
};
const bytes = (name, expected) => {
  const path = portable(name);
  const value = readFileSync(resolve(root, path));
  const hash = sha(value);
  if (expected) assert.equal(hash, expected, `Evidence changed: ${path}`);
  sourceHashes[path] = hash;
  return value;
};
const read = (name, expected) => JSON.parse(bytes(name, expected));
const audit = read(`${finalRoot}/final-audit.json`);
const verification = read(`${finalRoot}/final-report-verification.json`);
const checkpoint = read(`${finalRoot}/checkpoint-2026-10-30T17-07.json`);
assert(audit.passed && verification.passed && checkpoint.identityChecksPassed);
for (const file of verification.files) bytes(`${finalRoot}/${file.file}`, file.sha256);
const overall = read(`${finalRoot}/overall-scorecard.json`);
assert.equal(overall.reviewStatus, 'final-reviewed');
assert.equal(overall.uniqueRecorded, 258);
const profile = read(`${finalRoot}/continuation-profile.json`);
const blockedId = 'r3-gemma-complex-work-craftbook-author-fanout';
const sharedNote =
  'Part of the 258-attempt Spark comparison across four task sets, three repetitions overall. Segments retain separate rounds and counts because neither execution condition has three repeats of every task. Native 0.1.54, llama.cpp CUDA, generalist auto. Task performance includes all attempts; artifact reviews retain separate rubrics. Source reviews can expose incorrect outputs accepted by automatic checks. The downloadable Spark report preserves all raw fixed scores, 119 artifact judgments, exact axes, exclusions, latency, tokens, RAM/GPU samples and review diagnostics.';
const segments = [
  {
    id: 'original',
    runId: '2026-10-28-spark-native-0-1-54-original',
    dir: 'evals/runs/scorecard-2026-10-27-spark-native-0.1.54-fresh',
    expected: 169,
    hash: profile.parentJournalSha256,
    scope: 'suite',
    treatment: 'original',
    note: `Original execution condition: 169 attempts, 117 passes and one sandbox-resolution infrastructure exclusion. The launcher existed on the machine but was unresolved by an isolated trial. The later continuation changes script isolation and is not merged with this baseline. ${sharedNote}`,
  },
  {
    id: 'continuation',
    runId: '2026-10-29-spark-native-0-1-54-continuation',
    dir: 'evals/runs/scorecard-2026-10-29-spark-native-0.1.54-continuation',
    expected: 83,
    hash: profile.priorContinuationJournalSha256,
    scope: 'subset',
    treatment: 'no-os-sandbox',
    note: `Separate continuation: 83 previously unstarted attempts, 59 passes. Scripts ran without the Windows OS sandbox; Node permissions, capabilities and timeouts remained. One undefined parameter in a model-authored recipe was classified as an unevaluable gate; its raw infrastructure exclusion remains recorded with authoring-origin diagnostics. Six unstarted cells moved to the separately labeled final segment. ${sharedNote}`,
  },
  {
    id: 'final-six',
    runId: '2026-10-30-spark-native-0-1-54-final-six',
    dir: finalRoot,
    expected: 6,
    scope: 'subset',
    treatment: 'no-os-sandbox',
    note: `Final six previously unstarted complex-work attempts: one automatic pass and five raw failures. The passing Gemma parameter report contained incorrect totals. Gemma fanout never reached inference because model capacity remained reserved; the published table attributes that attempt to infrastructure, preserving the raw verdict in the download. Its model-token usage is unavailable. This segment uses the same verified script-isolation condition as the continuation, with no retries. ${sharedNote}`,
  },
];
const metadata = {
  qwen: { label: 'Qwen 3.8 (27B, Q4)', parameterSize: '27B', quantization: 'UD-Q4_K_M' },
  gemma: { label: 'Gemma 4 (12B, Q4)', parameterSize: '12B', quantization: 'UD-Q4_K_XL' },
};
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const observation = (values) => {
  const present = values.filter(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
  return present.length
    ? {
        samples: present.length,
        median: median(present),
        min: Math.min(...present),
        max: Math.max(...present),
      }
    : undefined;
};
const trials = [];
const conditions = [];
const shards = [];
const publications = [];
for (const segment of segments) {
  const campaign = read(`${segment.dir}/campaign.json`, segment.hash);
  const ledger = read(`${segment.dir}/codex-inline-judge.json`);
  const coverage = read(`${segment.dir}/judging-coverage.json`);
  const findings = read(`${segment.dir}/failure-attribution.json`);
  assert.equal(campaign.rows.length, segment.expected);
  assert.equal(coverage.recorded, segment.expected);
  assert(coverage.coverage.every((cell) => cell.status !== 'pending'));
  const models = Object.fromEntries(
    campaign.definition.targets.map((target) => {
      const tiers = new Set(
        campaign.rows
          .filter((row) => row.cell.targetId === target.id)
          .map((row) => row.result.modelTier),
      );
      assert.equal(tiers.size, 1);
      return [target.id, { ...metadata[target.id], tier: [...tiers][0] }];
    }),
  );
  const imported = importCampaign(root, {
    campaignRoot: segment.dir,
    campaignSha256: sourceHashes[`${segment.dir}/campaign.json`],
    expectedTrials: segment.expected,
    count: 3,
    runId: segment.runId,
    scope: segment.scope,
    models,
    note: segment.note,
    classificationCorrections:
      segment.id === 'final-six'
        ? [
            {
              cellId: blockedId,
              failureClass: 'infra',
              reason:
                'Native-capacity admission blocked the first request; no engine inference, tool call or generated output occurred. Keep the raw model-default failure and score in the companion.',
              evidence: [
                `${finalRoot}/gemma-author-fanout-repetition3-evidence.json`,
                `${finalRoot}/capacity-ledger-readonly-2026-10-30T17-07.json`,
              ],
            },
          ]
        : [],
  });
  Object.assign(sourceHashes, imported.audit.inputSha256);
  const statuses = new Map(coverage.coverage.map((cell) => [cell.cellId, cell]));
  const observed = new Map(imported.audit.observations.map((item) => [item.cell.id, item]));
  for (const judge of ledger.judgments) {
    bytes(judge.artifactPath, judge.artifactSha256);
    assert(judge.judgeProvider === 'codex-inline' && judge.judgeModel === 'current-session');
    assert(judge.reviewedBytes <= 20480 && judge.justification.length <= 400);
    assert.deepEqual(
      Object.keys(judge.scoreAxes).sort(),
      judge.axes.map((axis) => axis.name).sort(),
    );
    assert(
      Object.values(judge.scoreAxes).every(
        (score) => Number.isInteger(score) && score >= 0 && score <= 10,
      ),
    );
    assert.equal(mean(Object.values(judge.scoreAxes)), judge.meanScore);
  }
  const selected = campaign.rows.map((row) => {
    const { cell, result } = row;
    const facts = read(`${result.runDir}/facts.json`);
    const metrics = read(`${result.runDir}/metrics.json`);
    const host = read(`${result.runDir}/host.json`);
    assert.deepEqual(metrics, row.metrics);
    assert.equal(facts.trialId, result.trialId);
    assert.equal(facts.outcome.success, result.success);
    const status = statuses.get(cell.id);
    assert(status);
    const reviews = ledger.judgments.filter((judge) => judge.cellId === cell.id);
    const primary = reviews.filter((judge) => judge.primaryForCell !== false);
    assert.equal(primary.length, status.status === 'complete' ? 1 : 0);
    const tableReview = primary.length
      ? {
          status: primary[0].rubricApplicability === 'mismatched' ? 'excluded' : 'judged',
          rubricId: ['tictactoe', 'petshop', 'tankcombat'].includes(cell.scenario)
            ? 'default-html-v1'
            : cell.scenario,
          report: primary[0],
        }
      : { status: status.status === 'noArtifact' ? 'noArtifact' : 'notApplicable' };
    const localUsage = metrics.usage?.source === 'engine-log' && metrics.usage.available;
    return {
      runId: segment.runId,
      segment: segment.id,
      treatment: segment.treatment,
      ...row,
      facts,
      host,
      tableReview,
      reviews,
      reviewCoverage: status,
      publication: observed.get(cell.id),
      analyticalTokens: {
        source: localUsage ? 'engine-log' : 'unavailable',
        input: localUsage ? metrics.usage.totalInputTokens : null,
        output: localUsage ? metrics.usage.totalOutputTokens : null,
      },
      postmortem: bytes(`${result.runDir}/postmortem.md`).toString(),
    };
  });
  const shard = imported.dataset;
  const run = shard.runs[0];
  run.memoryCoverage = 'system-only';
  run.provenance.device.label = 'Windows ARM64 · NVIDIA RTX Spark N1X';
  run.provenance.judgeModelId = 'codex-inline/current-session';
  run.provenance.engineBuilds = {
    'llama-cpp': 'Gezel native 0.1.54 · CUDA 13.4 · 620d2225cc436ab0b001e3200e590e3b286ef9ab',
  };
  // This segment's plan is only three complex-work scenarios, not the frozen registry.
  if (segment.id === 'final-six') {
    run.suites = ['complex-work'];
    run.scenariosBySuite = {
      'complex-work': [...new Set(campaign.cells.map((cell) => cell.scenario))],
    };
    shard.results = shard.results.filter((result) => result.suiteId === 'complex-work');
    for (const result of shard.results)
      result.cells = result.cells.filter((cell) =>
        run.scenariosBySuite['complex-work'].includes(cell.scenarioId),
      );
  }
  for (const result of shard.results) {
    const group = selected.filter(
      (trial) => trial.cell.model === result.modelId && trial.cell.suite === result.suiteId,
    );
    const kv = new Set(
      group.map((trial) => trial.result.engineContext?.kvCacheType).filter(Boolean),
    );
    if (result.runtime && kv.size === 1) result.runtime.kvCacheType = [...kv][0];
    const rubricIds = [
      ...new Set(
        group
          .filter((trial) => trial.tableReview.status === 'judged')
          .map((trial) => trial.tableReview.rubricId),
      ),
    ].sort();
    result.taskMeasurements = [
      {
        id: segment.id,
        label: `${segment.id === 'original' ? 'Original condition' : 'Separate continuation condition'} · all attempts`,
        trials: group.length,
        source: 'engine-log',
        outputTokensPerSec: observation(
          group.map((trial) => trial.metrics.derived?.genTokensPerSec),
        ),
        prefillTokensPerSec: observation(
          group.map((trial) => trial.metrics.derived?.promptTokensPerSec),
        ),
        durationMs: observation(group.map((trial) => trial.result.durationMs)),
        peakRssMb: observation(group.map((trial) => trial.metrics.process?.peakRssMb)),
        peakGpuMemMb: observation(
          group.map((trial) =>
            trial.metrics.gpu?.available ? trial.metrics.gpu.peakMemUsedMb : null,
          ),
        ),
        judgments: rubricIds.map((rubricId) => {
          const reviews = group
            .filter(
              (trial) =>
                trial.tableReview.status === 'judged' && trial.tableReview.rubricId === rubricId,
            )
            .map((trial) => trial.tableReview.report);
          assert(
            reviews.every(
              (review) => JSON.stringify(review.axes) === JSON.stringify(reviews[0].axes),
            ),
            'Mixed rubric axes',
          );
          return {
            rubricId,
            meanScore: mean(reviews.map((review) => review.meanScore)),
            artifacts: reviews.length,
            judgeModel: 'codex-inline/current-session',
          };
        }),
        noArtifact: group.filter((trial) => trial.tableReview.status === 'noArtifact').length,
        excludedReviews: group.filter((trial) => trial.tableReview.status === 'excluded').length,
        notApplicableReviews: group.filter((trial) => trial.tableReview.status === 'notApplicable')
          .length,
      },
    ];
  }
  shards.push(ScorecardDatasetSchema.parse(shard));
  trials.push(...selected);
  publications.push(imported.audit);
  conditions.push({
    runId: segment.runId,
    segment: segment.id,
    treatment: segment.treatment,
    note: segment.note,
    definition: campaign.definition,
    provenance: run.provenance,
    runtimeIdentity: campaign.identity,
    judging: ledger,
    coverage,
    findings,
  });
}
const dataset = ScorecardDatasetSchema.parse({
  schemaVersion: 1,
  runs: shards.flatMap((shard) => shard.runs).reverse(),
  results: shards.flatMap((shard) => shard.results),
});
assert.equal(new Set(trials.map((trial) => trial.cell.id)).size, 258);
assert.equal(new Set(trials.map((trial) => trial.result.trialId)).size, 258);
const counts = {
  trials: trials.length,
  rawPasses: trials.filter((trial) => trial.result.success).length,
  rawEligible: trials.filter((trial) => trial.score.eligibility.includedInModelAggregate).length,
  rawExclusions: 2,
  publishedNonModelFailures: 3,
  publicationClassificationCorrections: 1,
  artifactJudgments: conditions.reduce((n, condition) => n + condition.judging.judgments.length, 0),
  producedDeclaredPaths: audit.producedDeclaredPaths,
  primaryReviewedCells: 112,
  tableJudgedCells: trials.filter((trial) => trial.tableReview.status === 'judged').length,
  tableExcludedReviews: trials.filter((trial) => trial.tableReview.status === 'excluded').length,
  noArtifact: trials.filter((trial) => trial.tableReview.status === 'noArtifact').length,
  noDeclaredAxes: trials.filter((trial) => trial.tableReview.status === 'notApplicable').length,
  pendingReviews: 0,
};
assert.deepEqual(
  [
    counts.trials,
    counts.rawPasses,
    counts.rawEligible,
    counts.artifactJudgments,
    counts.tableJudgedCells,
    counts.tableExcludedReviews,
    counts.noArtifact,
    counts.noDeclaredAxes,
  ],
  [258, 177, 256, 119, 106, 6, 2, 144],
);
assert.equal(
  dataset.results
    .flatMap((result) => result.cells)
    .reduce((n, cell) => n + cell.nonModelFailures, 0),
  3,
);
const files = new Map();
const sanitize = (value) => {
  if (typeof value === 'string')
    return value
      .replaceAll(`${root}\\`, '')
      .replaceAll(`${root.replaceAll('\\', '/')}/`, '')
      .replaceAll('mikeam-rtx', '<host>')
      .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"'<>]+/gi, '<home>')
      .replace(/\b[A-Za-z]:[\\/][^\s"'<>)]*/g, '<local-path>')
      .replace(/(?:evals|packages|docs|scripts|<home>)[\\/][^\s"'<>)]*/g, (path) =>
        path.replaceAll('\\', '/'),
      );
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [sanitize(key), sanitize(item)]),
    );
  return value;
};
const addJson = (name, value) => files.set(name, `${JSON.stringify(sanitize(value), null, 2)}\n`);
const reportNames = ['overall-scorecard.md', 'scenario-comparison.md', 'final-coverage-audit.md'];
const reports = Object.fromEntries(
  reportNames.map((name) => [name, bytes(`${finalRoot}/${name}`).toString()]),
);
const diagnostics = {};
for (const segment of segments) {
  for (const name of ['qualitative-report.md', 'coverage-audit.md', 'report.md'])
    reports[`${segment.id}/${name}`] = bytes(`${segment.dir}/${name}`).toString();
}
for (const name of [
  'final-audit.json',
  'final-report-verification.json',
  'launch-verification.json',
  'authorization-and-lineage.json',
  'capacity-ledger-readonly-2026-10-30T17-07.json',
  'qwen-author-params-repetition3-evidence.json',
  'gemma-author-params-repetition3-evidence.json',
  'qwen-author-gate-script-repetition3-evidence.json',
  'gemma-author-gate-script-repetition3-evidence.json',
  'qwen-author-fanout-repetition3-evidence.json',
  'gemma-author-fanout-repetition3-evidence.json',
])
  diagnostics[name] = read(`${finalRoot}/${name}`);
diagnostics.performanceSupplement = read(`${segments[1].dir}/performance-supplement.json`);
reports['continuation/stop-review-2026-10-30.md'] = bytes(
  `${segments[1].dir}/stop-review-2026-10-30.md`,
).toString();
bytes(`${segments[0].dir}/native-install.log`);
assert.equal(
  sha(bytes(`${segments[1].dir}/script-profile-hook.mjs`)),
  sha(bytes(`${finalRoot}/script-profile-hook.mjs`)),
);
for (const shard of shards) {
  addJson(`packages/core/src/scorecard/data/runs/${shard.runs[0].id}.json`, shard);
  addJson(`${destination}/runs/${shard.runs[0].id}.json`, shard);
}
addJson(`${destination}/scorecard.json`, dataset);
addJson(`${destination}/overall-scorecard.json`, overall);
addJson(`${destination}/scorecard-details.json`, {
  schemaVersion: 1,
  kind: 'scorecard-details',
  publicationId,
  complete: true,
  reviewedAt: verification.verifiedAt,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  counts,
  conditions,
  trials,
  publications,
  diagnostics,
  reports,
  interpretation: {
    baselines:
      'Three separately journaled segments. Original OS-boundary condition is never pooled with the two no-OS-sandbox segments. The analytical companion explicitly combines the latter only after verified identity equivalence; product tables keep all three rounds.',
    capability:
      'All raw outcomes, fixed scores and journals are unchanged. Publication-only classification correction sets aside the final Gemma admission-blocked attempt. The two original raw exclusions remain, including the model-authored undefined workPath gate. Raw and sensitivity aggregates are retained in overall-scorecard.json.',
    judging:
      '119 bounded artifact-content judgments cover 125 produced declared paths across 112 cells. One primary per cell feeds task tables: 106 included, six rubric-mismatched A/B reviews excluded, two missing artifacts and 144 tasks with no declared axes. Exact axes/rationales and secondary judgments are retained. Source review is not a full rendered UX evaluation.',
    performance:
      'Task tables include all attempts within each segment, independent of capability eligibility. Engine-log decode/prefill and sampled RSS/GPU peaks are distinct from admission probes and system RAM. Final Gemma fanout has no local-engine token observation; its raw HTTP zero counters are retained but analytical model tokens are unavailable. First-write timing is not completed-output latency.',
  },
  evidence: {
    pathConvention:
      'Repository-relative local archive references, not public download URLs. Per-trial structured evidence, judgments, postmortems and diagnostics are embedded here. Raw transcripts, process logs, generated artifacts, credentials and binaries stay in the local archive. Source hashes identify original unsanitized evidence.',
    sourceFiles: sourceHashes,
  },
});
addJson(`${destination}/verification.json`, {
  counts,
  uniqueCells: 258,
  modelSuiteScenarioGroups: 86,
  repetitionsAllThree: true,
  originalEvidenceModified: false,
  frozenIdentityVerified: true,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  schema: 'ScorecardDatasetSchema v1',
  segmentsKeptSeparate: true,
  sourceFilesVerified: Object.keys(sourceHashes).length,
});
const publicTargets = new Map(
  reportNames.map((name) => [
    `${finalRoot}/${name}`,
    name === 'overall-scorecard.md' ? 'report.md' : name,
  ]),
);
publicTargets.set(`${finalRoot}/overall-scorecard.json`, 'overall-scorecard.json');
publicTargets.set(`${finalRoot}/overall-trials.csv`, 'overall-trials.csv');
const publicMarkdown = (text) =>
  sanitize(
    text.replace(
      /\]\(<([^>]+)>\)/g,
      (_match, target) => `](${publicTargets.get(portable(target)) ?? 'scorecard-details.json'})`,
    ),
  );
for (const name of reportNames)
  files.set(
    `${destination}/${name === 'overall-scorecard.md' ? 'report.md' : name}`,
    `${publicMarkdown(reports[name])}\n\nPublication note: individual evidence and postmortem links open the bundled scorecard-details.json, which preserves the original archive references. The raw analytical scorecard keeps the final Gemma admission attempt eligible; product tables apply the documented infrastructure attribution correction.\n`,
  );
files.set(
  `${destination}/overall-trials.csv`,
  sanitize(bytes(`${finalRoot}/overall-trials.csv`).toString()),
);
for (const segment of segments)
  addJson(
    `${destination}/judging/${segment.id}.json`,
    conditions.find((condition) => condition.segment === segment.id).judging,
  );
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId,
  regenerate:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-spark-native-054-scorecard.mjs',
  check:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-spark-native-054-scorecard.mjs --check',
  files: [...files].map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: sha(value),
  })),
});
const strings = (value) => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
  return [];
};
for (const [name, value] of files) {
  // Inspect decoded JSON: a Python line ending in `as f:` followed by an
  // encoded newline is not a Windows drive path.
  const content = name.endsWith('.json') ? strings(JSON.parse(value)) : [value];
  assert(
    content.every((text) => !/\b[A-Za-z]:[\\/]|mikeam-rtx/.test(text)),
    `Workstation path in ${name}`,
  );
  assert(
    content.every(
      (text) => !/\bBearer\s+[A-Za-z0-9._~-]{20,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/.test(text),
    ),
    `Possible credential in ${name}`,
  );
}
for (const [name, value] of files) {
  const target = resolve(root, name);
  if (check) assert.equal(readFileSync(target, 'utf8'), value, `Publication drift: ${name}`);
  else {
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target) || readFileSync(target, 'utf8') !== value) writeFileSync(target, value);
  }
}
console.log(
  JSON.stringify({
    mode: check ? 'verified' : 'written',
    counts,
    files: files.size,
    sourceFilesVerified: Object.keys(sourceHashes).length,
  }),
);
