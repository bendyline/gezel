#!/usr/bin/env node
// Export completed evidence only. Never run inference, change gates or rescore trials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicationId = '2026-10-27-windows-gemma4-12b-native-0-1-54';
const sourceRoot = `evals/runs/scorecard-${publicationId}`;
const destination = `docs/handboek/assets/scorecards/${publicationId}`;
const shardPath = `packages/core/src/scorecard/data/runs/${publicationId}.json`;
const check = process.argv.includes('--check');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
const bytes = (name, expected) => {
  const value = readFileSync(resolve(root, sourceRoot, name));
  const hash = sha(value);
  if (expected) assert.equal(hash, expected, `Evidence changed: ${name}`);
  sourceHashes[name] = hash;
  return value;
};
const read = (name, expected) => JSON.parse(bytes(name, expected));
const source = read('final-accounting.json');
const launch = read('launch-provenance.json', source.evidenceHashes['launch-provenance.json']);
const plan = read('judge-plan.json', source.evidenceHashes['judge-plan.json']);
const runtime = read(
  'posthoc-runtime/summary.json',
  source.evidenceHashes['posthoc-runtime/summary.json'],
);
read('eligibility-review.json', source.evidenceHashes['eligibility-review.json']);
assert.equal(source.status, 'accounted');
assert.deepEqual(source.coverage, {
  plannedTrials: 129,
  terminalTrials: 129,
  suiteScenarioCells: 43,
  distinctScenarioIds: 41,
  trialsPerCell: 3,
});
assert.equal(new Set(source.trials.map((trial) => trial.trialId)).size, 129);
assert.equal(source.allTrials.rawPasses, 89);
assert.equal(source.allTrials.eligibleCount, 116);
assert.equal(runtime.passed, 9);
assert.equal(runtime.unavailable, 0);
assert(runtime.sourceChecks.every((entry) => entry.matchesLaunch));

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const observation = (values) => {
  assert(values.length && values.every((n) => Number.isFinite(n) && n >= 0));
  return {
    samples: values.length,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
};
const rubricId = (trial) =>
  trial.judge.rubric === 'default-html' ? 'default-html-v1' : trial.scenarioId;
const trials = source.trials.map((trial) => {
  const raw = Object.fromEntries(
    Object.entries(trial.evidenceHashes).map(([name, hash]) => [
      name,
      read(`${trial.runDir}/${name}`, hash),
    ]),
  );
  const result = raw['result.json'];
  const score = raw['score.json'];
  const judge = raw['codex-inline-judge.json'];
  const metrics = raw['metrics.json'];
  assert.equal(result.trialId, trial.trialId);
  assert.equal(result.success, trial.rawSuccess);
  assert.equal(result.durationMs, trial.durationMs);
  assert.equal(score.rubricVersion, 'eval-run-fixed-v1');
  assert.equal(score.composite, trial.rawFixedComposite);
  assert.equal(judge.status, trial.judgmentStatus);
  assert.equal(judge.meanScore, trial.judgmentMean);
  assert.deepEqual(judge.scoreAxes, trial.judge.scoreAxes);
  assert(['judged', 'not-applicable', 'noArtifact'].includes(judge.status));
  if (judge.status === 'judged') {
    assert.equal(judge.judgeProvider, 'codex-inline');
    assert.equal(judge.judgeModel, 'current-session');
    assert(Object.values(judge.scoreAxes).every((n) => Number.isInteger(n) && n >= 0 && n <= 10));
    assert(Math.abs(mean(Object.values(judge.scoreAxes)) - judge.meanScore) < 1e-10);
    assert(judge.inputBytes <= 20480 && judge.justification.length <= 400);
    bytes(`${trial.runDir}/${judge.artifactPath}`, judge.artifactSha256);
    for (const context of judge.contextArtifacts ?? [])
      bytes(`${trial.runDir}/${context.path}`, context.sha256);
  }
  if (trial.runtime) {
    const report = read(trial.runtime.evidence);
    bytes(`${trial.runDir}/${report.artifactPath}`, report.artifactSha256);
    assert(report.runtimePassed && report.gateReport.ran);
  }
  assert.equal(metrics.usage.source, 'engine-log');
  assert.equal(metrics.derived.genTokensPerSec, trial.performance.nativeDecodeTokensPerSec);
  assert.equal(metrics.derived.promptTokensPerSec, trial.performance.nativePrefillTokensPerSec);
  assert.equal(metrics.usage.totalInputTokens, trial.performance.inputTokens);
  assert.equal(metrics.usage.totalOutputTokens, trial.performance.outputTokens);
  assert.equal(metrics.process.peakRssMb, trial.performance.peakRssMb);
  assert.equal(metrics.gpu.peakMemUsedMb, trial.performance.peakGpuMemoryMb);
  return {
    ...trial,
    rubricId: judge.status === 'judged' ? rubricId(trial) : null,
    judge,
    fixedScore: score,
    performance: {
      ...trial.performance,
      durationMs: trial.durationMs,
      derived: metrics.derived,
      usage: metrics.usage,
      process: metrics.process,
      gpu: metrics.gpu,
      systemMemory: metrics.systemMemory,
    },
  };
});
const counts = {
  planned: 129,
  recorded: trials.length,
  rawPasses: trials.filter((t) => t.rawSuccess).length,
  capabilityExclusions: trials.filter((t) => !t.finalCapabilityEligible).length,
  judged: trials.filter((t) => t.judgmentStatus === 'judged').length,
  notApplicable: trials.filter((t) => t.judgmentStatus === 'not-applicable').length,
  noArtifact: trials.filter((t) => t.judgmentStatus === 'noArtifact').length,
  excludedReviews: trials.filter((t) => t.judge.aggregateEligibility === 'excluded-rubric-mismatch')
    .length,
  performanceRecords: trials.length,
  pending: 0,
};
assert.deepEqual(counts, {
  planned: 129,
  recorded: 129,
  rawPasses: 89,
  capabilityExclusions: 13,
  judged: 59,
  notApplicable: 70,
  noArtifact: 0,
  excludedReviews: 3,
  performanceRecords: 129,
  pending: 0,
});

// Keep the original admission probe distinct from task observations.
const prior = JSON.parse(readFileSync(resolve(root, shardPath), 'utf8'));
const run = {
  ...prior.runs[0],
  scope: 'suite',
  memoryCoverage: 'system-only',
  provenance: {
    ...prior.runs[0].provenance,
    startedAt: launch.startedAt,
    harnessCommit: launch.identity.source.head,
    sourceHash: launch.identity.source.sha256,
    serviceBuildHash: launch.identity.service.sha256,
    catalogHash: launch.identity.gilde.sha256,
    gildeVersion: launch.identity.gilde.version,
    judgeModelId: 'codex-inline/current-session',
    engineBuilds: {
      'llama-cpp': `CUDA ${launch.native.cudaBuild.cudaToolkit} / ${launch.native.cudaBuild.revision} / native ${launch.native.release}`,
    },
  },
  note: 'All four suites completed: 129 attempts, exactly three per suite/scenario, 89 raw passes. The eligible subset is 89/116 after 12 required-tool exclusions and one unevaluable authored gate; that last defect was model-authored, not a machine outage. All attempts remain in task performance. There are 59 artifact judgments: 56 included and three excluded for a mismatched A/B rubric, plus 70 tasks without an applicable rubric. Different rubrics are kept separate. Nine deferred canonical browser checks passed on the unchanged saved artifacts. Reviews assessed source and artifacts, not rendered visual polish. Admission-probe speeds remain separate from task medians. See the October 28 Windows Gemma 4 report download for exact axes, rationales, raw scores, exclusions, tokens, GPU telemetry and provenance.',
};
const results = run.suites.map((suiteId) => {
  const selected = trials.filter((trial) => trial.suiteId === suiteId);
  const eligibleReviews = selected.filter(
    (trial) =>
      trial.judgmentStatus === 'judged' &&
      trial.judge.aggregateEligibility !== 'excluded-rubric-mismatch',
  );
  const original = prior.results.find((result) => result.suiteId === suiteId);
  assert(original);
  const { judge: _oldJudge, ...result } = original;
  return {
    ...result,
    label: launch.model.manifest.name,
    quantization: launch.model.manifest.quantization,
    taskMeasurements: [
      {
        id: 'complete-run',
        label: 'All trials · native 0.1.54',
        trials: selected.length,
        source: 'engine-log',
        outputTokensPerSec: observation(
          selected.map((t) => t.performance.nativeDecodeTokensPerSec),
        ),
        prefillTokensPerSec: observation(
          selected.map((t) => t.performance.nativePrefillTokensPerSec),
        ),
        durationMs: observation(selected.map((t) => t.durationMs)),
        peakRssMb: observation(selected.map((t) => t.performance.peakRssMb)),
        peakGpuMemMb: observation(selected.map((t) => t.performance.peakGpuMemoryMb)),
        judgments: [...new Set(eligibleReviews.map((t) => t.rubricId))].sort().map((id) => {
          const group = eligibleReviews.filter((t) => t.rubricId === id);
          assert(
            group.every(
              (t) =>
                JSON.stringify(Object.keys(t.judge.scoreAxes)) ===
                JSON.stringify(Object.keys(group[0].judge.scoreAxes)),
            ),
          );
          return {
            rubricId: id,
            meanScore: mean(group.map((t) => t.judge.meanScore)),
            artifacts: group.length,
            judgeModel: 'codex-inline/current-session',
          };
        }),
        noArtifact: selected.filter((t) => t.judgmentStatus === 'noArtifact').length,
        excludedReviews: selected.filter(
          (t) => t.judge.aggregateEligibility === 'excluded-rubric-mismatch',
        ).length,
        notApplicableReviews: selected.filter((t) => t.judgmentStatus === 'not-applicable').length,
      },
    ],
    cells: run.scenariosBySuite[suiteId].map((scenarioId) => {
      const group = selected.filter((t) => t.scenarioId === scenarioId);
      assert.equal(group.length, 3);
      return {
        scenarioId,
        trials: 3,
        successes: group.filter((t) => t.rawSuccess).length,
        nonModelFailures: group.filter((t) => !t.finalCapabilityEligible).length,
        medianDurationMs: median(group.map((t) => t.durationMs)),
      };
    }),
  };
});
const dataset = ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [run], results });
const details = {
  schemaVersion: 1,
  kind: 'scorecard-details',
  publicationId,
  complete: true,
  sourceGeneratedAt: source.generatedAt,
  sourceReportSha256: sourceHashes['final-accounting.json'],
  newInferenceCalls: 0,
  counts,
  provenance: {
    ...run.provenance,
    runtimeHash: launch.identity.runtime.sha256,
    native: launch.native,
    model: launch.model,
  },
  judging: {
    provider: 'codex-inline',
    model: 'current-session',
    exactModelVersion: null,
    inputLimitBytes: 20480,
    blinding: 'Unblinded artifact/source review; advisory, with scenario rubrics kept separate.',
    note: 'Original judgment text is preserved, including comments written before deferred browser validation. Final runtime outcomes appear separately.',
    scenarioRubrics: plan.scenarios.map(({ suiteId, scenarioId, judge, fallback }) => ({
      suiteId,
      scenarioId,
      judge,
      fallback,
    })),
  },
  performance: {
    allTrials: source.allTrials.performance,
    bySuite: Object.fromEntries(
      Object.entries(source.suites).map(([id, suite]) => [id, suite.performance]),
    ),
    wallClockMs: source.wallClockMs,
    notes: [
      'Native engine-log token counters remain separate from provider counters.',
      'Throughput excludes scheduling and tools; wall time includes them.',
      'RSS is system memory; VRAM is measured separately. MB fields are MiB. All attempts, including excluded attempts, are retained.',
    ],
  },
  runtimeValidation: runtime,
  capability: {
    rawPasses: 89,
    rawTrials: 129,
    eligiblePasses: 89,
    eligibleTrials: 116,
    fixedMean: source.allTrials.rawFixedComposite.mean,
    eligibleFixedMean: source.allTrials.eligibleFixedComposite.mean,
  },
  trials,
  evidence: {
    availability:
      'Raw transcripts and artifacts remain in the local evaluation archive; they are not included in this download.',
    pathConvention:
      'Evidence paths are relative to the archived run. Workstation paths and hostname are redacted.',
    sourceFiles: sourceHashes,
  },
};
const sanitize = (value) => {
  if (typeof value === 'string')
    return value
      .replaceAll(`${root.replaceAll('\\', '/')}/`, '')
      .replaceAll(`${root}\\`, '')
      .replaceAll(launch.hostname, '<host>')
      .replace(/\b[A-Za-z]:[\\/][^\s"'<>)]*/g, '<local-path>');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitize(k), sanitize(v)]));
  return value;
};
const files = new Map();
const addJson = (name, value) => files.set(name, `${JSON.stringify(sanitize(value), null, 2)}\n`);
addJson(shardPath, dataset);
addJson(`${destination}/scorecard.json`, dataset);
addJson(`${destination}/scorecard-details.json`, details);
addJson(`${destination}/verification.json`, {
  sourceReportSha256: details.sourceReportSha256,
  counts,
  cells: 43,
  trialsPerCell: 3,
  runtimePassed: 9,
  evidenceFilesVerified: Object.keys(sourceHashes).length,
  sourceEvidenceModified: false,
  newInferenceCalls: 0,
});
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId,
  regenerate:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-gemma4-native-054-scorecard.mjs',
  check:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-gemma4-native-054-scorecard.mjs --check',
  files: [...files].map(([name, value]) => ({
    path: name,
    bytes: Buffer.byteLength(value),
    sha256: sha(value),
  })),
});
for (const [name, value] of files) {
  assert(!/\b[A-Za-z]:[\\/]|mikeam-gdev/.test(value), `Workstation path in ${name}`);
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
  JSON.stringify(
    {
      mode: check ? 'verified' : 'written',
      counts,
      files: files.size,
      evidenceFilesVerified: Object.keys(sourceHashes).length,
    },
    null,
    2,
  ),
);
