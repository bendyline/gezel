#!/usr/bin/env node
// Publish the closed October Windows campaign without running or rescoring trials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeIdentity } from '../evals/src/qualification/metadata.ts';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = 'evals/runs/small-model-core-2026-10-19';
const destination = 'docs/handboek/assets/scorecards/2026-10-19-windows-small-model-core';
const check = process.argv.includes('--check');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const portable = (path) => {
  const value = relative(root, resolve(root, path)).replaceAll('\\', '/');
  assert(!isAbsolute(value) && !value.startsWith('../'), 'Evidence outside checkout');
  return value;
};
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const finalBytes = readFileSync(resolve(root, evidenceRoot, 'final-comparison.json'));
assert.equal(sha(finalBytes), 'b30dd40c3aeb6715502f24cc84ad22b0a7fe5697134a697455467c5d6e4a6aa1');
const final = JSON.parse(finalBytes);
assert(final.complete && final.n === 264 && final.reviewed === 264);
assert.equal(new Set(final.cells.map((c) => c.cellId)).size, 264);
assert.equal(new Set(final.cells.map((c) => c.trialId)).size, 264);

const counts = (cells) => ({
  trials: cells.length,
  passed: cells.filter((c) => c.success).length,
  modelFailures: cells.filter((c) => c.failureClass === 'model').length,
  infrastructureExclusions: cells.filter((c) => c.failureClass === 'infra').length,
  artifactReviews: cells.filter((c) => c.advisoryMean !== null).length,
  noArtifact: cells.filter((c) => c.advisoryStatus === 'noArtifact').length,
  eligibleReviews: cells.filter((c) => c.advisoryEligible).length,
});
const totals = counts(final.cells);
assert.deepEqual(totals, {
  trials: 264,
  passed: 182,
  modelFailures: 70,
  infrastructureExclusions: 12,
  artifactReviews: 254,
  noArtifact: 10,
  eligibleReviews: 247,
});

const evidenceHashes = final.hashAudit.map((entry) => {
  const path = portable(entry.path);
  const bytes = readFileSync(resolve(root, path));
  assert.equal(sha(bytes), entry.sha256, `Evidence changed: ${path}`);
  return { ...entry, path };
});
const sources = final.sources.map((source) => ({
  journal: source.code,
  root: portable(source.root),
  authoritativeTrials: source.recorded,
  summarySha256: source.summaryHash,
  harnessCommit: source.identity.source.head,
  sourceHash: source.identity.source.sha256,
  serviceBuildHash: source.identity.service.sha256,
  runtimeHash: source.identity.runtime.sha256,
  catalogHash: source.identity.gilde.sha256,
  gildeVersion: source.identity.gilde.version,
  driverHash: source.identity.driverHash,
}));
const sourceFor = (code) => sources.find((s) => s.journal === code);
const observation = (cells, key) => {
  const values = cells
    .map((cell) => cell[key])
    .filter((value) => Number.isFinite(value) && value >= 0);
  return values.length
    ? {
        samples: values.length,
        median: median(values),
        min: Math.min(...values),
        max: Math.max(...values),
      }
    : undefined;
};
const measurementGroup = (cells, journal) => {
  const selected = cells.filter((cell) => cell.journal === journal);
  const start = selected.map((cell) => cell.startedAt).sort()[0];
  const end = selected
    .map((cell) => cell.finishedAt)
    .sort()
    .at(-1);
  const period = `${start.slice(5, 16).replace('T', ' ')}–${end.slice(5, 16).replace('T', ' ')} UTC`;
  const note = ['N3', 'N4'].includes(journal)
    ? ' · restricted GPU period'
    : journal === 'N5'
      ? ' · spans speed change'
      : '';
  const eligible = selected.filter((cell) => cell.advisoryEligible);
  return {
    id: journal,
    label: `${journal} · ${period}${note}`,
    trials: selected.length,
    source: 'engine-log',
    outputTokensPerSec: observation(selected, 'nativeTokensPerSec'),
    prefillTokensPerSec: observation(selected, 'promptTokensPerSec'),
    durationMs: observation(selected, 'durationMs'),
    peakRssMb: observation(selected, 'peakRssMb'),
    peakGpuMemMb: observation(selected, 'peakGpuMemMb'),
    judgments: [...new Set(eligible.map((cell) => cell.rubricId))].map((rubricId) => {
      const reviewed = eligible.filter((cell) => cell.rubricId === rubricId);
      return {
        rubricId,
        meanScore: reviewed.reduce((sum, cell) => sum + cell.advisoryMean, 0) / reviewed.length,
        artifacts: reviewed.length,
        judgeModel: 'codex-inline/current-session',
      };
    }),
    noArtifact: selected.filter((cell) => cell.advisoryStatus === 'noArtifact').length,
    excludedReviews: selected.filter((cell) => cell.advisoryMean !== null && !cell.advisoryEligible)
      .length,
  };
};
for (const s of sources.filter((s) => s.journal.startsWith('N'))) {
  for (const key of ['sourceHash', 'serviceBuildHash', 'runtimeHash', 'catalogHash']) {
    assert.equal(s[key], sourceFor('N1')[key], `Nanbeige identity changed: ${key}`);
  }
}
assert.notEqual(sourceFor('A').runtimeHash, sourceFor('B').runtimeHash);

const metadata = {};
const original = final.sources[0].identity;
assert.equal((await treeIdentity(original.gilde.dataDir)).sha256, original.gilde.sha256);
for (const { model } of final.models) {
  const install = original.localInstalls[`llama-cpp/${model}`];
  const installedBytes = readFileSync(resolve(install.path, 'manifest.json'));
  assert.equal(
    sha(JSON.stringify(installedBytes.toString('base64'))),
    install.files['manifest.json'].contentHash,
  );
  const installed = JSON.parse(installedBytes);
  const catalogPath = `chat-models/${model.slice(0, 2)}/${model}/manifest.json`;
  const catalogBytes = readFileSync(resolve(original.gilde.dataDir, catalogPath));
  const catalog = JSON.parse(catalogBytes);
  const billions = Number.parseFloat(catalog.parameterSize);
  metadata[model] = {
    label: installed.name,
    parameterSize: catalog.parameterSize,
    quantization: installed.quantization,
    tier: billions < 5 ? 'tiny' : billions < 12 ? 'small' : billions < 45 ? 'medium' : 'large',
    modelManifestSha256: sha(installedBytes),
    catalogManifestSha256: sha(catalogBytes),
    weightsSha256: installed.fileSha256,
  };
}

const rounds = [
  {
    id: '2026-10-20-rtx5070ti-core-original-64k',
    journals: ['A'],
    scope: 'subset',
    expected: 49,
    note: 'Original runtime, 65,536 tokens and one slot. Seven scenarios ran once per model (49 trials); the remaining requested cells are in the separate continuation. The runtime floor raised the two 27B models from a requested 32K to an observed 64K. Counts only; this is not a full-suite ranking.',
  },
  {
    id: '2026-10-20-rtx5070ti-core-continuation-64k',
    journals: ['B'],
    scope: 'suite',
    expected: 182,
    note: 'Continuation after the Nanbeige context-floor correction, at unchanged observed 65,536 tokens and one slot for these seven models. All 11 core scenarios are represented: two repeats of the first seven and three of the last four (26 trials per model). The 49 original-runtime trials remain in their own round. Counts only; do not pool builds into a three-repeat rate. Sequential laptop runs experienced changing hardware performance.',
  },
  {
    id: '2026-10-20-rtx5070ti-nanbeige-core-32k',
    journals: sources.filter((s) => s.journal.startsWith('N')).map((s) => s.journal),
    scope: 'suite',
    expected: 33,
    note: 'Nanbeige rerun: all 33 requested cells recorded at 32,768 tokens, one slot and f16 KV across 12 preserved journals with verified identical runtime. 12 passed, nine were model failures and 12 exceeded context; the latter are infrastructure exclusions, not GPU OOM. Some scenarios have no attributable trials, so the reader withholds a full-suite score. GPU fit was verified. Oct 22 samples included a 33 W cap and 810 MHz memory; throughput later rose without operator changes. No uniform speed claim is made.',
  },
];
const cellRound = new Map();
const shards = rounds.map((round) => {
  const selected = final.cells.filter((c) => round.journals.includes(c.journal));
  assert.equal(selected.length, round.expected);
  const source = sourceFor(round.journals[0]);
  const scenarioIds = [...new Set(selected.map((c) => c.scenario))];
  for (const c of selected) {
    assert(!cellRound.has(c.cellId));
    cellRound.set(c.cellId, round.id);
  }
  const run = {
    id: round.id,
    scope: round.scope,
    memoryCoverage: 'system-only',
    suites: ['core'],
    scenariosBySuite: { core: scenarioIds },
    provenance: {
      startedAt: selected.map((c) => c.startedAt).sort()[0],
      device: { ...original.device, label: 'Windows laptop (RTX 5070 Ti, Ryzen AI 9 HX 370)' },
      harnessCommit: source.harnessCommit.slice(0, 12),
      sourceHash: source.sourceHash,
      serviceBuildHash: source.serviceBuildHash,
      catalogHash: source.catalogHash,
      gildeVersion: source.gildeVersion,
      count: 3,
      judgeModelId: null,
      engineBuilds: { 'llama-cpp': 'CUDA build 11669 / 620d2225cc436ab0b001e3200e590e3b286ef9ab' },
    },
    note: `${round.note} Runtime content: ${source.runtimeHash.slice(0, 12)}. Task performance and advisory reviews appear below by journal and rubric; exact trial scores, axes and evidence are in the October Windows data download.`,
  };
  const results = [...new Set(selected.map((c) => c.model))].map((model) => {
    const cells = selected.filter((c) => c.model === model);
    const contexts = new Set(cells.map((c) => c.engineContext.grantedPerSlotTokens));
    const kv = new Set(cells.map((c) => c.engineContext.kvCacheType));
    assert.equal(contexts.size, 1);
    assert.equal(kv.size, 1);
    assert(cells.every((c) => c.slots === 1));
    const { label, parameterSize, quantization, tier } = metadata[model];
    return {
      modelId: model,
      label,
      parameterSize,
      quantization,
      tier,
      engine: 'llama-cpp',
      runId: run.id,
      suiteId: 'core',
      grantedContextTokens: [...contexts][0],
      taskMeasurements: [...new Set(cells.map((cell) => cell.journal))].map((journal) =>
        measurementGroup(cells, journal),
      ),
      runtime: {
        contextTokens: [...contexts][0],
        kvCacheType: [...kv][0],
        peakMemoryMb: Math.round(median(cells.map((c) => c.peakRssMb).filter((n) => n > 0))),
      },
      cells: scenarioIds.map((scenarioId) => {
        const trials = cells.filter((c) => c.scenario === scenarioId);
        assert(trials.length > 0 && trials.length <= 3);
        return {
          scenarioId,
          trials: trials.length,
          successes: trials.filter((c) => c.success).length,
          nonModelFailures: trials.filter((c) => c.failureClass === 'infra').length,
          medianDurationMs: Math.round(median(trials.map((c) => c.durationMs))),
        };
      }),
    };
  });
  return ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [run], results });
});
assert.equal(cellRound.size, 264);
const dataset = ScorecardDatasetSchema.parse({
  schemaVersion: 1,
  runs: shards
    .flatMap((s) => s.runs)
    .toSorted((a, b) => b.provenance.startedAt.localeCompare(a.provenance.startedAt)),
  results: shards.flatMap((s) => s.results),
});

const trials = final.cells.map((cell) => {
  const result = read(`${cell.runDir}/result.json`);
  const score = read(`${cell.runDir}/score.json`);
  assert.equal(result.trialId, cell.trialId);
  assert.equal(result.success, cell.success);
  assert.equal(result.scenarioId, cell.scenario);
  assert.equal(result.modelId, cell.model);
  assert.equal(score.composite, cell.fixedComposite);
  assert.equal(result.success ? 'pass' : score.eligibility.failureClass, cell.failureClass);
  if (cell.advisoryStatus === 'noArtifact') {
    assert.equal(cell.advisoryMean, null);
    assert(!cell.advisoryEligible);
  } else {
    const axes = Object.values(cell.advisoryAxes);
    assert.equal(axes.length, 4);
    assert(axes.every((v) => Number.isInteger(v) && v >= 0 && v <= 10));
    assert.equal(axes.reduce((a, b) => a + b, 0) / axes.length, cell.advisoryMean);
  }
  assert(!cell.advisoryEligible || (cell.failureClass !== 'infra' && !cell.protocolDeviation));
  const output = { ...cell, runId: cellRound.get(cell.cellId), includedInScorecard: true };
  for (const key of ['journalRoot', 'runDir', 'judgmentPath', 'evidencePath', 'postmortemPath']) {
    if (output[key]) output[key] = portable(output[key]);
  }
  output.redFlags = output.redFlags.map((flag) => ({
    ...flag,
    ...(flag.gezel && isAbsolute(flag.gezel) ? { gezel: portable(flag.gezel) } : {}),
  }));
  return output;
});

const details = {
  schemaVersion: 1,
  publicationId: '2026-10-19-windows-small-model-core',
  sourceReportSha256: sha(finalBytes),
  sourceReport: `${evidenceRoot}/final-comparison.json`,
  sourceGeneratedAt: final.generatedAt,
  complete: true,
  newInferenceCalls: 0,
  totals,
  models: final.models,
  modelMetadata: metadata,
  sources,
  rounds: rounds.map(({ id, journals, expected }) => ({ id, journals, trials: expected })),
  additionalDiagnostics: {
    ...final.additionalDiagnostics,
    includedInScorecard: false,
    note: 'Seven superseded Nanbeige 64K trials and the operator-interrupted Qwen attempt remain in the original archive, outside the 264 requested cells.',
  },
  judging: {
    provider: 'codex-inline',
    model: 'current-session',
    inputLimitBytes: 20480,
    pending: 0,
    artifactReviews: 254,
    eligibleReviews: 247,
    noArtifact: 10,
    infrastructureDiagnosticReviews: 6,
    protocolDeviationReviews: 1,
    rubricAxes: Object.fromEntries(
      [...new Set(trials.map((c) => c.rubricId))].map((id) => [
        id,
        Object.keys(trials.find((c) => c.rubricId === id && c.advisoryAxes).advisoryAxes),
      ]),
    ),
    aggregatesByJournalModelRubric: final.advisory,
    caveats: [
      'Unblinded artifact-based inline reviews; distinct rubrics are never averaged into one quality score.',
      'Missing artifacts receive no invented axes or means. Infrastructure artifact reviews are diagnostic only.',
      'One original Saluki petshop review exposed 21,664 bytes, exceeding the combined 20 KiB cap by 1,184; its advisory score is excluded. Its deterministic result is unchanged.',
      'Some early reviews lack contemporaneous content hashes. Current archive hashes cannot prove historical review bytes; verifiedAgainstRecorded retains the distinction.',
    ],
  },
  performance: {
    source: 'engine-log',
    aggregatesByJournalAndModel: final.groups,
    caveats: [
      'Task performance tables show per-trial engine-log medians, ranges and sample counts; admission-probe fields remain absent.',
      'System RSS is not total footprint on this discrete GPU. Per-trial GPU memory is reported separately.',
      'A and B have different runtime hashes. Nanbeige is a separate 32K cohort. Imported cells occur once only.',
      'N1-N2 ran on Oct 20. N3-N4 observed restricted GPU performance on Oct 22. N5 spans the uncommanded throughput change after 14:00Z. N6-N12 ran after that change. Journals are not a normalized speed comparison.',
      'A 33 W power cap and 810 MHz memory were observed earlier on Oct 22. Later throughput recovery has no established cause; no operator power/tuning changes were made.',
    ],
  },
  trials,
  evidenceHashes,
};
const files = new Map();
const addJson = (path, value) => files.set(path, `${JSON.stringify(value, null, 2)}\n`);
for (const shard of shards) {
  const filename = `${shard.runs[0].id}.json`;
  addJson(`packages/core/src/scorecard/data/runs/${filename}`, shard);
  addJson(`${destination}/runs/${filename}`, shard);
}
addJson(`${destination}/scorecard.json`, dataset);
addJson(`${destination}/scorecard-details.json`, details);
addJson(`${destination}/verification.json`, {
  sourceReportSha256: sha(finalBytes),
  uniqueCells: cellRound.size,
  totals,
  originalEvidenceModified: false,
  evidenceHashesVerified: evidenceHashes.length,
  duplicateImports: 0,
  classificationCorrections: 0,
  newInferenceCalls: 0,
  schemas: ['ScorecardDatasetSchema v1'],
  standardTableQuality:
    'rubric-specific advisory means and sample counts by journal; missing and excluded reviews reported separately',
  standardTablePerformance:
    'per-trial engine-log medians, ranges and sample counts by journal; no admission probes inferred',
});
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  sourceReportSha256: sha(finalBytes),
  regenerate:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-small-model-core-scorecard.mjs',
  check:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-small-model-core-scorecard.mjs --check',
  files: [...files].map(([path, bytes]) => ({
    path,
    bytes: Buffer.byteLength(bytes),
    sha256: sha(bytes),
  })),
});
for (const [path, bytes] of files) {
  const machinePath = /(?:^|[\s"'(])[A-Za-z]:[\\/]|\\\\Users\\\\|\/Users\//.exec(bytes);
  assert(
    !machinePath,
    `Machine path in public output: ${path} near ${machinePath ? bytes.slice(machinePath.index, machinePath.index + 160) : ''}`,
  );
}
for (const [path, bytes] of files) {
  if (check)
    assert.equal(readFileSync(resolve(root, path), 'utf8'), bytes, `Publication drift: ${path}`);
  else {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    if (!existsSync(resolve(root, path)) || readFileSync(resolve(root, path), 'utf8') !== bytes) {
      writeFileSync(resolve(root, path), bytes);
    }
  }
}
console.log(
  `${check ? 'Verified' : 'Wrote'} ${files.size} publication files; 264 unique trials, 3 runtime rounds, 247 eligible artifact reviews.`,
);
