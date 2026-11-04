#!/usr/bin/env node
// Publish completed, reviewed evidence. Never run inference or edit the source archive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMlxPrefillTelemetry } from '../evals/src/mlx-prefill-telemetry.ts';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';
import { importCampaign } from './import-scorecard-campaigns.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const campaignRoot = 'evals/runs/scorecard-2026-10-27-m5max-native-0.1.54';
const publicationId = '2026-10-27-m5max-native-0-1-54';
const destination = `docs/handboek/assets/scorecards/${publicationId}`;
const campaignSha256 = 'a64051dadd9e07e96cee37afd4314febcfc8f43c069701ab0e3fa5cb1cc98dc1';
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
const audit = read(`${campaignRoot}/completion-audit.json`);
assert.equal(audit.status, 'complete');
assert.equal(audit.pendingReviews, 0);
for (const [name, hash] of Object.entries(audit.recordSha256))
  bytes(`${campaignRoot}/${name}`, hash);
for (const trial of audit.trialEvidence)
  for (const [name, hash] of Object.entries(trial.sha256)) bytes(`${trial.runDir}/${name}`, hash);
const identity = read(`${campaignRoot}/final-identity.json`);
assert.deepEqual(identity.changes, []);
assert(identity.definitionMatches && identity.cellsMatch && !identity.running);
const campaign = read(`${campaignRoot}/campaign.json`, campaignSha256);
const native = read(`${campaignRoot}/native-provenance.json`);
const analysis = read(`${campaignRoot}/final-analysis.json`);
const ledger = read(`${campaignRoot}/codex-inline-judge.json`);
const models = {
  'qwen-mlx': {
    label: 'Qwen 3.8 (27B, Q4) · MLX',
    tier: 'medium',
    parameterSize: '27B',
    quantization: '4-bit affine, group 64',
  },
  'qwen-llamacpp': {
    label: 'Qwen 3.8 (27B, Q4) · llama.cpp',
    tier: 'medium',
    parameterSize: '27B',
    quantization: 'UD-Q4_K_M',
  },
  'gemma-mlx': {
    label: 'Gemma 4 (12B, Q4) · MLX',
    tier: 'medium',
    parameterSize: '12B',
    quantization: 'MXFP4, group 32',
  },
  'gemma-llamacpp': {
    label: 'Gemma 4 (12B, Q4) · llama.cpp',
    tier: 'medium',
    parameterSize: '12B',
    quantization: 'qat UD-Q4_K_XL',
  },
};
const imported = importCampaign(root, {
  campaignRoot,
  campaignSha256,
  expectedTrials: 516,
  count: 3,
  runId: publicationId,
  scope: 'suite',
  models,
  note: 'Completed M5 Max 128 GB comparison: 516 attempts, 349 passes, 165 model-classified failures and two preserved infrastructure exclusions. Every model/engine/scenario/suite has three repetitions. Native 0.1.54, generalist auto. Task measurements include all attempts; 215 bounded artifact reviews retain separate rubrics, including 80 failed trials. Twelve incompatible A/B specifications and one missing artifact receive no numeric score. MLX observed prefill was recovered from rounded first-token chat events for all 258 MLX trials; these partial rates are not aggregate request throughput or pure prefill time. macOS GPU utilization and MLX granted context remain unknown. Engine-specific quantization, speculative decoding, raw fixed scores, advisory quality, timing, throughput, memory and failure diagnoses are documented in the downloads.',
});
Object.assign(sourceHashes, imported.audit.inputSha256);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const observation = (values) => {
  const sorted = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .toSorted((a, b) => a - b);
  return sorted.length
    ? {
        samples: sorted.length,
        median: (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2,
        min: sorted[0],
        max: sorted.at(-1),
      }
    : undefined;
};
const reviewHashes = new Map(audit.activeReviewFileHashes.map((review) => [review.cellId, review]));
const reviews = new Map(ledger.trials.map((review) => [review.cellId, review]));
assert.equal(reviews.size, 516);
const treatments = new Map();
const trials = campaign.rows.map((row) => {
  const { cell, result } = row;
  const key = `${cell.model}/${cell.provider}/${cell.suite}/${cell.scenario}`;
  treatments.set(key, [...(treatments.get(key) ?? []), cell.repetition]);
  const facts = read(`${result.runDir}/facts.json`);
  const metrics = read(`${result.runDir}/metrics.json`);
  const host = read(`${result.runDir}/host.json`);
  assert.deepEqual(metrics, row.metrics);
  assert.deepEqual(facts.timing, row.timing);
  assert.equal(facts.trialId, result.trialId);
  assert.equal(facts.outcome.success, result.success);
  assert.equal(host.framework, cell.provider);
  if (cell.provider === 'llama-cpp') {
    assert.equal(host.frameworkBuild.revision, native.llamaBuild.revision);
    assert.equal(host.frameworkBuild.backend, native.llamaBuild.backend);
    assert.equal(host.frameworkBuild.buildNumber, '11669');
    assert.equal(host.frameworkBuild.sidecarPresent, true);
  }
  const originalReview = reviews.get(cell.id);
  assert(originalReview && originalReview.trialId === result.trialId);
  const review = { ...originalReview };
  if (['judged', 'judgeSpecMismatch'].includes(review.status)) {
    const hashes = reviewHashes.get(cell.id);
    assert(hashes && hashes.packetId === review.id);
    const packet = read(`${campaignRoot}/judge-packets/${review.id}.packet.json`);
    const score = read(
      `${campaignRoot}/judge-packets/${review.id}.score.json`,
      hashes.scoreFileSha256,
    );
    const artifact = bytes(review.artifactPath, hashes.artifactSha256);
    assert.equal(packet.artifact, artifact.subarray(0, 20480).toString('utf8'));
    assert.equal(packet.bytes, artifact.length);
    assert.equal(packet.truncated, hashes.truncated);
    assert.equal(review.justification, score.justification);
    assert.equal(review.reviewedAt, score.reviewedAt);
    assert(review.justification.length <= 400);
    assert.equal(review.judgeProvider, 'codex-inline');
    assert.equal(review.judgeModel, 'current-session');
    if (review.status === 'judged') {
      assert.deepEqual(review.scoreAxes, score.scoreAxes);
      assert.deepEqual(
        Object.keys(review.scoreAxes).sort(),
        packet.axes.map((axis) => axis.name).sort(),
      );
      assert(
        Object.values(review.scoreAxes).every((v) => Number.isInteger(v) && v >= 0 && v <= 10),
      );
      assert.equal(review.meanScore, mean(Object.values(review.scoreAxes)));
    } else assert(!review.scoreAxes && !score.scoreAxes);
    const { artifact: _artifact, ...specification } = packet;
    Object.assign(review, {
      specification,
      reviewedBytes: Math.min(20480, artifact.length),
      artifactSha256: hashes.artifactSha256,
      scoreFileSha256: hashes.scoreFileSha256,
    });
  } else
    assert(
      ['noArtifact', 'notApplicable'].includes(review.status) &&
        !review.scoreAxes &&
        !review.artifactPath,
    );
  return {
    ...row,
    facts,
    host,
    review,
    postmortem: bytes(`${result.runDir}/postmortem.md`).toString(),
  };
});
assert.equal(new Set(trials.map((trial) => trial.cell.id)).size, 516);
assert.equal(new Set(trials.map((trial) => trial.result.trialId)).size, 516);
assert.equal(treatments.size, 172);
for (const repetitions of treatments.values()) assert.deepEqual(repetitions.toSorted(), [1, 2, 3]);
const counts = {
  trials: trials.length,
  treatments: treatments.size,
  passes: trials.filter((trial) => trial.result.success).length,
  eligible: trials.filter((trial) => trial.score.eligibility.includedInModelAggregate).length,
  exclusions: trials.filter((trial) => !trial.score.eligibility.includedInModelAggregate).length,
  numericReviews: trials.filter((trial) => trial.review.status === 'judged').length,
  judgeSpecMismatch: trials.filter((trial) => trial.review.status === 'judgeSpecMismatch').length,
  noArtifact: trials.filter((trial) => trial.review.status === 'noArtifact').length,
  notApplicable: trials.filter((trial) => trial.review.status === 'notApplicable').length,
  judgedFailedTrials: trials.filter(
    (trial) => trial.review.status === 'judged' && !trial.result.success,
  ).length,
  pendingReviews: 0,
};
assert.deepEqual(Object.values(counts), [516, 172, 349, 514, 2, 215, 12, 1, 288, 80, 0]);
// Supplement the published analysis from immutable recordings. No archive file,
// original aggregate rate, fixed score, exclusion or review is overwritten.
const recoveredTrials = trials
  .filter((trial) => trial.cell.provider === 'mlx')
  .map((trial) => {
    const recording = `${trial.result.runDir}/recording/chat-events.jsonl`;
    const recordingBytes = bytes(recording);
    const recovered = parseMlxPrefillTelemetry(recordingBytes.toString('utf8'));
    assert.equal(trial.metrics.derived.promptTokensPerSec, null);
    assert(recovered.sampleCount > 0, trial.cell.id);
    assert.equal(recovered.structuredSampleCount, 0);
    assert.equal(recovered.malformedLineCount, 0);
    assert.equal(recovered.duplicateLineCount, 0);
    return {
      cell: trial.cell,
      trialId: trial.result.trialId,
      success: trial.result.success,
      includedInCapability: trial.score.eligibility.includedInModelAggregate,
      recording: portable(recording),
      recordingSha256: sha(recordingBytes),
      metrics: portable(`${trial.result.runDir}/metrics.json`),
      metricsSha256: sourceHashes[portable(`${trial.result.runDir}/metrics.json`)],
      originalAggregatePrefillTokensPerSec: null,
      purePrefillDurationMs: null,
      recovered,
    };
  });
assert.equal(recoveredTrials.length, 258);
const recoveryGroups = ['qwen-mlx', 'gemma-mlx'].flatMap((targetId) =>
  ['all', 'core', 'productivity', 'developer', 'complex-work'].map((suite) => {
    const group = recoveredTrials.filter(
      (trial) =>
        trial.cell.targetId === targetId && (suite === 'all' || trial.cell.suite === suite),
    );
    return {
      targetId,
      model: group[0].cell.model,
      suite,
      trials: group.length,
      observations: group.reduce((n, trial) => n + trial.recovered.sampleCount, 0),
      observedPrefillTokensPerSec: observation(group.map((trial) => trial.recovered.tokensPerSec)),
    };
  }),
);
const recovery = {
  schemaVersion: 1,
  publicationId,
  recoveredOn: '2026-11-03',
  campaignSha256,
  parserSha256: sha(bytes('evals/src/mlx-prefill-telemetry.ts')),
  method:
    'Median of observed rounded first-token prefill rates within each trial, then median across trials. Partial provider-turn coverage, not duration-weighted aggregate throughput or pure prefill time. All attempts are represented, including failures and the original infrastructure exclusion.',
  caveats: [
    'Internal tool-loop requests, cancelled turns and event-stream gaps may be absent. Coverage of every request is not asserted.',
    'Only exact recorded duplicates can be detected; reconnect replay without stable event IDs cannot be identified.',
    'Time to first token includes other work and cannot substitute for prefill duration. Rounded rates and trial token totals cannot reconstruct exact durations.',
    'These observations must not be treated as the same estimator as llama.cpp aggregate prompt tokens divided by prompt-evaluation seconds.',
  ],
  coverage: {
    recordedMlxTrials: recoveredTrials.length,
    recoveredMlxTrials: recoveredTrials.length,
    observations: recoveredTrials.reduce((n, trial) => n + trial.recovered.sampleCount, 0),
    structuredObservations: 0,
    malformedLines: 0,
    exactDuplicates: 0,
    capabilityExcludedTrials: recoveredTrials.filter((trial) => !trial.includedInCapability).length,
  },
  groups: recoveryGroups,
  trials: recoveredTrials,
};
assert.equal(recovery.coverage.observations, 2175);
const recoveryByCell = new Map(recoveredTrials.map((trial) => [trial.cell.id, trial]));
const recoveredSummary = (cellId) => {
  const value = recoveryByCell.get(cellId)?.recovered;
  if (!value) return null;
  const { observations: _observations, ...summary } = value;
  return summary;
};
const recoverySummary = [
  '# October 27 MLX prefill recovery',
  '',
  'Recovered 2,175 rounded first-token prefill observations from all 258 MLX trials (129 per model). The original archive, fixed scores, exclusions, judgments and raw metrics are unchanged. No additional inference was run.',
  '',
  recovery.method,
  '',
  '| Model | Suite | Trials | Observations | Observed prefill tok/s, median of trial medians |',
  '| --- | --- | ---: | ---: | ---: |',
  ...recoveryGroups.map(
    (group) =>
      `| ${group.model} | ${group.suite} | ${group.trials} | ${group.observations} | ${group.observedPrefillTokensPerSec.median.toFixed(2)} |`,
  ),
  '',
  ...recovery.caveats.map((caveat) => `- ${caveat}`),
  '',
  'The historical report marked MLX prefill unknown because its structured metrics had no rate. The recordings nevertheless retained first-token diagnostic text. This publication revision uses the same parser and method as the November 3 recovery. Only provider engine_phase generating events in the exact first-token format are read; generated model text is never treated as telemetry.',
  '',
  'Each observation retains its recording line, receive timestamp, session ID and rate. [Recovery data](mlx-prefill-recovery.json) includes recording and original-metrics SHA-256 hashes; [trial summaries](mlx-prefill-recovery.csv) are also available. The [original report](original-report.md) and [completion audit](completion-audit.json) preserve the earlier checkpoint. The [updated report](report.md) and [scorecard](scorecard.json) add the recovered evidence separately.',
  '',
].join('\n');
const dataset = imported.dataset;
const run = dataset.runs[0];
run.memoryCoverage = 'full';
run.provenance.judgeModelId = 'codex-inline/current-session';
run.provenance.engineBuilds = {
  'llama-cpp': `Gezel native 0.1.54 · Metal · llama.cpp ${native.llamaVersion} · ${native.llamaBuild.revision}`,
  mlx: `Gezel native 0.1.54 · MLX ${native.mlxPackages.mlx} · mlx-lm ${native.mlxPackages['mlx-lm']} · mlx-vlm ${native.mlxPackages['mlx-vlm']}`,
};
for (const result of dataset.results) {
  // These models appear on two engines in the same round: all three keys matter.
  const group = trials.filter(
    (trial) =>
      trial.cell.model === result.modelId &&
      trial.cell.provider === result.engine &&
      trial.cell.suite === result.suiteId,
  );
  assert.equal(group.length, result.cells.length * 3);
  const kv = new Set(group.map((trial) => trial.result.engineContext?.kvCacheType).filter(Boolean));
  if (result.runtime && kv.size === 1) result.runtime.kvCacheType = [...kv][0];
  const rubricId = (review) =>
    review.rubric === 'default-html' ? 'default-html-v1' : review.scenarioId;
  const judged = group.map((trial) => trial.review).filter((review) => review.status === 'judged');
  result.taskMeasurements = [
    {
      id: 'all-trials',
      label: 'All attempts · native 0.1.54',
      trials: group.length,
      source: 'engine-log',
      outputTokensPerSec: observation(group.map((trial) => trial.metrics.derived?.genTokensPerSec)),
      prefillTokensPerSec: observation(
        group.map((trial) => trial.metrics.derived?.promptTokensPerSec),
      ),
      observedPrefillTokensPerSec: observation(
        group.map((trial) => recoveryByCell.get(trial.cell.id)?.recovered.tokensPerSec),
      ),
      durationMs: observation(group.map((trial) => trial.result.durationMs)),
      peakRssMb: observation(group.map((trial) => trial.metrics.process?.peakRssMb)),
      judgments: [...new Set(judged.map(rubricId))].sort().map((id) => {
        const matching = judged.filter((review) => rubricId(review) === id);
        for (const review of matching)
          assert.deepEqual(review.specification.axes, matching[0].specification.axes);
        return {
          rubricId: id,
          meanScore: mean(matching.map((review) => review.meanScore)),
          artifacts: matching.length,
          judgeModel: 'codex-inline/current-session',
        };
      }),
      noArtifact: group.filter((trial) => trial.review.status === 'noArtifact').length,
      excludedReviews: group.filter((trial) => trial.review.status === 'judgeSpecMismatch').length,
      notApplicableReviews: group.filter((trial) => trial.review.status === 'notApplicable').length,
    },
  ];
}
ScorecardDatasetSchema.parse(dataset);
const interpretation = {
  capability:
    'All 516 raw outcomes, fixed scores and classifications are unchanged. The two original infrastructure exclusions remain excluded from capability aggregates. Three repetitions per model/engine/suite/scenario; no retries or substitution.',
  judging:
    '215 bounded source reviews, including 80 failed trials; exact prompts, axes, integer scores and rationales retained. Twelve incompatible A/B specifications and one missing declared artifact receive no numeric score; 288 tasks are ungraded. Compare within rubrics. Source reviews are not full rendered UX evaluations. Two artifacts exceeded the 20 KiB cap.',
  performance:
    'All attempts included regardless of success/eligibility. Actual in-trial engine-log rates, not low-token preflight probes. MLX decode is a median of pulse rates; llama.cpp is generated tokens divided by decode time. Recovered MLX observed prefill is a median of rounded first-token chat-event rates within each trial, not aggregate request throughput. Exact MLX prefill duration and granted context remain unknown. macOS GPU utilization/memory are unavailable, not zero. System RAM is machine-wide; process RSS is sampled. First artifact records first write, not completed output.',
  engines:
    'Qwen MLX: 4-bit affine/group64 with MTP and possible grammar fallback; llama.cpp: UD-Q4_K_M with F16 projection and MTP. Gemma MLX: MXFP4/group32 with FP16 tied embeddings and no observed MTP; llama.cpp: qat UD-Q4_K_XL with external Q4_0 MTP. llama.cpp context 262144/f16 KV/one parallel slot. Engine configurations are not identical quantizations.',
};
const reportFiles = {
  'report.md': 'final-scorecard.md',
  'failure-evidence.md': 'final-failure-evidence.md',
  'judging.md': 'judging.md',
  'runner-report.md': 'report.md',
  'supervision-notes.md': 'supervision-notes.md',
};
const reports = Object.fromEntries(
  Object.entries(reportFiles).map(([published, source]) => [
    published,
    bytes(`${campaignRoot}/${source}`).toString(),
  ]),
);
const diagnostics = Object.fromEntries(
  [
    'invoice-verdict-normalization-r3-replay.json',
    'author-linear-invalid-gate-pattern-r3-replay.json',
    'gate-result-array-contract-r3-replay.json',
  ].map((name) => [name, read(`${campaignRoot}/${name}`)]),
);
const files = new Map();
const sanitize = (value) => {
  if (typeof value === 'string')
    return value
      .replaceAll(`${root}/`, '')
      .replaceAll('Mikes-MacBook-Pro.local', '<host>')
      .replace(/\/Users\/[^/\s"'<>]+/g, '<home>')
      .replace(/(?:\/private)?\/var\/folders\/[^\s"'<>)]*/g, '<temporary-path>')
      .replace(/(?:\/private)?\/tmp\/[^\s"'<>)]*/g, '<temporary-path>');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [sanitize(key), sanitize(item)]),
    );
  return value;
};
const addJson = (name, value) => files.set(name, `${JSON.stringify(sanitize(value), null, 2)}\n`);
addJson(`packages/core/src/scorecard/data/runs/${publicationId}.json`, dataset);
addJson(`${destination}/scorecard.json`, dataset);
addJson(`${destination}/analysis.json`, {
  ...analysis,
  mlxPrefillRecovery: {
    file: 'mlx-prefill-recovery.json',
    method: recovery.method,
    coverage: recovery.coverage,
    groups: recoveryGroups,
  },
});
addJson(`${destination}/mlx-prefill-recovery.json`, recovery);
files.set(`${destination}/mlx-prefill-recovery.md`, recoverySummary);
const recoveryCsvColumns = [
  'cellId',
  'model',
  'suite',
  'scenario',
  'repetition',
  'success',
  'includedInCapability',
  'observedPrefillTokensPerSec',
  'observations',
  'source',
  'aggregation',
  'recordingSha256',
  'metricsSha256',
];
files.set(
  `${destination}/mlx-prefill-recovery.csv`,
  `${[
    recoveryCsvColumns.join(','),
    ...recoveredTrials.map((trial) =>
      [
        trial.cell.id,
        trial.cell.model,
        trial.cell.suite,
        trial.cell.scenario,
        trial.cell.repetition,
        trial.success,
        trial.includedInCapability,
        trial.recovered.tokensPerSec,
        trial.recovered.sampleCount,
        trial.recovered.source,
        trial.recovered.aggregation,
        trial.recordingSha256,
        trial.metricsSha256,
      ].join(','),
    ),
  ].join('\n')}\n`,
);
addJson(`${destination}/judging.json`, {
  ...ledger,
  trials: trials.map((trial) => ({ cell: trial.cell, ...trial.review })),
});
addJson(`${destination}/performance.json`, {
  schemaVersion: 1,
  publicationId,
  interpretation: interpretation.performance,
  coverage: {
    ...audit.performanceCoverage,
    observedMlxPrefill: { available: 258, totalMlxTrials: 258, observations: 2175 },
  },
  coverageNote:
    'prefillThroughput retains aggregate-rate availability. Recovered MLX observations are additional, partial evidence, tracked separately under observedMlxPrefill.',
  trials: trials.map((trial) => ({
    cell: trial.cell,
    trialId: trial.result.trialId,
    success: trial.result.success,
    includedInCapability: trial.score.eligibility.includedInModelAggregate,
    durationMs: trial.result.durationMs,
    timing: trial.timing,
    metrics: trial.metrics,
    observedMlxPrefill: recoveredSummary(trial.cell.id),
    engineContext: trial.result.engineContext ?? null,
  })),
});
addJson(`${destination}/completion-audit.json`, audit);
addJson(`${destination}/native-provenance.json`, native);
addJson(`${destination}/scorecard-details.json`, {
  schemaVersion: 1,
  kind: 'scorecard-details',
  publicationId,
  complete: true,
  reviewedAt: audit.finalizedAt,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  counts,
  interpretation,
  mlxPrefillRecovery: {
    file: 'mlx-prefill-recovery.json',
    coverage: recovery.coverage,
    groups: recoveryGroups,
  },
  definition: campaign.definition,
  runtimeIdentity: campaign.identity,
  trials,
  publication: imported.audit,
  diagnostics,
  reports,
  evidence: {
    pathConvention:
      'Repository-relative archive references, not public download URLs. Structured trial evidence, all postmortems, review specifications, scores and diagnostics are embedded here. Raw transcripts, process logs, generated artifacts and binaries stay in the local archive. Source hashes identify original unsanitized evidence. Completion audit describes the campaign before publication.',
    sourceFiles: sourceHashes,
  },
});
addJson(`${destination}/verification.json`, {
  counts,
  repetitionsAllThree: true,
  originalEvidenceModified: false,
  mlxPrefillRecovery: {
    recoveredOn: recovery.recoveredOn,
    coverage: recovery.coverage,
    recordingsReparsed: true,
    sourceArchiveUnchanged: true,
  },
  frozenIdentityVerifiedAtCompletion: true,
  sourceFilesVerified: Object.keys(sourceHashes).length,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  schema: 'ScorecardDatasetSchema v1',
});
const publicTargets = new Map(
  Object.entries(reportFiles).map(([published, source]) => [
    `${campaignRoot}/${source}`,
    published,
  ]),
);
for (const [source, published] of Object.entries({
  'final-analysis.json': 'analysis.json',
  'codex-inline-judge.json': 'judging.json',
  'native-provenance.json': 'native-provenance.json',
  'completion-audit.json': 'completion-audit.json',
  'trials.csv': 'trials.csv',
}))
  publicTargets.set(`${campaignRoot}/${source}`, published);
const publicMarkdown = (text) =>
  sanitize(
    text.replace(/\]\(<?([^)>]+)>?\)/g, (match, href) => {
      if (/^(?:https?:|#)/.test(href)) return match;
      const path = href.startsWith('/') ? portable(href) : portable(`${campaignRoot}/${href}`);
      return `](${publicTargets.get(path) ?? 'scorecard-details.json'})`;
    }),
  );
for (const [name, text] of Object.entries(reports))
  files.set(
    `${destination}/${name}`,
    `${publicMarkdown(text)}\n\nPublication note: this is a portable copy of the completed campaign report. Individual trial evidence links open scorecard-details.json, which embeds all postmortems and retains original archive references. Statements about publication status describe the original completion checkpoint.\n`,
  );
// Keep the previous report available, while updating the main public report's
// interpretation and adding a separate observed-rate table. Original aggregate
// columns remain unknown for MLX rather than silently switching estimators.
files.set(`${destination}/original-report.md`, files.get(`${destination}/report.md`));
const originalPrefillClaim =
  'MLX logs prefill token counts without durations: **all MLX prefill rates are unknown**.';
assert(reports['report.md'].includes(originalPrefillClaim));
const recoveryTable = recoverySummary.slice(
  recoverySummary.indexOf('| Model |'),
  recoverySummary.indexOf('\n- '),
);
const revisedReport = files
  .get(`${destination}/report.md`)
  .replace(
    '\n\n',
    '\n\n**Publication revision, November 3:** MLX first-token prefill rates have now been recovered from all 258 original MLX recordings. The [original report](original-report.md) and trial archive remain unchanged; the additions below are partial observations, separate from aggregate request timings.\n\n',
  )
  .replace(
    originalPrefillClaim,
    'The original structured MLX metrics lack aggregate prefill rates and exact prefill durations. Rounded first-token rate observations have since been recovered from the recordings; these partial provider-turn observations appear separately below.',
  )
  .replaceAll('| Prefill t/s', '| Aggregate prefill t/s')
  .replaceAll('| Prefill coverage |', '| Aggregate prefill coverage |')
  .replace(
    'prefill **258/516** (every llama.cpp trial);',
    'aggregate prefill **258/516** (every llama.cpp trial); recovered observed prefill **258/258 MLX trials** (2,175 partial observations);',
  )
  .replace(
    '### Performance by target and suite',
    `### Recovered MLX observed prefill\n\n${recovery.method}\n\n${recoveryTable}\n\nExact MLX prefill durations and complete internal-request coverage remain unknown. These rates must not be directly ranked against llama.cpp aggregate prefill throughput. [Recovery method](mlx-prefill-recovery.md), [individual observations and source hashes](mlx-prefill-recovery.json), and [trial CSV](mlx-prefill-recovery.csv).\n\n### Performance by target and suite`,
  );
files.set(`${destination}/report.md`, revisedReport);
files.set(`${destination}/trials.csv`, sanitize(bytes(`${campaignRoot}/trials.csv`).toString()));
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId,
  regenerate:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-m5max-native-054-scorecard.mjs',
  check:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-m5max-native-054-scorecard.mjs --check',
  files: [...files].map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: sha(value),
  })),
});
for (const [name, value] of files) {
  assert(
    !/\/Users\/|Mikes-MacBook-Pro|\bBearer\s+[A-Za-z0-9._~-]{20,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      value,
    ),
    `Private path or possible credential in ${name}`,
  );
  const target = resolve(root, name);
  if (check) assert.equal(readFileSync(target, 'utf8'), value, `Publication drift: ${name}`);
  else {
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target) || readFileSync(target, 'utf8') !== value) writeFileSync(target, value);
  }
}
// Recheck original bytes after building the public copies.
for (const [path, hash] of Object.entries(sourceHashes))
  assert.equal(
    sha(readFileSync(resolve(root, path))),
    hash,
    `Source changed during publication: ${path}`,
  );
console.log(
  JSON.stringify({
    mode: check ? 'verified' : 'written',
    counts,
    files: files.size,
    sourceFilesVerified: Object.keys(sourceHashes).length,
  }),
);
