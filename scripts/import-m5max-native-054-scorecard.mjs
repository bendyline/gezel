#!/usr/bin/env node
// Publish completed, reviewed evidence. Never run inference or edit the source archive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  note: 'Completed M5 Max 128 GB comparison: 516 attempts, 349 passes, 165 model-classified failures and two preserved infrastructure exclusions. Every model/engine/scenario/suite has three repetitions. Native 0.1.54, generalist auto. Task measurements include all attempts; 215 bounded artifact reviews retain separate rubrics, including 80 failed trials. Twelve incompatible A/B specifications and one missing artifact receive no numeric score. MLX prefill, macOS GPU utilization and MLX granted context are unknown. Engine-specific quantization, speculative decoding, raw fixed scores, timing, tokens, memory and failure diagnoses are documented in the downloadable report.',
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
    'All attempts included regardless of success/eligibility. Actual in-trial engine-log rates, not low-token preflight probes. MLX decode is a median of pulse rates; llama.cpp is generated tokens divided by decode time. MLX prefill and granted context are unknown. macOS GPU utilization/memory are unavailable, not zero. System RAM is machine-wide; process RSS is sampled. First artifact records first write, not completed output.',
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
addJson(`${destination}/analysis.json`, analysis);
addJson(`${destination}/judging.json`, {
  ...ledger,
  trials: trials.map((trial) => ({ cell: trial.cell, ...trial.review })),
});
addJson(`${destination}/performance.json`, {
  schemaVersion: 1,
  publicationId,
  interpretation: interpretation.performance,
  coverage: audit.performanceCoverage,
  trials: trials.map((trial) => ({
    cell: trial.cell,
    trialId: trial.result.trialId,
    success: trial.result.success,
    includedInCapability: trial.score.eligibility.includedInModelAggregate,
    durationMs: trial.result.durationMs,
    timing: trial.timing,
    metrics: trial.metrics,
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
