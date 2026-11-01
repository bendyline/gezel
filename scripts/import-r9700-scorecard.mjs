#!/usr/bin/env node
// Publish the closed R9700 campaign from evidence, without inference or rescoring.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';
import { importCampaign } from './import-scorecard-campaigns.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = 'evals/runs/scorecard-2026-10-27-r9700-native-0-1-54';
const publicationId = '2026-10-28-r9700-native-0-1-54';
const correctionId = '2026-10-30-r9700-docblocks-activation';
const destination = `docs/handboek/assets/scorecards/${publicationId}`;
const check = process.argv.includes('--check');
const sha = (value) => createHash('sha256').update(value).digest('hex');
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
const review = read(`${sourceRoot}/final-review.json`);
const delivery = read(`${sourceRoot}/delivery-audit.json`);
assert(review.complete && delivery.complete);
assert.equal(delivery.uniqueRunDirs, 264);
assert.equal(review.rawBaselineReplaced, false);
const baselineIdentity = read(
  `${sourceRoot}/activation-correction-001/baseline-identity-check.json`,
);
assert.deepEqual(baselineIdentity.changes, []);
for (const [name, hash] of Object.entries(baselineIdentity.rawBaselineHashes))
  bytes(`${sourceRoot}/${name}`, hash);
for (const entry of [...review.evidenceFiles, ...delivery.documents])
  bytes(`${sourceRoot}/${entry.path}`, entry.sha256);

// Public data uses archive-relative references, never personal machine paths.
const sanitize = (value) => {
  if (typeof value === 'string')
    return value
      .replaceAll(`${root}\\`, '')
      .replaceAll(`${root.replaceAll('\\', '/')}/`, '')
      .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"'<>]+/gi, '<home>')
      .replace(/[A-Za-z]:[\\/]gh[\\/]gezel[\\/]/gi, '')
      .replace(/(?:evals|packages|docs|scripts|<home>)[\\/][^\s"'<>)]*/g, (path) =>
        path.replaceAll('\\', '/'),
      );
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitize(k), sanitize(v)]));
  return value;
};
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const observation = (values) => {
  const present = values.filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  return present.length
    ? {
        samples: present.length,
        median: median(present),
        min: Math.min(...present),
        max: Math.max(...present),
      }
    : undefined;
};
const modelMetadata = {
  qwen: {
    label: 'Qwen 3.8 (27B, Q4)',
    tier: 'medium',
    parameterSize: '27B',
    quantization: 'UD-Q4_K_M',
  },
  gemma: {
    label: 'Gemma 4 (12B, Q4)',
    tier: 'small',
    parameterSize: '12B',
    quantization: 'UD-Q4_K_XL',
  },
};
const baselineNote =
  '258 frozen trials across four suites, three repetitions per model/scenario. Native 0.1.54, llama.cpp Vulkan, generalist auto. Six raw infra exclusions remain: three Qwen custom-gate Windows denyNet failures and three model-authored gate-configuration failures (two Gemma, one Qwen); the latter are not Windows failures. Qwen complex-work has no eligible custom-gate cell, so its suite headline is withheld. Baseline DocBlocks lacked its tools in all six trials. The separately labeled activation subset does not replace these outcomes. Task measurements include every attempted trial and use engine-log throughput, not admission probes; system RSS and GPU memory are separate. Review means use declared Codex inline axes or game-HTML Claude reviews, never both for the same trial. Six misaligned A/B reviews, seven incidental HTML reviews and 137 tasks with no applicable artifact review are excluded from these means. Both complete judge ledgers, corrected spreadsheet selections, capability-rubric differences, performance gaps and evaluator/setup findings are preserved in the R9700 downloadable report.';
const correctionNote =
  'Separate six-trial DocBlocks activation condition, three repetitions per model. The supported binary expectedDeliverable contract exposed all 19 DocBlocks tools, changing the session/tool condition; it does not replace the 258-trial baseline. Qwen passed 2/3 and Gemma 0/3. Binary messageGezel repair was rejected before delivery, so these are not clean model-only failures or ignored nudges. Initial tool-schema and grounding errors are analyzed separately. Three Qwen reports were judged; three Gemma reports were absent. Original prompts, gates, generalist auto and native 0.1.54 were retained. See the separate condition postmortem in the R9700 download.';

function loadCondition(relativeRoot, runId, expectedTrials, scope, note) {
  const campaignRoot = `${sourceRoot}${relativeRoot ? `/${relativeRoot}` : ''}`;
  const campaign = read(`${campaignRoot}/campaign.json`);
  const inline = read(`${campaignRoot}/codex-inline-judge.json`);
  const advisory = read(`${campaignRoot}/advisory-judge-report.json`);
  const summary = read(`${campaignRoot}/summary.json`);
  for (const target of campaign.definition.targets) {
    const tiers = new Set(
      campaign.rows.filter((r) => r.cell.targetId === target.id).map((r) => r.result.modelTier),
    );
    assert.equal(tiers.size, 1);
    modelMetadata[target.id].tier = [...tiers][0];
  }
  const imported = importCampaign(root, {
    campaignRoot,
    campaignSha256: sourceHashes[`${campaignRoot}/campaign.json`],
    expectedTrials,
    count: 3,
    scope,
    runId,
    models: modelMetadata,
    note,
  });
  Object.assign(sourceHashes, imported.audit.inputSha256);
  const inlines = new Map(inline.judgments.map((j) => [j.cellId, j]));
  const clis = new Map(advisory.judgments.map((j) => [j.cell.id, j]));
  assert.equal(clis.size, expectedTrials);
  const definitions = new Map(campaign.definition.scenarios.map((s) => [`${s.suite}/${s.id}`, s]));
  const trials = campaign.rows.map((row) => {
    const { cell, result, score } = row;
    const facts = read(`${result.runDir}/facts.json`);
    const metrics = read(`${result.runDir}/metrics.json`);
    const cli = clis.get(cell.id);
    const inlineJudge = inlines.get(cell.id) ?? null;
    const spec = definitions.get(`${cell.suite}/${cell.scenario}`);
    assert.equal(facts.trialId, result.trialId);
    assert.equal(facts.outcome.success, result.success);
    assert.deepEqual(metrics, row.metrics);
    assert.equal(result.generalistMode, 'auto');
    assert(['judged', 'noArtifact'].includes(cli.status));
    if (cli.status === 'judged') {
      assert.deepEqual(read(`${result.runDir}/llm-judge.json`), cli.report);
      assert.deepEqual(facts.judge, cli.report);
    }
    if (spec.judge) {
      assert(inlineJudge, `Missing declared judgment ${cell.id}`);
      if (inlineJudge.status === 'judged') {
        bytes(inlineJudge.artifactPath, inlineJudge.artifactSha256);
        assert.deepEqual(
          Object.keys(inlineJudge.scoreAxes).sort(),
          spec.judge.axes.map((a) => a.name).sort(),
        );
        assert(
          Object.values(inlineJudge.scoreAxes).every(
            (n) => Number.isInteger(n) && n >= 0 && n <= 10,
          ),
        );
        assert(inlineJudge.justification.length <= 400);
      } else assert.equal(inlineJudge.status, 'noArtifact');
    }
    // Select one advisory observation per trial for the public task table.
    // The download keeps BOTH reviewers and every excluded score verbatim.
    let tableReview;
    if (cell.scenario === 'craftbook-ab-test-readout')
      tableReview = {
        status: 'excluded',
        reason: 'Declared rubric evaluates a mock-service plan, not A/B analysis.',
      };
    else if (inlineJudge)
      tableReview = { status: inlineJudge.status, rubricId: cell.scenario, report: inlineJudge };
    else if (
      ['tictactoe', 'petshop', 'tankcombat'].includes(cell.scenario) &&
      cli.status === 'judged'
    )
      tableReview = { status: 'judged', rubricId: 'default-html-v1', report: cli.report };
    else
      tableReview = {
        status: 'excluded',
        reason:
          cli.status === 'judged'
            ? 'Incidental or routing-fixture HTML, not task-quality evidence.'
            : 'No applicable declared artifact review; not a missing required deliverable.',
      };
    return {
      runId,
      includedInScorecard: true,
      ...row,
      facts,
      inlineJudge,
      cliJudge: cli,
      tableReview,
      rawClassificationPreserved: true,
      evidence: Object.fromEntries(
        ['result.json', 'score.json', 'facts.json', 'metrics.json'].map((name) => {
          const path = portable(`${result.runDir}/${name}`);
          return [name, { path, sha256: sourceHashes[path] }];
        }),
      ),
    };
  });
  assert.equal(new Set(trials.map((t) => t.result.trialId)).size, expectedTrials);
  assert.equal(new Set(trials.map((t) => t.cell.id)).size, expectedTrials);
  const shard = imported.dataset;
  const run = shard.runs[0];
  run.memoryCoverage = 'system-only';
  run.provenance.device.label = 'Windows · Ryzen 9 7950X3D · Radeon AI PRO R9700';
  run.provenance.engineBuilds = { 'llama-cpp': 'Gezel native 0.1.54 · Vulkan' };
  for (const result of shard.results) {
    const selected = trials.filter(
      (t) => t.cell.model === result.modelId && t.cell.suite === result.suiteId,
    );
    for (const cell of result.cells) {
      const repetitions = selected
        .filter((t) => t.cell.scenario === cell.scenarioId)
        .map((t) => t.cell.repetition)
        .sort();
      assert.deepEqual(repetitions, [1, 2, 3]);
    }
    const kv = new Set(selected.map((t) => t.result.engineContext?.kvCacheType).filter(Boolean));
    if (result.runtime && kv.size === 1) result.runtime.kvCacheType = [...kv][0];
    const rubricIds = [
      ...new Set(
        selected
          .filter((t) => t.tableReview.status === 'judged')
          .map((t) => t.tableReview.rubricId),
      ),
    ].sort();
    result.taskMeasurements = [
      {
        id: scope === 'suite' ? 'frozen' : 'activation-correction',
        label:
          scope === 'suite'
            ? 'Frozen · native 0.1.54 · all attempts'
            : 'Separate activation condition · all attempts',
        trials: selected.length,
        source: 'engine-log',
        outputTokensPerSec: observation(selected.map((t) => t.metrics.derived?.genTokensPerSec)),
        prefillTokensPerSec: observation(
          selected.map((t) => t.metrics.derived?.promptTokensPerSec),
        ),
        durationMs: observation(selected.map((t) => t.result.durationMs)),
        peakRssMb: observation(selected.map((t) => t.metrics.process?.peakRssMb)),
        peakGpuMemMb: observation(
          selected.map((t) => (t.metrics.gpu?.available ? t.metrics.gpu.peakMemUsedMb : null)),
        ),
        judgments: rubricIds.map((rubricId) => {
          const reviews = selected
            .filter((t) => t.tableReview.status === 'judged' && t.tableReview.rubricId === rubricId)
            .map((t) => t.tableReview.report);
          const judges = new Set(reviews.map((j) => `${j.judgeProvider}/${j.judgeModel}`));
          assert.equal(judges.size, 1);
          return {
            rubricId,
            meanScore: mean(reviews.map((j) => j.meanScore)),
            artifacts: reviews.length,
            judgeModel: [...judges][0],
          };
        }),
        noArtifact: selected.filter((t) => t.tableReview.status === 'noArtifact').length,
        excludedReviews: selected.filter((t) => t.tableReview.status === 'excluded').length,
      },
    ];
  }
  return {
    dataset: ScorecardDatasetSchema.parse(shard),
    trials,
    summary,
    definition: campaign.definition,
    identity: {
      ...run.provenance,
      runtime: campaign.identity.runtime,
      environmentHash: campaign.identity.environmentHash,
      localInstalls: campaign.identity.localInstalls,
    },
    judging: { inline, advisory },
    audit: imported.audit,
  };
}

const baseline = loadCondition('', publicationId, 258, 'suite', baselineNote);
const correction = loadCondition(
  'activation-correction-001',
  correctionId,
  6,
  'subset',
  correctionNote,
);
const dataset = ScorecardDatasetSchema.parse({
  schemaVersion: 1,
  runs: [...correction.dataset.runs, ...baseline.dataset.runs],
  results: [...correction.dataset.results, ...baseline.dataset.results],
});
const trials = [...baseline.trials, ...correction.trials];
assert.equal(new Set(trials.map((t) => t.result.trialId)).size, 264);
for (const [target, expected] of Object.entries({ qwen: [129, 104, 4], gemma: [129, 81, 2] })) {
  const selected = baseline.trials.filter((t) => t.cell.targetId === target);
  assert.deepEqual(
    [
      selected.length,
      selected.filter((t) => t.result.success).length,
      selected.filter((t) => !t.score.eligibility.includedInModelAggregate).length,
    ],
    expected,
  );
}
const counts = {
  baselineTrials: 258,
  baselinePasses: 185,
  baselineTaskFailures: 67,
  baselineRawExclusions: 6,
  correctionTrials: 6,
  correctionPasses: 2,
  correctionTaskFailures: 4,
  inlineJudged: 99,
  inlineNoArtifact: 3,
  cliJudged: 124,
  cliNoArtifact: 140,
  pendingReviews: 0,
  tableJudged: 111,
  tableNoArtifact: 3,
  tableExcludedReviews: 150,
};
assert.equal(trials.filter((t) => t.inlineJudge?.status === 'judged').length, counts.inlineJudged);
assert.equal(
  trials.filter((t) => t.inlineJudge?.status === 'noArtifact').length,
  counts.inlineNoArtifact,
);
assert.equal(trials.filter((t) => t.cliJudge.status === 'judged').length, counts.cliJudged);
assert.equal(trials.filter((t) => t.cliJudge.status === 'noArtifact').length, counts.cliNoArtifact);
for (const [status, key] of [
  ['judged', 'tableJudged'],
  ['noArtifact', 'tableNoArtifact'],
  ['excluded', 'tableExcludedReviews'],
])
  assert.equal(trials.filter((t) => t.tableReview.status === status).length, counts[key]);

const reviewFiles = [
  ...new Set([
    ...review.evidenceFiles.map((e) => e.path),
    'frozen-cell-audit.json',
    'performance-coverage-audit.json',
    'advisory-artifact-correction.json',
    'activation-correction-001/condition.json',
    'activation-correction-001/review-statistics.json',
    'activation-correction-001/baseline-identity-check.json',
  ]),
];
const diagnostics = Object.fromEntries(
  reviewFiles.map((name) => [
    name,
    name.endsWith('.json')
      ? read(`${sourceRoot}/${name}`)
      : bytes(`${sourceRoot}/${name}`).toString(),
  ]),
);
const reports = Object.fromEntries(
  delivery.documents.map(({ path, sha256 }) => [
    path,
    bytes(`${sourceRoot}/${path}`, sha256).toString(),
  ]),
);
const statistics = read(`${sourceRoot}/final-statistics.json`);
const details = {
  schemaVersion: 1,
  kind: 'scorecard-details',
  publicationId,
  scorecardFile: 'scorecard.json',
  complete: true,
  reviewedAt: review.reviewedAt,
  newInferenceCalls: 0,
  counts,
  modelMetadata,
  conditions: [
    {
      runId: publicationId,
      scope: 'suite',
      note: baselineNote,
      definition: baseline.definition,
      provenance: baseline.identity,
      summary: baseline.summary,
      judging: baseline.judging,
    },
    {
      runId: correctionId,
      scope: 'subset',
      baselineMerged: false,
      note: correctionNote,
      definition: correction.definition,
      provenance: correction.identity,
      summary: correction.summary,
      judging: correction.judging,
    },
  ],
  statistics,
  trials,
  diagnostics,
  reports,
  judgingInterpretation: {
    artifactLimitBytes: 20480,
    scale:
      'Integer axes from 0 to 10; tend toward 5 for delivering the brief, reserve 9-10 for polished work; justification limited to 400 characters. Frozen judgments are preserved, not rescored during publication.',
    defaultHtmlAxes: [
      { name: 'visualQuality', description: 'Does it look like a real product, or a debug page?' },
      { name: 'functionalCompleteness', description: "Does it implement the user's stated brief?" },
      { name: 'codeQuality', description: 'Would a developer reading the source be embarrassed?' },
      { name: 'polish', description: 'Are there surprising / delightful touches?' },
    ],
    primaryTableSelection:
      'Codex inline for declared axes, Claude CLI for the three game HTML scenarios; exact scenario rubrics remain separate. Other CLI opinions remain in the download only.',
    exclusions:
      'Six A/B inline and parallel CLI opinions have a mismatched rubric; six routing-page and one incidental fanout CLI opinions do not measure task quality. 137 other baseline trials have no applicable artifact review and count as excluded from the table, not as missing required outputs.',
    missingCorrectionArtifacts: 3,
    spreadsheetCorrections:
      'Three CLI selections corrected to declared task artifacts; superseded reports retained in diagnostics/advisory-artifact-correction.json.',
    exactInlineModelVersion: null,
    rubricImplementation:
      'Frozen eval-run-fixed-v1 implementation; not identical to skill prose. Eighteen partial-quality scores exceed its prose cap; no rescoring.',
  },
  performanceInterpretation: {
    source: 'engine-log',
    population:
      'All attempted trials, including excluded and failed attempts; each condition remains separate.',
    coreSamples: 264,
    gpuSamples: 263,
    missingGpu: delivery.missingGpu,
    units: {
      durations: 'ms unless explicitly named Seconds',
      throughput: 'tokens/second',
      memoryMb: 'MiB',
    },
    notes:
      'No admission-probe values were invented. System RSS, host RAM and GPU memory are different measurements. First artifact is an attributed write, not completed output. Raw and reconstructed timing coverage is retained in diagnostics. Exact launch context/KV settings are per-trial result.engineContext; no catalog-limit substitution.',
  },
  evidence: {
    availability:
      'Structured outcomes, fixed scores, facts, metrics, both judge ledgers, reports and all final audits are included. Original generated binaries, raw session transcripts, process logs and credentials remain in the local archive.',
    pathConvention:
      'Repository-relative archive references, not public download URLs. Personal home paths are redacted; evidence hashes identify the original unsanitized files.',
    sourceFiles: sourceHashes,
  },
};
const files = new Map();
const addJson = (path, value) => files.set(path, `${JSON.stringify(sanitize(value), null, 2)}\n`);
for (const shard of [baseline.dataset, correction.dataset]) {
  const id = shard.runs[0].id;
  addJson(`packages/core/src/scorecard/data/runs/${id}.json`, shard);
  addJson(`${destination}/runs/${id}.json`, shard);
}
addJson(`${destination}/scorecard.json`, dataset);
addJson(`${destination}/scorecard-details.json`, details);
addJson(`${destination}/verification.json`, {
  counts,
  uniqueTrials: 264,
  baselineModelScenarioCells: 86,
  correctionModelScenarioCells: 2,
  repetitions: 3,
  exactRepetitions: true,
  originalEvidenceModified: false,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  rawClassificationCorrections: 0,
  baselineIdentityUnchanged: true,
  correctionMerged: false,
  evidenceFilesVerified: Object.keys(sourceHashes).length,
  schemas: ['ScorecardDatasetSchema v1'],
  reportsAndFinalAuditsVerified: true,
});
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId,
  regenerate:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-r9700-scorecard.mjs',
  check:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-r9700-scorecard.mjs --check',
  files: [...files].map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: sha(value),
  })),
});
for (const [path, value] of files) {
  assert(
    !/[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]gh[\\/]gezel/i.test(value),
    `Personal path in ${path}`,
  );
  assert(
    !/\bBearer\s+[A-Za-z0-9._~-]{20,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/.test(value),
    `Potential credential in ${path}`,
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
  `${check ? 'Verified' : 'Wrote'} ${files.size} publication files: 258 baseline + 6 separate activation trials; ${Object.keys(sourceHashes).length} evidence hashes.`,
);
