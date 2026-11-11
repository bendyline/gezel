#!/usr/bin/env node
// Keep the stopped journals and the two unscored interruptions intact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = 'evals/runs/saluki-native-0.1.57-2026-11-03';
const continuation = `${archive}/continuation-2026-11-06`;
const publicationId = '2026-11-03-windows-saluki-native-0-1-57';
const destination = `docs/handboek/assets/scorecards/${publicationId}`;
const judgeId = 'claude-sonnet-5-5';
const check = process.argv.includes('--check');
const prepare = process.argv.includes('--prepare');
assert(process.argv.slice(2).every((arg) => ['--check', '--prepare'].includes(arg)));
assert(!(check && prepare));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const sourceFiles = {};
function portable(name) {
  const path = relative(root, resolve(root, name)).replaceAll('\\', '/');
  assert(!isAbsolute(path) && !path.startsWith('../'), 'Evidence outside checkout');
  return path;
}
function bytes(name, expected) {
  const path = portable(name);
  const value = readFileSync(resolve(root, path));
  const digest = sha(value);
  if (expected) assert.equal(digest, expected, `Evidence changed: ${path}`);
  sourceFiles[path] = digest;
  return value;
}
const read = (name, expected) =>
  JSON.parse(
    bytes(name, expected)
      .toString()
      .replace(/^\uFEFF/, ''),
  );
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
function observation(values) {
  const present = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return present.length
    ? {
        samples: present.length,
        median: median(present),
        min: Math.min(...present),
        max: Math.max(...present),
      }
    : undefined;
}

const overall = read(`${archive}/model-scorecard.json`);
const guard = read(`${archive}/final-evidence-validation.json`);
assert(guard.originalSealMatched);
for (const file of guard.reportingGuardFiles) bytes(file.path, file.sha256);
const seal = read(`${continuation}/original-evidence-seal.json`);
for (const file of seal.files) bytes(`${archive}/${file.path}`, file.sha256);
for (const trial of seal.trials) {
  bytes(`${trial.trialDir}/score.json`, trial.scoreSha256);
  bytes(`${trial.trialDir}/facts.json`, trial.factsSha256);
}
const original = read(`${archive}/campaign.json`);
const round3 = read(`${continuation}/round3/campaign.json`);
const identityComparison = read(`${continuation}/identity-comparison.json`);
assert(
  identityComparison.originalEvidenceUnchanged && identityComparison.otherIdentityComponentsEqual,
);
assert.deepEqual(identityComparison.identityChangedKeys, ['environmentHash']);
assert.equal(original.identity.environmentHash, identityComparison.originalEnvironmentHash);
assert.equal(round3.identity.environmentHash, identityComparison.newEnvironmentHash);
for (const key of Object.keys(original.identity).filter((key) => key !== 'environmentHash')) {
  assert.deepEqual(round3.identity[key], original.identity[key], `Frozen identity differs: ${key}`);
}
assert.equal(original.rows.length, 85);
assert.equal(round3.rows.length, 41);
const codex = read(`${archive}/codex-inline-judge.json`);
const offload = read(`${archive}/offload-frequency-audit.json`);
assert.equal(offload.trials.length, 128);
for (const trial of offload.trials) {
  bytes(`${trial.trialDir}/daemon.log`, trial.logSha256);
  assert(trial.gpuCpuPairs.length > 0);
  assert(
    trial.gpuCpuPairs.every((pair) => pair.gpu === 39 && pair.total === 64 && pair.cpu === 25),
  );
  assert(
    trial.launches.every(
      (launch) =>
        launch.contextPerSlot === 65536 && launch.slots === 1 && launch.kvCacheType === 'f16',
    ),
  );
}
const judgeManifest = read(`${archive}/claude-sonnet-5-5-review/manifest.json`);
for (const [file, digest] of Object.entries(judgeManifest.sourceHashes))
  bytes(`${archive}/${file}`, digest);
const judging = read(`${archive}/claude-sonnet-5-5-review/summary.json`);
assert.equal(judging.judgeModel, judgeId);
if (!prepare) {
  assert.equal(judging.status, 'complete', 'All Sonnet 5.5 reviews must finish before publication');
  assert.equal(judging.completed, 128);
  assert.equal(judging.failures.length, 0);
}
const reviews = new Map();
for (const review of judging.reviews) {
  assert(!reviews.has(review.cellId), 'Duplicate review');
  const entry = judgeManifest.entries.find((item) => item.cellId === review.cellId);
  assert(entry);
  const dir = `${archive}/claude-sonnet-5-5-review/${entry.reviewId}`;
  assert.deepEqual(read(`${dir}/review.json`), review);
  bytes(`${dir}/prompt.txt`, entry.promptSha256);
  bytes(`${dir}/evidence.json`, entry.evidenceSha256);
  const receipt = read(`${dir}/cli-output.json`);
  assert(!receipt.is_error);
  const answer = receipt.structured_output ?? JSON.parse(receipt.result);
  for (const key of ['status', 'scoreAxes', 'justification', 'limitations']) {
    assert.deepEqual(
      review[key],
      answer[key],
      `Review differs from CLI response: ${entry.cellId}/${key}`,
    );
  }
  assert.deepEqual(Object.keys(receipt.modelUsage), review.actualModelIds);
  assert(
    review.actualModelIds.length &&
      review.actualModelIds.every((id) => id === judgeId || id.startsWith(`${judgeId}-`)),
  );
  assert.equal(review.judgeProvider, 'anthropic-cli');
  assert.equal(review.judgeModel, judgeId);
  assert.equal(review.status, entry.status);
  assert.deepEqual(
    Object.keys(review.scoreAxes).sort(),
    entry.axes.map((axis) => axis.name).sort(),
  );
  assert(review.justification.length <= 400 && review.limitations.length <= 400);
  const scores = Object.values(review.scoreAxes);
  assert(scores.every((score) => Number.isInteger(score) && score >= 0 && score <= 10));
  assert.equal(review.meanScore, scores.length ? mean(scores) : null);
  for (const file of [...entry.artifactFiles, ...entry.contextFiles]) {
    assert(file.shownBytes <= 20480);
    bytes(file.path, file.sha256);
  }
  reviews.set(review.cellId, review);
}

const sharedNote =
  'Saluki 27B IQ2 Mix, native 0.1.57 CUDA on a 12 GB RTX 5070 Ti Laptop GPU. Every attempted task used hybrid placement: 39/64 dense FFN layers on GPU and 25 on CPU, context 65,536, one slot, f16 KV. The complete archive contains 128 of 129 planned attempts: 98 fixed passes, 27 eligible failures, one infrastructure exclusion, two unscored interruptions and one unattempted entry. Different environments and execution segments remain separate; three eligible repeats are not available for every entry. Task measurements are engine-log observations, not admission probes. Sonnet 5.5 reviews are advisory and use separate declared rubrics; original Codex reviews and fixed scores remain in the download.';
const segments = [
  {
    id: 'original',
    runId: `${publicationId}-original`,
    campaign: original,
    count: 3,
    scope: 'suite',
    expected: 85,
    note: `Original condition: 85 terminal trials, 71 passes, 13 eligible failures and one sandbox-unavailable exclusion. ${sharedNote}`,
  },
  {
    id: 'fanout',
    runId: '2026-11-06-windows-saluki-native-0-1-57-fanout',
    campaign: round3,
    count: 1,
    scope: 'subset',
    expected: 1,
    note: `Separate logical repetition-2 fanout attempt, interrupted without result, facts, score or final metrics. It is administratively excluded, never retried or scored as a model failure. The continuation points GEZEL_MXC_EXEC at the existing verified Microsoft-signed sandbox launcher. ${sharedNote}`,
  },
  {
    id: 'round3',
    runId: '2026-11-09-windows-saluki-native-0-1-57-round3',
    campaign: round3,
    count: 1,
    scope: 'subset',
    expected: 42,
    note: `Separate continuation condition: 41 terminal trials (27 passes, 14 eligible failures), one unscored interrupted gate-script attempt, one unattempted fanout. Local r1 cell IDs map to original logical r3. The sole environment change from the original is GEZEL_MXC_EXEC pointing at the existing verified Microsoft-signed sandbox launcher. The stopped journal's stale running field remains intact. ${sharedNote}`,
  },
];
const trials = overall.rows.map((row) => {
  const segment = row.baseline === 'original' ? segments[0] : segments[2];
  const raw = segment.campaign.rows.find((candidate) => candidate.cell.id === row.baselineCellId);
  assert(raw && raw.result.runDir.replaceAll('\\', '/') === row.runDir.replaceAll('\\', '/'));
  const result = read(`${row.runDir}/result.json`);
  const score = read(`${row.runDir}/score.json`);
  const metrics = read(`${row.runDir}/metrics.json`);
  const facts = read(`${row.runDir}/facts.json`);
  assert.deepEqual(score, raw.score);
  assert.deepEqual(metrics, raw.metrics);
  assert.equal(result.success, row.success);
  assert.equal(score.eligibility.includedInModelAggregate, row.eligible);
  assert.equal(facts.trialId, raw.result.trialId);
  return {
    cellId: row.cellId,
    baselineCellId: row.baselineCellId,
    suite: row.suite,
    scenario: row.scenario,
    repetition: row.repetition,
    runId: segment.runId,
    segment: segment.id,
    disposition: 'runner-terminal',
    eligible: row.eligible,
    success: row.success,
    result,
    score,
    facts,
    metrics,
    host: read(`${row.runDir}/host.json`),
    timing: raw.timing,
    modes: raw.modes,
    codexReview: row.advisory,
    sonnetReview: reviews.get(row.cellId) ?? null,
    postmortem: bytes(`${row.runDir}/postmortem.md`).toString(),
  };
});
for (const interruption of overall.interruptions) {
  const originalReview = codex.trials.find((review) => review.cellId === interruption.cellId);
  const entry = judgeManifest.entries.find((entry) => entry.cellId === interruption.cellId);
  const segment = interruption.cellId.startsWith('r2-') ? segments[1] : segments[2];
  const evidence = read(interruption.evidence);
  for (const file of evidence.snapshotFiles ?? []) bytes(file.path, file.sha256);
  for (const file of ['result.json', 'facts.json', 'score.json', 'metrics.json']) {
    assert(
      !existsSync(resolve(entry.trialDir, file)),
      `Unexpected terminal evidence: ${entry.cellId}/${file}`,
    );
  }
  trials.push({
    cellId: entry.cellId,
    baselineCellId: entry.baselineCellId,
    suite: 'complex-work',
    scenario: entry.scenarioId,
    repetition: segment.id === 'fanout' ? 2 : 3,
    runId: segment.runId,
    segment: segment.id,
    disposition: interruption.disposition,
    eligible: false,
    success: null,
    result: null,
    score: null,
    facts: null,
    metrics: null,
    administrativeExclusion: evidence,
    codexReview: originalReview,
    sonnetReview: reviews.get(entry.cellId) ?? null,
    postmortem: bytes(`${entry.trialDir}/postmortem.md`).toString(),
  });
}
assert.equal(trials.length, 128);
assert.equal(new Set(trials.map((trial) => trial.cellId)).size, 128);
assert.equal(trials.filter((trial) => trial.success).length, 98);
assert.equal(trials.filter((trial) => trial.eligible).length, 125);
const shards = segments.map((segment) => {
  const selected = trials.filter((trial) => trial.segment === segment.id);
  assert.equal(selected.length, segment.expected);
  const c = segment.campaign;
  const suites = segment.id === 'fanout' ? ['complex-work'] : c.definition.suites;
  const scenariosBySuite = Object.fromEntries(
    suites.map((suite) => [
      suite,
      segment.id === 'fanout'
        ? ['craftbook-author-fanout']
        : c.definition.scenarios.filter((spec) => spec.suite === suite).map((spec) => spec.id),
    ]),
  );
  const startedAt =
    segment.id === 'fanout' ? '2026-11-06T19:54:43.767Z' : c.rows[0].result.startedAt;
  const run = {
    id: segment.runId,
    scope: segment.scope,
    memoryCoverage: 'system-only',
    suites,
    scenariosBySuite,
    note: prepare ? `DRAFT: Sonnet review incomplete. ${segment.note}` : segment.note,
    provenance: {
      startedAt,
      device: { ...c.identity.device, label: 'Windows x64 · RTX 5070 Ti Laptop (12 GB)' },
      harnessCommit: c.identity.source.head,
      sourceHash: c.identity.source.sha256,
      serviceBuildHash: c.identity.service.sha256,
      catalogHash: c.identity.gilde.sha256,
      gildeVersion: c.identity.gilde.version,
      count: segment.count,
      judgeModelId: reviews.size ? `anthropic-cli/${judgeId}` : null,
      engineBuilds: {
        'llama-cpp':
          'Gezel native 0.1.57 · llama.cpp 0.8.0 build 11960 · CUDA 12.8 · 8642541b255bfb5dc39cd351a178be09013a55d6',
      },
    },
  };
  const results = suites.map((suite) => {
    const group = selected.filter((trial) => trial.suite === suite);
    const rubricIds = [
      ...new Set(
        group
          .filter((trial) => trial.sonnetReview?.status === 'scored')
          .map((trial) => trial.scenario),
      ),
    ].sort();
    const rss = observation(group.map((trial) => trial.metrics?.process?.peakRssMb));
    return {
      modelId: overall.modelId,
      label: 'Underdog Saluki (27B, IQ2 Mix)',
      engine: 'llama-cpp',
      tier: 'medium',
      parameterSize: '27B',
      quantization: 'IQ2 Mix',
      grantedContextTokens: 65536,
      runId: segment.runId,
      suiteId: suite,
      runtime: rss
        ? { contextTokens: 65536, peakMemoryMb: Math.round(rss.median), kvCacheType: 'f16' }
        : undefined,
      cells: scenariosBySuite[suite].map((scenario) => {
        const cells = group.filter((trial) => trial.scenario === scenario);
        const durations = cells
          .map((trial) => trial.result?.durationMs)
          .filter((value) => typeof value === 'number');
        return {
          scenarioId: scenario,
          trials: cells.length,
          successes: cells.filter((trial) => trial.success).length,
          nonModelFailures: cells.filter((trial) => !trial.eligible).length,
          medianDurationMs: durations.length ? median(durations) : undefined,
        };
      }),
      taskMeasurements: [
        {
          id: segment.id,
          label: `${segment.id} · all attempts`,
          trials: group.length,
          source: 'engine-log',
          outputTokensPerSec: observation(
            group.map((trial) => trial.metrics?.derived?.genTokensPerSec),
          ),
          prefillTokensPerSec: observation(
            group.map((trial) => trial.metrics?.derived?.promptTokensPerSec),
          ),
          durationMs: observation(group.map((trial) => trial.result?.durationMs)),
          peakRssMb: rss,
          peakGpuMemMb: observation(
            group.map((trial) =>
              trial.metrics?.gpu?.available ? trial.metrics.gpu.peakMemUsedMb : null,
            ),
          ),
          judgments: rubricIds.map((rubricId) => {
            const judgments = group
              .filter(
                (trial) => trial.scenario === rubricId && trial.sonnetReview?.status === 'scored',
              )
              .map((trial) => trial.sonnetReview);
            assert(
              judgments.every(
                (review) => JSON.stringify(review.axes) === JSON.stringify(judgments[0].axes),
              ),
            );
            return {
              rubricId,
              artifacts: judgments.length,
              meanScore: mean(judgments.map((review) => review.meanScore)),
              judgeModel: `anthropic-cli/${judgeId}`,
            };
          }),
          noArtifact: group.filter((trial) => trial.sonnetReview?.status === 'noArtifact').length,
          notApplicableReviews: group.filter(
            (trial) => trial.sonnetReview?.status === 'notApplicable',
          ).length,
          excludedReviews: group.filter((trial) => !trial.sonnetReview).length,
        },
      ],
    };
  });
  return ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [run], results });
});
const dataset = ScorecardDatasetSchema.parse({
  schemaVersion: 1,
  runs: shards.flatMap((shard) => shard.runs).reverse(),
  results: shards.flatMap((shard) => shard.results),
});
const files = new Map();
function sanitize(value) {
  if (typeof value === 'string')
    return value
      .replaceAll(`${root}\\`, '')
      .replaceAll(`${root.replaceAll('\\', '/')}/`, '')
      .replaceAll('mikeam-gdev', '<host>')
      .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"'<>]+/gi, '<home>')
      .replace(/\b[A-Za-z]:[\\/][^\s"'<>)]*/g, '<local-path>');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitize(key),
        key === 'hostname' ? '<host>' : sanitize(item),
      ]),
    );
  return value;
}
const addJson = (name, value) => files.set(name, `${JSON.stringify(sanitize(value), null, 2)}\n`);
const nativeVerification = read(`${archive}/native-verification.json`);
const historicalComparisons = read(`${archive}/final-historical-comparisons.json`);
const originalReports = Object.fromEntries(
  ['final-report.md', 'model-scorecard.md'].map((name) => [
    name,
    bytes(`${archive}/${name}`).toString(),
  ]),
);
const counts = {
  ...overall.coverage,
  passes: 98,
  eligibleFailures: 27,
  publishedNonModelFailures: 3,
  sonnetReviews: reviews.size,
  sonnetStatusCounts: judging.counts,
  originalCodexReviews: codex.trials.length,
};
for (const shard of shards) {
  addJson(`packages/core/src/scorecard/data/runs/${shard.runs[0].id}.json`, shard);
  addJson(`${destination}/runs/${shard.runs[0].id}.json`, shard);
}
addJson(`${destination}/scorecard.json`, dataset);
addJson(`${destination}/scorecard-details.json`, {
  schemaVersion: 1,
  publicationId,
  status: prepare ? 'draft-review-pending' : 'published-reviewed',
  counts,
  combinedDescriptiveSummary: overall.combined,
  suites: overall.suites,
  performance: overall.performance,
  hardwareFit: overall.hardwareFit,
  conditions: segments.map((segment) => ({
    runId: segment.runId,
    segment: segment.id,
    environmentHash: segment.campaign.identity.environmentHash,
    definition: segment.campaign.definition,
    note: segment.note,
  })),
  identityComparison,
  nativeVerification,
  trials,
  unattempted: overall.unattempted,
  historicalComparisons,
  interpretation: {
    fixed:
      '126 original runner verdicts and composites are preserved. Two interrupted attempts have null fixed scores and administrative exclusions; one entry was never started. Aggregate 98/125 is descriptive across the explicit environment boundary, not a single controlled baseline.',
    judging:
      'All attempted results receive independent Claude CLI Sonnet 5.5 source reviews. Numeric means use exact declared axes only, separately by rubric. Missing artifacts have no numeric score; outputs without declared axes receive qualitative narrative only. Source-only, at most 20 KiB per artifact and 20 KiB supporting context; no fresh rendering or runtime tests. Codex reviews remain separate. No judge opinion changes a fixed score.',
    performance:
      '126 terminal trials have complete engine-log rates and sampled memory metrics. Interrupted trials have no invented final metrics. Median output speed is a median of per-trial decode rates, not wall-clock task throughput or a token-weighted overall rate. CPU offload occurred in all 128 attempts. Shared GPU memory and paging were not measured.',
    paths:
      'Evidence paths are repository-relative archive references, not download URLs. Raw logs, prompts, artifacts, credentials and binaries remain local. File hashes identify original unsanitized evidence.',
  },
  evidence: { sourceFiles },
});
addJson(`${destination}/judging-sonnet-5-5.json`, judging);
addJson(`${destination}/judging-codex.json`, codex);
addJson(`${destination}/offload-frequency.json`, offload);
addJson(`${destination}/verification.json`, {
  publicationId,
  completeSonnetReview: reviews.size === 128,
  counts,
  originalEvidenceUnchanged: true,
  frozenIdentityVerified: true,
  segmentsKeptSeparate: true,
  newLocalInferenceCalls: 0,
  noFixedScoreChanges: true,
  sourceFilesVerified: Object.keys(sourceFiles).length,
  schema: 'ScorecardDatasetSchema v1',
  sourceFiles,
});
function publicMarkdown(text) {
  return sanitize(
    text
      .replace(/\]\(<[^>]+>\)/g, '](scorecard-details.json)')
      .replace(/\]\([A-Za-z]:[^)]+\)/g, '](scorecard-details.json)'),
  );
}
for (const [input, output] of [
  ['final-report.md', 'report.md'],
  ['model-scorecard.md', 'trial-scorecard.md'],
]) {
  files.set(
    `${destination}/${output}`,
    `Publication review supplement: the advisory judgments in the original report below are Codex's. The independent [Sonnet 5.5 summary](sonnet-review-summary.md) supplies the publication's rubric-specific quality measurements; [all Sonnet reviews](judging-sonnet-5-5.json) and [trial evidence](scorecard-details.json) retain the details. Fixed scores are unchanged. Individual local evidence links open the evidence companion.\n\n${publicMarkdown(originalReports[input])}\n`,
  );
}
const reviewRows = shards.flatMap((shard) =>
  shard.results.flatMap((result) =>
    result.taskMeasurements.flatMap((group) =>
      group.judgments.map(
        (judge) =>
          `| ${group.id} | ${result.suiteId} | ${judge.rubricId} | ${judge.artifacts} | ${judge.meanScore.toFixed(2)} |`,
      ),
    ),
  ),
);
files.set(
  `${destination}/sonnet-review-summary.md`,
  `# Claude CLI Sonnet 5.5 artifact review\n\n${reviews.size}/128 attempted results reviewed. ${judging.counts.scored ?? 0} have numeric scores on their exact declared axes; ${judging.counts.notApplicable ?? 0} have qualitative reviews without applicable numeric axes; ${judging.counts.noArtifact ?? 0} record absent declared artifacts. The one unattempted entry has nothing to judge. Every completed review's CLI receipt identifies ${judgeId}; no fallback was used.\n\nThe independent review withheld prior scores and model identity where practical. Each artifact was capped at 20 KiB, with up to 20 KiB of supporting context. Sonnet inspected source text without rendering or execution. Its per-result limitations identify missing context and unverified runtime claims. These are advisory quality scores, separate from fixed task outcomes and the original Codex reviews. Different rubrics and execution segments are kept separate below.\n\n| Segment | Task set | Rubric | Scored artifacts | Mean / 10 |\n|---|---|---|---:|---:|\n${reviewRows.join('\n')}\n\n[Every review with axes and justification](judging-sonnet-5-5.json), [fixed scores and both judges by trial](scorecard-details.json), [original Codex reviews](judging-codex.json), and [campaign report](report.md).\n`,
);
files.set(
  `${destination}/README.md`,
  `# Saluki native 0.1.57 scorecard\n\n${prepare ? '**DRAFT: Claude Sonnet 5.5 judging is incomplete; these files are staged locally and not registered.**\n\n' : ''}This download records 128 attempts from 129 planned entries on a Windows laptop with a 12 GB RTX 5070 Ti. It preserves three separately journaled segments and the original versus continuation environment boundary. There are 126 terminal verdicts, two administratively excluded unscored interruptions, and one unattempted entry.\n\n[Scorecard](scorecard.json), [all trial evidence](scorecard-details.json), [report](report.md), [trial table](trial-scorecard.md), [Sonnet reviews](judging-sonnet-5-5.json), [original Codex reviews](judging-codex.json), [offload audit](offload-frequency.json), and [verification](verification.json) are included. No raw prompts, transcripts, credentials or model weights are published. Archive paths in structured evidence are references, not public URLs.\n\nCPU offload occurred in 128/128 attempts: 39/64 dense FFN layers on GPU and 25 on CPU. The 126 completed trials had a median decode rate of 8.35 tokens/s (range 2.57–9.41). This is generation speed during decoding, not end-to-end output divided by task wall time. Context was 65,536 tokens with one slot and f16 KV. Shared GPU memory and paging were not measured.\n\nThe source-only Sonnet 5.5 pass uses exact declared rubrics, integer scores, and a 20 KiB cap per artifact. Missing artifacts and results without applicable axes have no invented numeric scores. Fixed capability scores remain unchanged; qualitative reviews are advisory. Separate rubrics and judges are never averaged into one quality score.\n\nRegenerate with \`node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-saluki-native-057-scorecard.mjs\`, then \`node scripts/gen-scorecard-barrel.mjs\`. Add \`--check\` to the importer to verify byte-for-byte reproducibility. Publication refuses incomplete Sonnet coverage. \`--prepare\` writes a draft under the local campaign archive only.\n`,
);
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId,
  sourceFiles,
  files: [...files].map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: sha(value),
  })),
});
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
    : [];
}
for (const [name, value] of files) {
  const contents = name.endsWith('.json') ? strings(JSON.parse(value)) : [value];
  assert(
    contents.every((text) => !/\b[A-Za-z]:[\\/]|mikeam-gdev/.test(text)),
    `Private path in ${name}`,
  );
  assert(
    contents.every(
      (text) => !/\bBearer\s+[A-Za-z0-9._~-]{20,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/.test(text),
    ),
    `Possible credential in ${name}`,
  );
  const target = resolve(root, prepare ? `${archive}/publication-prepared/${name}` : name);
  if (check) assert.equal(readFileSync(target, 'utf8'), value, `Publication drift: ${name}`);
  else {
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target) || readFileSync(target, 'utf8') !== value) writeFileSync(target, value);
  }
}
console.log(
  JSON.stringify({
    mode: prepare ? 'draft-prepared' : check ? 'verified' : 'written',
    counts,
    files: files.size,
    sourceFilesVerified: Object.keys(sourceFiles).length,
  }),
);
