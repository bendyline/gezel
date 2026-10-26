#!/usr/bin/env node
// Export the closed five-model campaign. Never run inference or rescore evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = 'evals/runs/scorecard-2026-10-25-m5max-bolt-five';
const publicationId = '2026-10-25-m5max-bolt-five';
const destination = `docs/handboek/assets/scorecards/${publicationId}`;
const check = process.argv.includes('--check');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
const portable = (path) => {
  const name = relative(root, resolve(root, path)).replaceAll('\\', '/');
  assert(!isAbsolute(name) && !name.startsWith('../'), 'Evidence outside checkout');
  return name;
};
const bytes = (path, expected) => {
  const name = portable(path);
  const value = readFileSync(resolve(root, name));
  const hash = sha(value);
  if (expected) assert.equal(hash, expected, `Evidence changed: ${name}`);
  sourceHashes[name] = hash;
  return value;
};
const read = (path, expected) => JSON.parse(bytes(path, expected));
const source = read(`${sourceRoot}/scorecard-data.json`);
assert(source.complete);
assert.deepEqual(source.counts, {
  planned: 165,
  recorded: 165,
  reviewed: 165,
  passed: 110,
  noArtifact: 7,
  excludedPriorJudgments: 6,
});
const campaign = read(
  `${sourceRoot}/isolated/campaign.json`,
  source.sourceHashes['isolated/campaign.json'],
);
const protocol = read(
  `${sourceRoot}/judge-protocol.json`,
  source.sourceHashes['judge-protocol.json'],
);
const journal = read(
  `${sourceRoot}/codex-inline-judge.json`,
  source.sourceHashes['codex-inline-judge.json'],
);
const installed = read(`${sourceRoot}/current-installed-models.json`);
const judgments = new Map(
  journal.judgments.filter((j) => j.cohort === 'isolated').map((j) => [j.cellId, j]),
);
assert.equal(judgments.size, 165);
assert.equal(new Set(source.trials.map((t) => t.id)).size, 165);
assert.equal(new Set(source.trials.map((t) => t.trialId)).size, 165);
assert.equal(campaign.rows.length, 165);
assert(!campaign.running && !campaign.stopped);

// Public records retain archive-relative evidence references, never workstation paths.
const sanitize = (value) => {
  if (typeof value === 'string') {
    return value
      .replaceAll(`${root}/`, '')
      .replace(/(?:\/private)?\/var\/folders\/[^\s"'<>)]*/g, '<tmp>')
      .replace(/(?:\/private)?\/tmp\/[^\s"'<>)]*/g, '<tmp>')
      .replace(/\/Users\/[^/\s"'<>]+/g, '<home>')
      .replaceAll('Mikes-MacBook-Pro.local', '<host>');
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitize(k), sanitize(v)]));
  return value;
};
const observation = (stat, scale = 1) =>
  stat.n
    ? {
        samples: stat.n,
        median: stat.median * scale,
        min: stat.min * scale,
        max: stat.max * scale,
      }
    : undefined;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const modelMetadata = {};
const trials = source.trials.map((trial) => {
  const raw = Object.fromEntries(
    Object.entries(trial.provenance).map(([name, hash]) => [
      name,
      read(`${trial.runDir}/${name}`, hash),
    ]),
  );
  const facts = raw['facts.json'];
  const result = raw['result.json'];
  const score = raw['score.json'];
  const judge = judgments.get(trial.id);
  assert.deepEqual(raw['codex-inline-judge.json'], judge);
  assert.equal(result.trialId, trial.trialId);
  assert.equal(result.success, trial.success);
  assert.equal(result.durationMs, Math.round(trial.metrics.wallSeconds * 1000));
  assert.equal(score.composite, trial.fixedComposite);
  assert.equal(score.eligibility.failureClass, trial.failureClass);
  assert(score.eligibility.includedInModelAggregate && judge.includedInFinalComparison);
  assert.equal(judge.protocolSha256, source.sourceHashes['judge-protocol.json']);
  assert.equal(judge.meanScore, trial.judgeMean);
  assert.deepEqual(judge.scoreAxes, trial.judgeAxes);
  assert.equal(facts.perf.derived.genTokensPerSec, trial.metrics.decodeTokensPerSecond);
  assert.equal(facts.perf.derived.promptTokensPerSec, trial.metrics.prefillTokensPerSecond);
  if (judge.status === 'noArtifact') {
    assert.equal(judge.scoreAxes, null);
    assert.equal(judge.meanScore, null);
    assert.equal(judge.includedInArtifactMean, false);
  } else {
    assert.equal(judge.status, 'judged');
    assert.equal(judge.includedInArtifactMean, true);
    assert.deepEqual(
      Object.keys(judge.scoreAxes).sort(),
      Object.keys(protocol.axes[judge.rubricId]).sort(),
    );
    assert(Object.values(judge.scoreAxes).every((n) => Number.isInteger(n) && n >= 0 && n <= 10));
    assert.equal(mean(Object.values(judge.scoreAxes)), judge.meanScore);
    assert(judge.justification.length <= 400);
  }
  assert(judge.artifacts.reduce((n, a) => n + a.reviewedBytes, 0) <= protocol.inputLimitBytes);
  for (const artifact of judge.artifacts) bytes(artifact.path, artifact.sha256);
  const manifest = installed[`${trial.provider}/${trial.model}`];
  assert(manifest);
  modelMetadata[trial.model] ??= {
    label: manifest.name,
    tier: facts.modelTier,
    installedManifest: manifest,
    engine: trial.provider,
    frameworkBuild: facts.host.frameworkBuild,
    decodeMeasurement: trial.provider === 'mlx' ? 'active-stream-estimate' : 'request-derived',
    contextNote:
      'Installed manifest context is the declared model limit, not proof of the context granted to every session.',
  };
  return {
    ...trial,
    runId: publicationId,
    includedInScorecard: true,
    outcome: facts.outcome,
    fixedScore: {
      rubricVersion: score.rubricVersion,
      composite: score.composite,
      band: score.band,
      axes: Object.fromEntries(
        Object.entries(score.axes).map(([name, axis]) => [
          name,
          {
            score: axis.score,
            ruleId: axis.ruleId,
            summary: axis.summary,
            ...(axis.adjustments ? { adjustments: axis.adjustments } : {}),
          },
        ]),
      ),
      eligibility: score.eligibility,
    },
    judge,
    performance: {
      ...trial.metrics,
      decodeMeasurement: trial.provider === 'mlx' ? 'active-stream-estimate' : 'request-derived',
      gpuMemoryMb: null,
      gpuUtilizationPercent: null,
      engineGenerationCoverage:
        trial.provider === 'mlx' ? 'incomplete-periodic-sampling' : 'available-request-logs',
      trackerCoverage: 'incomplete-separate-stream',
    },
    timing: facts.timing,
  };
});
const run = {
  id: publicationId,
  scope: 'suite',
  memoryCoverage: 'full',
  suites: ['core'],
  scenariosBySuite: { core: campaign.definition.scenarios.map((s) => s.id) },
  provenance: {
    startedAt: trials.map((t) => t.startedAt).sort()[0],
    device: campaign.identity.device,
    harnessCommit: campaign.identity.source.head,
    sourceHash: campaign.identity.source.sha256,
    serviceBuildHash: campaign.identity.service.sha256,
    catalogHash: campaign.identity.gilde.sha256,
    gildeVersion: campaign.identity.gilde.version,
    count: 3,
    judgeModelId: null,
    engineBuilds: { 'llama-cpp': 'Metal build 11669 / 620d2225cc436ab0b001e3200e590e3b286ef9ab' },
  },
  note: 'Complete five-model core comparison: 165 trials, 110 raw passes, 55 task failures; 158 artifact reviews and seven missing outputs. Bolt uses llama.cpp Metal; Gemma and Qwen use MLX. Four advisory rubrics remain separate. Bolt decode is request-derived; MLX output is an active-stream estimate and prefill is unavailable. Task observations include failed attempts and recovery, not admission probes. Known framework and evaluator defects remain in the frozen raw results; a gate pass does not certify artifact quality. See the October 25 M5 Max Bolt comparison JSON download for all judgments, performance coverage and 32 findings. Earlier old-build and interrupted trials are excluded.',
};
const dataset = ScorecardDatasetSchema.parse({
  schemaVersion: 1,
  runs: [run],
  results: source.models.map((model) => {
    const metadata = modelMetadata[model.model];
    const selected = trials.filter((t) => t.targetId === model.id);
    assert.equal(selected.length, 33);
    assert.equal(selected.filter((t) => t.success).length, model.passed);
    for (const [rubricId, q] of Object.entries(model.qualityByRubric)) {
      const present = selected.filter((t) => t.rubricId === rubricId && t.judgeStatus === 'judged');
      assert.equal(present.length, q.judged);
      assert(Math.abs(mean(present.map((t) => t.judgeMean)) - q.mean) < 1e-12);
    }
    return {
      modelId: model.model,
      label: metadata.label,
      tier: metadata.tier,
      engine: model.provider,
      quantization: metadata.installedManifest.quantization,
      runId: publicationId,
      suiteId: 'core',
      taskMeasurements: [
        {
          id: 'isolated',
          label:
            model.provider === 'mlx'
              ? 'Frozen run · MLX sampled decode estimate'
              : 'Frozen run · llama.cpp request timings',
          trials: 33,
          source: 'engine-log',
          outputTokensPerSec: observation(model.performance.decodeTokensPerSecond),
          prefillTokensPerSec: observation(model.performance.prefillTokensPerSecond),
          durationMs: observation(model.performance.wallSeconds, 1000),
          peakRssMb: observation(model.performance.peakProcessRssMb),
          judgments: Object.entries(model.qualityByRubric).map(([rubricId, q]) => ({
            rubricId,
            meanScore: q.mean,
            artifacts: q.judged,
            judgeModel: 'codex-inline/current-session',
          })),
          noArtifact: model.noArtifact,
          excludedReviews: 0,
        },
      ],
      cells: run.scenariosBySuite.core.map((scenarioId) => {
        const group = selected.filter((t) => t.scenario === scenarioId);
        assert.equal(group.length, 3);
        const durations = group
          .map((t) => Math.round(t.metrics.wallSeconds * 1000))
          .sort((a, b) => a - b);
        return {
          scenarioId,
          trials: 3,
          successes: group.filter((t) => t.success).length,
          nonModelFailures: 0,
          medianDurationMs: durations[1],
        };
      }),
    };
  }),
});
const roleSensitivity = read(`${sourceRoot}/canonical-role-sensitivity.json`);
const artifactTiming = read(`${sourceRoot}/artifact-timing-audit.json`);
assert.equal(roleSensitivity.reviewedCampaignRows, 165);
assert.equal(artifactTiming.recordedTrials, 165);
const details = {
  schemaVersion: 1,
  kind: 'scorecard-details',
  publicationId,
  scorecardFile: 'scorecard.json',
  sourceReport: `${sourceRoot}/scorecard-data.json`,
  sourceReportSha256: sourceHashes[`${sourceRoot}/scorecard-data.json`],
  sourceGeneratedAt: source.createdAt,
  complete: true,
  newInferenceCalls: 0,
  counts: { ...source.counts, failed: 55, scoredArtifacts: 158, pendingReviews: 0 },
  provenance: {
    ...run.provenance,
    runtimeHash: campaign.identity.runtime.sha256,
    environmentHash: campaign.identity.environmentHash,
    boltRevision: '1db54d5b12533ff1bcaa8e42cf4c667988a1f1be',
    boltRevisionVerifiedAt: '2026-10-25',
  },
  modelMetadata,
  judging: {
    ...protocol,
    exactJudgeModelVersion: null,
    pending: 0,
    blinding: 'Unblinded regression triage; advisory current-session judgments.',
    aggregatesByModelAndRubric: source.models.map((m) => ({
      modelId: m.model,
      targetId: m.id,
      rubrics: m.qualityByRubric,
    })),
    missingOutputs: trials.filter((t) => t.judgeStatus === 'noArtifact').map((t) => t.id),
  },
  performance: {
    aggregatesByModel: source.models.map((m) => ({
      modelId: m.model,
      targetId: m.id,
      metrics: m.performance,
      successfulWallSeconds: m.successfulWallSeconds,
    })),
    notes: source.measurementNotes,
    metricUnits: {
      wallSeconds: 'seconds',
      firstTokenSeconds: 'seconds',
      firstToolSeconds: 'seconds',
      firstArtifactSeconds: 'seconds',
      decodeTokensPerSecond: 'tokens/second',
      prefillTokensPerSecond: 'tokens/second',
      peakProcessRssMb: 'MiB',
    },
  },
  models: source.models,
  scenarioRows: source.scenarioRows,
  trials,
  excludedPriorJudgments: journal.judgments.filter((j) => j.cohort !== 'isolated'),
  diagnostics: {
    roleSensitivity,
    artifactTiming,
    findingsCount: 32,
    note: 'Sensitivity probes never replace raw verdicts, scores or timings. Presence of a defect is not proof it was introduced by recent updates.',
  },
  reportMarkdown: bytes(`${sourceRoot}/REPORT.md`).toString(),
  regressionNotesMarkdown: bytes(`${sourceRoot}/REGRESSION-NOTES.md`).toString(),
  boltRevisionMarkdown: bytes(`${sourceRoot}/BOLT-REVISION.md`).toString(),
  evidence: {
    availability:
      'Retained local evaluation archive; raw transcripts, generated artifacts and credentials are not included in this download.',
    pathConvention:
      'Repository-relative archive paths; Markdown evidence links refer to the retained campaign directory, not public downloads. Workstation paths and hostname are redacted.',
    sourceFiles: sourceHashes,
  },
};
const files = new Map();
const addJson = (path, value) => files.set(path, `${JSON.stringify(sanitize(value), null, 2)}\n`);
addJson(`packages/core/src/scorecard/data/runs/${publicationId}.json`, dataset);
addJson(`${destination}/runs/${publicationId}.json`, dataset);
addJson(`${destination}/scorecard.json`, dataset);
addJson(`${destination}/scorecard-details.json`, details);
addJson(`${destination}/verification.json`, {
  sourceReportSha256: details.sourceReportSha256,
  counts: details.counts,
  uniqueCells: 165,
  uniqueTrials: 165,
  modelScenarioCells: 55,
  repetitions: 3,
  evidenceFilesVerified: Object.keys(sourceHashes).length,
  originalEvidenceModified: false,
  classificationCorrections: 0,
  newInferenceCalls: 0,
  schemas: ['ScorecardDatasetSchema v1'],
  judgments:
    'Exact frozen axes, justifications, review ranges and artifact hashes; four separate rubrics; seven explicit noArtifact/null records.',
  performance:
    'Task observations with sample counts, medians and ranges. MLX decode estimates are labeled; token streams remain separate; no throughput fallback or invented admission probes.',
});
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId,
  sourceReportSha256: details.sourceReportSha256,
  regenerate:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-bolt-five-scorecard.mjs',
  check:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-bolt-five-scorecard.mjs --check',
  files: [...files].map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: sha(value),
  })),
});
for (const [path, value] of files) {
  assert(
    !/\/Users\/|Mikes-MacBook-Pro|\/private\/var\/folders\//.test(value),
    `Workstation identity in ${path}`,
  );
  if (check)
    assert.equal(readFileSync(resolve(root, path), 'utf8'), value, `Publication drift: ${path}`);
  else {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    if (!existsSync(resolve(root, path)) || readFileSync(resolve(root, path), 'utf8') !== value)
      writeFileSync(resolve(root, path), value);
  }
}
console.log(
  `${check ? 'Verified' : 'Wrote'} ${files.size} publication files: 165 trials, 158 scored artifacts, seven missing outputs; ${Object.keys(sourceHashes).length} evidence hashes verified.`,
);
