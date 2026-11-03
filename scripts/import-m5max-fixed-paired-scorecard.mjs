#!/usr/bin/env node
// Publish the user-curtailed comparison; never run inference or mutate its archive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMlxPrefillTelemetry } from '../evals/src/mlx-prefill-telemetry.ts';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const campaignRoot = 'evals/runs/scorecard-2026-11-03-m5max-fixed-paired';
const publicationId = '2026-11-03-m5max-fixed-paired';
const destination = `docs/handboek/assets/scorecards/${publicationId}`;
const campaignSha256 = '4c95a41e150003491d9802bcdefc948c7bf27ef007770541753f5c905d7f1a79';
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
const source = (name) => read(`${campaignRoot}/${name}`);
const campaign = read(`${campaignRoot}/campaign.json`, campaignSha256);
const audit = source('completion-audit.json');
const analysis = source('final-scorecard.json');
const native = source('native-provenance.json');
const ledger = source('codex-inline-judge.json');
const recovery = source('mlx-prefill-recovery.json');
const performance = source('performance-audit.json');
const scope = source('scope-amendment.json');
assert.equal(audit.reportStatus, 'complete-user-curtailed');
assert.equal(audit.heartbeatStatus, 'PAUSED');
assert(Object.values(audit.checks).every(Boolean));
assert(Object.values(audit.mlxPrefillRecoveryRevision.checks).every(Boolean));
assert.equal(audit.unchangedCampaignSha256, campaignSha256);
assert.equal(analysis.campaignSha256, campaignSha256);
assert.equal(scope.campaignSha256AtAmendment, campaignSha256);
assert.equal(recovery.campaignSha256, campaignSha256);
assert(campaign.stopped && !campaign.running);
for (const name of ['supervisor.lock', 'campaign.lock'])
  assert(!existsSync(resolve(root, campaignRoot, name)), 'Campaign must be stopped');
for (const [name, hash] of Object.entries(source('setup-provenance.json').files))
  bytes(`${campaignRoot}/${name}`, hash);
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
const reviews = new Map(ledger.trials.map((review) => [review.cellId, review]));
const recovered = new Map(recovery.trials.map((trial) => [trial.cellId, trial]));
const perf = new Map(performance.trials.map((trial) => [trial.id, trial]));
assert.equal(reviews.size, 73);
assert.equal(recovered.size, 37);
assert.equal(perf.size, 73);
const trials = campaign.rows.map((row) => {
  const { cell, result } = row;
  assert.equal(cell.repetition, 1);
  for (const [name, value] of Object.entries({ result, score: row.score, metrics: row.metrics }))
    assert.deepEqual(read(`${result.runDir}/${name}.json`), value);
  const facts = read(`${result.runDir}/facts.json`);
  const host = read(`${result.runDir}/host.json`);
  assert.deepEqual(facts.timing, row.timing);
  assert.equal(facts.trialId, result.trialId);
  assert.equal(facts.outcome.success, result.success);
  assert.equal(host.framework, cell.provider);
  assert.equal(host.cpuModel, 'Apple M5 Max');
  assert.equal(host.totalRamGb, 128);
  if (cell.provider === 'llama-cpp') {
    assert.equal(host.frameworkBuild.revision, native.llamaBuild.revision);
    assert.equal(host.frameworkBuild.buildNumber, '11960');
    assert.equal(host.frameworkVariant, 'metal');
  }
  const comparisonIncluded = !row.comparisonIssue && row.score.eligibility.includedInModelAggregate;
  const measured = perf.get(cell.id);
  assert.equal(measured.comparisonIncluded, comparisonIncluded);
  assert.equal(measured.success, result.success);
  assert.equal(measured.fixedComposite, row.score.composite);
  assert.equal(measured.durationSeconds, result.durationMs / 1000);
  assert.equal(measured.decodeTokensPerSecond, row.metrics.derived.genTokensPerSec);
  assert.equal(measured.prefillTokensPerSecond, row.metrics.derived.promptTokensPerSec);
  if (cell.provider === 'mlx') {
    const recoveryTrial = recovered.get(cell.id);
    assert(recoveryTrial);
    assert.equal(recoveryTrial.comparisonIncluded, comparisonIncluded);
    bytes(recoveryTrial.metrics, recoveryTrial.metricsSha256);
    const recording = bytes(recoveryTrial.recording, recoveryTrial.recordingSha256);
    assert.deepEqual(parseMlxPrefillTelemetry(recording.toString()), recoveryTrial.recovered);
    assert.equal(measured.observedMlxPrefillTokensPerSecond, recoveryTrial.recovered.tokensPerSec);
    assert.equal(measured.prefillTokensPerSecond, null);
    assert.equal(recoveryTrial.purePrefillDurationMs, null);
  }
  const review = { ...reviews.get(cell.id) };
  assert.equal(review.trialId, result.trialId);
  assert(['judged', 'notApplicable'].includes(review.status));
  if (review.status === 'judged') {
    const packet = source(`judge-packets/${review.id}.packet.json`);
    const scorePath = `${campaignRoot}/judge-packets/${review.id}.score.json`;
    const score = read(scorePath);
    const artifact = bytes(review.artifactPath);
    assert.equal(packet.artifact, artifact.subarray(0, 20480).toString('utf8'));
    assert.equal(packet.bytes, artifact.length);
    assert.deepEqual(review.scoreAxes, score.scoreAxes);
    assert.deepEqual(
      Object.keys(score.scoreAxes).sort(),
      packet.axes.map((axis) => axis.name).sort(),
    );
    assert(Object.values(score.scoreAxes).every((n) => Number.isInteger(n) && n >= 0 && n <= 10));
    assert.equal(review.meanScore, mean(Object.values(score.scoreAxes)));
    assert.equal(review.justification, score.justification);
    assert.equal(review.reviewedAt, score.reviewedAt);
    assert(review.justification.length <= 400);
    assert.equal(review.judgeProvider, 'codex-inline');
    assert.equal(review.judgeModel, 'current-session');
    const { artifact: _artifact, ...specification } = packet;
    Object.assign(review, {
      specification,
      reviewedBytes: Math.min(20480, artifact.length),
      artifactSha256: sha(artifact),
      scoreFileSha256: sourceHashes[scorePath],
    });
  } else assert(!review.scoreAxes);
  return {
    ...row,
    comparisonIncluded,
    facts,
    host,
    review,
    postmortem: bytes(`${result.runDir}/postmortem.md`).toString(),
  };
});
assert.equal(trials.length, 73);
assert.equal(new Set(trials.map((trial) => trial.cell.id)).size, 73);
assert.equal(new Set(trials.map((trial) => trial.result.trialId)).size, 73);
const included = trials.filter((trial) => trial.comparisonIncluded);
const excluded = trials.filter((trial) => !trial.comparisonIncluded);
assert.equal(included.length, 72);
assert.equal(excluded.length, 1);
assert.equal(excluded[0].cell.id, 'r1-gemma-mlx-productivity-craftbook-powerpoint-deck');
assert(excluded[0].result.success && excluded[0].comparisonIssue);
const pairs = new Map();
for (const trial of included) {
  const c = trial.cell;
  const key = `${c.model}/${c.suite}/${c.scenario}/${c.repetition}`;
  pairs.set(key, [...(pairs.get(key) ?? []), c.provider]);
}
assert.equal(pairs.size, 36);
for (const engines of pairs.values()) assert.deepEqual(engines.sort(), ['llama-cpp', 'mlx']);
const counts = {
  recordedTrials: 73,
  matchedTrials: included.length,
  pairs: pairs.size,
  passes: included.filter((trial) => trial.result.success).length,
  excludedUnpairedTrials: excluded.length,
  numericReviews: trials.filter((trial) => trial.review.status === 'judged').length,
  includedNumericReviews: included.filter((trial) => trial.review.status === 'judged').length,
  notApplicable: trials.filter((trial) => trial.review.status === 'notApplicable').length,
  recoveredMlxTrials: recovered.size,
  includedMlxPrefillObservations: recovery.trials
    .filter((trial) => trial.comparisonIncluded)
    .reduce((n, trial) => n + trial.recovered.sampleCount, 0),
};
assert.deepEqual(Object.values(counts), [73, 72, 36, 68, 1, 25, 24, 48, 37, 121]);
const models = {
  'qwen-mlx': {
    label: 'Qwen 3.8 (27B, Q4) · MLX',
    parameterSize: '27B',
    quantization: '4-bit affine, group 64',
  },
  'qwen-llamacpp': {
    label: 'Qwen 3.8 (27B, Q4) · llama.cpp',
    parameterSize: '27B',
    quantization: 'UD-Q4_K_M',
  },
  'gemma-mlx': {
    label: 'Gemma 4 (12B, Q4) · MLX',
    parameterSize: '12B',
    quantization: 'MXFP4, group 32',
  },
  'gemma-llamacpp': {
    label: 'Gemma 4 (12B, Q4) · llama.cpp',
    parameterSize: '12B',
    quantization: 'qat UD-Q4_K_XL',
  },
};
const suites = ['core', 'productivity'];
const run = {
  id: publicationId,
  provenance: {
    startedAt: campaign.createdAt,
    device: campaign.identity.device,
    harnessCommit: campaign.identity.source.head,
    sourceHash: campaign.identity.source.sha256,
    serviceBuildHash: campaign.identity.service.sha256,
    catalogHash: campaign.identity.gilde.sha256,
    gildeVersion: campaign.identity.gilde.version,
    count: 1,
    judgeModelId: 'codex-inline/current-session',
    engineBuilds: {
      'llama-cpp': `Gezel native 0.1.55 · Metal · llama.cpp ${native.llamaVersion} · ${native.llamaBuild.revision}`,
      mlx: `Gezel native 0.1.55 · MLX ${native.mlxPackages.mlx} · mlx-lm ${native.mlxPackages['mlx-lm']} · mlx-vlm ${native.mlxPackages['mlx-vlm']}`,
    },
  },
  scope: 'subset',
  memoryCoverage: 'full',
  suites,
  scenariosBySuite: Object.fromEntries(
    suites.map((suite) => [
      suite,
      [
        ...new Set(
          included
            .filter((trial) => trial.cell.suite === suite)
            .map((trial) => trial.cell.scenario),
        ),
      ],
    ]),
  ),
  note: 'User-curtailed exploratory comparison: 72 matched trials, 18 pairs per model, one repetition over core and productivity; developer and complex-work were not run. Both models passed 16/18 on MLX and 18/18 on llama.cpp; equivalence within ±5 percentage points is not established. The passing, unpaired PowerPoint trial has a preserved fixture-identity flag and remains in downloads only. All four recorded failures remain unchanged, including one diagnosed gate false-positive. Native 0.1.55; generalist auto; Gilde 0.3.5 with the staged Gemma MLX assistant drafter candidate, not an installed catalog release. Observed MLX prefill is recovered from rounded, partial first-token chat events, not aggregate request throughput or pure prefill time. Engine quantizations and speculation differ. Raw scores, judgments, performance coverage and paired uncertainty are in the downloads.',
};
const results = Object.entries(models).flatMap(([targetId, metadata]) =>
  suites.map((suiteId) => {
    const group = included.filter(
      (trial) => trial.cell.targetId === targetId && trial.cell.suite === suiteId,
    );
    assert.equal(group.length, suiteId === 'core' ? 11 : 7);
    const judged = group
      .map((trial) => trial.review)
      .filter((review) => review.status === 'judged');
    const rubricId = (review) =>
      review.rubric === 'default-html' ? 'default-html-v1' : review.scenarioId;
    const ctx = group
      .map((trial) => trial.result.engineContext?.grantedPerSlotTokens)
      .filter(Boolean);
    const kv = [
      ...new Set(group.map((trial) => trial.result.engineContext?.kvCacheType).filter(Boolean)),
    ];
    const measurements = {
      id: 'matched-subset',
      label: 'Matched subset · native 0.1.55',
      trials: group.length,
      source: 'engine-log',
      outputTokensPerSec: observation(
        group.map((trial) => perf.get(trial.cell.id).decodeTokensPerSecond),
      ),
      prefillTokensPerSec: observation(
        group.map((trial) => perf.get(trial.cell.id).prefillTokensPerSecond),
      ),
      observedPrefillTokensPerSec: observation(
        group.map((trial) => perf.get(trial.cell.id).observedMlxPrefillTokensPerSecond),
      ),
      durationMs: observation(group.map((trial) => trial.result.durationMs)),
      peakRssMb: observation(group.map((trial) => trial.metrics.process.peakRssMb)),
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
      noArtifact: 0,
      excludedReviews: 0,
      notApplicableReviews: group.length - judged.length,
    };
    // Do not manufacture MLX context from model defaults just to expose its memory.
    const runtime =
      ctx.length === group.length && new Set(ctx).size === 1
        ? {
            contextTokens: ctx[0],
            peakMemoryMb: Math.round(measurements.peakRssMb.median),
            ...(kv.length === 1 ? { kvCacheType: kv[0] } : {}),
          }
        : undefined;
    return {
      ...metadata,
      tier: 'medium',
      modelId: group[0].cell.model,
      engine: group[0].cell.provider,
      runId: publicationId,
      suiteId,
      runtime,
      taskMeasurements: [measurements],
      cells: group.map((trial) => ({
        scenarioId: trial.cell.scenario,
        trials: 1,
        successes: Number(trial.result.success),
        nonModelFailures: 0,
        medianDurationMs: trial.result.durationMs,
      })),
    };
  }),
);
const dataset = ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [run], results });
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
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitize(k), sanitize(v)]));
  return value;
};
const addJson = (name, value) => files.set(name, `${JSON.stringify(sanitize(value), null, 2)}\n`);
addJson(`packages/core/src/scorecard/data/runs/${publicationId}.json`, dataset);
addJson(`${destination}/scorecard.json`, dataset);
const jsonFiles = {
  'analysis.json': 'final-scorecard.json',
  'paired-analysis.json': 'condensed-paired-analysis.json',
  'performance.json': 'performance-audit.json',
  'mlx-prefill-recovery.json': 'mlx-prefill-recovery.json',
  'native-provenance.json': 'native-provenance.json',
  'completion-audit.json': 'completion-audit.json',
  'scope-amendment.json': 'scope-amendment.json',
  'analysis-plan.json': 'analysis-plan.json',
};
for (const [published, original] of Object.entries(jsonFiles))
  addJson(`${destination}/${published}`, source(original));
addJson(`${destination}/judging.json`, {
  ...ledger,
  trials: trials.map((trial) => ({
    cell: trial.cell,
    comparisonIncluded: trial.comparisonIncluded,
    ...trial.review,
  })),
});
const markdownFiles = {
  'report.md': 'final-scorecard.md',
  'paired-analysis.md': 'condensed-paired-analysis.md',
  'judging.md': 'judging.md',
  'mlx-prefill-recovery.md': 'mlx-prefill-recovery.md',
  'scope-amendment.md': 'scope-amendment.md',
  'analysis-plan.md': 'analysis-plan.md',
};
const publicTargets = new Map(
  Object.entries({
    ...jsonFiles,
    ...markdownFiles,
    'performance.csv': 'performance.csv',
    'judging.json': 'codex-inline-judge.json',
  }).map(([published, original]) => [`${campaignRoot}/${original}`, published]),
);
const reports = {};
for (const [published, original] of Object.entries(markdownFiles)) {
  const text = bytes(`${campaignRoot}/${original}`).toString();
  reports[original] = text;
  files.set(
    `${destination}/${published}`,
    `${sanitize(
      text.replace(/\]\(<?([^)>]+)>?\)/g, (match, href) => {
        if (/^(?:https?:|#)/.test(href)) return match;
        const path = href.startsWith('/') ? portable(href) : portable(`${campaignRoot}/${href}`);
        return `](${publicTargets.get(path) ?? 'scorecard-details.json'})`;
      }),
    )}\n\nPublication note: portable copy of the completed, user-curtailed report. Archive-only links open scorecard-details.json, which embeds trial facts, postmortems and review specifications. Publication-status statements describe the original closeout.\n`,
  );
}
files.set(
  `${destination}/performance.csv`,
  sanitize(bytes(`${campaignRoot}/performance.csv`).toString()),
);
addJson(`${destination}/scorecard-details.json`, {
  schemaVersion: 1,
  kind: 'scorecard-details',
  publicationId,
  status: 'complete-user-curtailed',
  counts,
  scopeAmendment: scope,
  definition: campaign.definition,
  runtimeIdentity: campaign.identity,
  trials,
  reports,
  analysis,
  evidence: {
    pathConvention:
      'Repository-relative archive references are not public URLs. Trial facts, raw metrics, fixed scores, postmortems, review specifications and exclusion reasons are embedded here. Raw recordings, artifacts and binaries remain local. Source hashes identify original unsanitized files.',
    sourceFiles: sourceHashes,
  },
});
addJson(`${destination}/verification.json`, {
  counts,
  originalEvidenceModified: false,
  matchedPairsVerified: true,
  originalDesignComplete: false,
  allIncludedRepetitions: [1],
  mlxPrefillReparsedFromRecordings: true,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  sourceFilesVerified: Object.keys(sourceHashes).length,
  schema: 'ScorecardDatasetSchema v1',
});
files.set(
  `${destination}/README.md`,
  '# November 3 condensed M5 Max comparison\n\n72 matched trials from 73 recorded; 18 pairs per model, one repetition. This is an exploratory subset, not the original 516-trial study. Equivalence within ±5 percentage points is not established. The flagged unpaired pass remains in the detailed downloads.\n\n- [Report](report.md) and [aggregate data](analysis.json)\n- [Paired conclusions](paired-analysis.md) and [data](paired-analysis.json)\n- [Performance CSV](performance.csv) and [data](performance.json)\n- [MLX prefill method](mlx-prefill-recovery.md) and [observations](mlx-prefill-recovery.json)\n- [Judgments](judging.md) and [scores, axes and prompts](judging.json)\n- [All 73 trial records and postmortems](scorecard-details.json)\n- [Scorecard dataset](scorecard.json)\n- [Scope amendment](scope-amendment.md) and [original analysis plan](analysis-plan.md)\n- [Native provenance](native-provenance.json), [completion audit](completion-audit.json), [publication verification](verification.json), and [file hashes](manifest.json)\n\nRecovered MLX prefill is partial, rounded first-token rate evidence, not exact prefill time or a duration-weighted request aggregate. Candidate Gemma MLX drafting, quantization differences and telemetry limits are documented in the report.\n',
);
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId,
  regenerate:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-m5max-fixed-paired-scorecard.mjs',
  check:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-m5max-fixed-paired-scorecard.mjs --check',
  files: [...files].map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: sha(value),
  })),
});
// Verify every generated value before writing any of it.
for (const [name, value] of files)
  assert(
    !/\/Users\/|Mikes-MacBook-Pro|\bBearer\s+[A-Za-z0-9._~-]{20,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      value,
    ),
    `Private path or possible credential in ${name}`,
  );
for (const [path, hash] of Object.entries(sourceHashes))
  assert.equal(
    sha(readFileSync(resolve(root, path))),
    hash,
    `Source changed during publication: ${path}`,
  );
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
