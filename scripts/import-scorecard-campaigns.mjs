#!/usr/bin/env node
/** Import reviewed campaign evidence without starting trials or rewriting raw results. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NON_MODEL_CLASSES = ['infra', 'operator', 'grader'];
const CELL_IDENTITY = ['scenario', 'suite', 'model', 'provider', 'targetId'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * A harness rerun may stand in for excluded trials only when everything the
 * models ran against is identical and the evaluator changed exactly the files
 * declared. Otherwise it is a different observation and belongs in its own round.
 */
function assertSameSystemUnderTest(original, rerun, harnessChanges) {
  assert(
    Array.isArray(harnessChanges) && harnessChanges.length > 0,
    'Name the harness files the rerun changed',
  );
  assert.equal(rerun.source.head, original.source.head, 'Rerun started from a different commit');
  assert.equal(
    rerun.service.sha256,
    original.service.sha256,
    'Rerun used a different service build',
  );
  assert.equal(rerun.gilde.sha256, original.gilde.sha256, 'Rerun used a different catalog');
  assert.equal(
    rerun.environmentHash,
    original.environmentHash,
    'Rerun used a different environment',
  );
  for (const key of ['device', 'runtime', 'localInstalls', 'imageBinary'])
    assert.deepEqual(rerun[key], original[key], `Rerun used a different ${key}`);
  for (const [cli, version] of Object.entries(rerun.cliVersions ?? {}))
    assert.equal(original.cliVersions?.[cli], version, `Rerun used a different ${cli} version`);
  const before = original.fixtures?.manifest ?? {};
  const after = rerun.fixtures?.manifest ?? {};
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (file) => before[file] !== after[file],
  );
  assert.deepEqual(
    changed.toSorted(),
    harnessChanges.toSorted(),
    'Rerun changed different harness files than declared',
  );
}

export function importCampaign(root, specification) {
  const inputs = new Map();
  const read = (name) => {
    const path = resolve(root, name);
    const portable = relative(root, path).replaceAll('\\', '/');
    assert(
      !portable.startsWith('../') && !isAbsolute(portable),
      'Evidence must be inside the checkout',
    );
    const bytes = readFileSync(path);
    inputs.set(portable, digest(bytes));
    return JSON.parse(bytes);
  };
  assert(
    Number.isInteger(specification.count) && specification.count > 0,
    'Explicit repeat count required',
  );
  assert(['suite', 'subset'].includes(specification.scope), 'Explicit coverage scope required');
  assert(/^[a-z0-9][a-z0-9-]+$/.test(specification.runId), 'Unsafe run id');

  const loadJournal = (source) => {
    const campaignPath = `${source.campaignRoot}/campaign.json`;
    const campaign = read(campaignPath);
    assert.equal(inputs.get(campaignPath), source.campaignSha256, 'Campaign changed since review');
    assert(
      !campaign.running && !existsSync(resolve(root, source.campaignRoot, 'campaign.lock')),
      'Campaign is active',
    );
    const rows = campaign.rows.filter((row) => row.cell.repetition <= specification.count);
    assert(rows.length > 0, 'No recorded trials');
    assert.equal(rows.length, source.expectedTrials, 'Unexpected trial count');
    const seen = new Set();
    const entries = rows.map((row) => {
      assert(!seen.has(row.cell.id), 'Duplicate trial cell');
      seen.add(row.cell.id);
      const resultPath = `${row.result.runDir}/result.json`;
      const scorePath = `${row.result.runDir}/score.json`;
      const result = read(resultPath);
      const score = read(scorePath);
      assert.deepEqual(result, row.result, 'Journal and raw result disagree');
      assert.deepEqual(score, row.score, 'Journal and fixed score disagree');
      assert.equal(result.trialId, score.trialId);
      assert.equal(result.scenarioId, row.cell.scenario);
      assert.equal(result.modelId, row.cell.model);
      assert.equal(result.engine, row.cell.provider);
      const rawClass = result.success
        ? 'pass'
        : (score.eligibility?.failureClass ?? result.failureClass ?? 'model');
      return {
        row,
        observation: {
          cell: row.cell,
          trialId: result.trialId,
          success: result.success,
          durationMs: result.durationMs,
          startedAt: result.startedAt,
          originalFailureClass: rawClass,
          publishedFailureClass: rawClass,
          fixedComposite: score.composite,
          resultPath: relative(root, resolve(root, resultPath)).replaceAll('\\', '/'),
          scorePath: relative(root, resolve(root, scorePath)).replaceAll('\\', '/'),
        },
      };
    });
    return { campaign, entries };
  };

  const { campaign, entries: recorded } = loadJournal(specification);
  const recordedIds = new Set(recorded.map((entry) => entry.row.cell.id));
  const corrections = new Map();
  for (const correction of specification.classificationCorrections ?? []) {
    assert(!corrections.has(correction.cellId), 'Duplicate classification correction');
    assert(
      NON_MODEL_CLASSES.includes(correction.failureClass),
      'Correction must explain a non-model failure',
    );
    assert(
      correction.reason && correction.evidence.length > 0,
      'Correction needs a diagnosis and evidence',
    );
    for (const evidence of correction.evidence) read(evidence);
    corrections.set(correction.cellId, correction);
  }
  // Exclusions remove trials that never exercised the model (the harness broke
  // first). Unlike corrections they leave no published observation behind.
  const exclusions = new Map();
  for (const exclusion of specification.excludedTrials ?? []) {
    assert(!exclusions.has(exclusion.cellId), 'Duplicate exclusion');
    assert(!corrections.has(exclusion.cellId), 'A trial cannot be both corrected and excluded');
    assert(
      exclusion.reason && exclusion.evidence?.length > 0,
      'Exclusion needs a diagnosis and evidence',
    );
    for (const evidence of exclusion.evidence) read(evidence);
    exclusions.set(exclusion.cellId, exclusion);
  }
  for (const id of [...corrections.keys(), ...exclusions.keys()])
    assert(recordedIds.has(id), 'Correction or exclusion names an unrecorded cell');

  const published = [];
  for (const { row, observation } of recorded) {
    const correction = corrections.get(row.cell.id);
    const exclusion = exclusions.get(row.cell.id);
    assert(
      !(correction || exclusion) || !observation.success,
      'Cannot discard a passing observation',
    );
    if (exclusion) continue;
    published.push({
      row,
      observation: correction
        ? {
            ...observation,
            publishedFailureClass: correction.failureClass,
            classificationCorrection: correction,
          }
        : observation,
    });
  }

  const rerunSpec = specification.harnessRerun;
  let rerun = null;
  if (rerunSpec) {
    rerun = loadJournal(rerunSpec);
    assertSameSystemUnderTest(campaign.identity, rerun.campaign.identity, rerunSpec.harnessChanges);
    for (const { row, observation } of rerun.entries) {
      assert(exclusions.has(row.cell.id), 'A harness rerun may only replace an excluded trial');
      const original = recorded.find((entry) => entry.row.cell.id === row.cell.id).row.cell;
      for (const key of CELL_IDENTITY)
        assert.equal(
          row.cell[key],
          original[key],
          'Harness rerun cell does not match the original',
        );
      published.push({ row, observation: { ...observation, harnessRerun: true } });
    }
  }
  const observations = published.map((entry) => entry.observation);

  const definition = campaign.definition;
  const scenariosBySuite = {};
  for (const scenario of definition.scenarios) {
    scenariosBySuite[scenario.suite] ??= [];
    const ids = scenariosBySuite[scenario.suite];
    assert(!ids.includes(scenario.id), 'Duplicate scenario in suite');
    ids.push(scenario.id);
  }
  const results = [];
  for (const target of definition.targets) {
    const metadata = specification.models[target.id];
    assert(metadata, `Missing model display metadata: ${target.id}`);
    assert(
      Object.keys(metadata).every((key) =>
        ['label', 'tier', 'parameterSize', 'quantization'].includes(key),
      ),
      'Display metadata must not override trial identity',
    );
    for (const [suiteId, scenarios] of Object.entries(scenariosBySuite)) {
      const selected = published
        .map((entry) => entry.row)
        .filter((row) => row.cell.targetId === target.id && row.cell.suite === suiteId);
      const cells = scenarios.map((scenarioId) => {
        const trials = observations.filter(
          (o) =>
            o.cell.targetId === target.id &&
            o.cell.suite === suiteId &&
            o.cell.scenario === scenarioId,
        );
        assert(trials.length <= specification.count, 'More repeats than declared');
        return {
          scenarioId,
          trials: trials.length,
          successes: trials.filter((t) => t.success).length,
          nonModelFailures: trials.filter(
            (t) => !t.success && NON_MODEL_CLASSES.includes(t.publishedFailureClass),
          ).length,
          ...(trials.length
            ? { medianDurationMs: Math.round(median(trials.map((t) => t.durationMs))) }
            : {}),
        };
      });
      const contexts = selected
        .map((row) => row.result.engineContext?.grantedPerSlotTokens)
        .filter((n) => n > 0);
      const memories = selected.map((row) => row.metrics?.process?.peakRssMb).filter((n) => n > 0);
      const context =
        contexts.length && contexts.every((v) => v === contexts[0]) ? contexts[0] : null;
      results.push({
        modelId: target.model,
        engine: target.provider,
        ...metadata,
        runId: specification.runId,
        suiteId,
        cells,
        ...(context && memories.length
          ? { runtime: { contextTokens: context, peakMemoryMb: Math.round(median(memories)) } }
          : {}),
      });
    }
  }
  const identity = campaign.identity;
  const dataset = ScorecardDatasetSchema.parse({
    schemaVersion: 1,
    runs: [
      {
        id: specification.runId,
        scope: specification.scope,
        provenance: {
          startedAt: observations.map((o) => o.startedAt).sort()[0],
          device: identity.device,
          harnessCommit: identity.source.head.slice(0, 12),
          // A merged harness rerun has two checkout hashes that differ only in
          // evaluator files; the service build and catalog hashes are shared.
          ...(rerun ? {} : { sourceHash: identity.source.sha256 }),
          serviceBuildHash: identity.service.sha256,
          catalogHash: identity.gilde.sha256,
          gildeVersion: identity.gilde.version,
          count: specification.count,
          // Inline axes differ by task and are retained in their evidence files,
          // not pooled into the single-judge column used by historical sweeps.
          judgeModelId: null,
        },
        suites: Object.keys(scenariosBySuite),
        scenariosBySuite,
        note: specification.note,
      },
    ],
    results,
  });
  assert.equal(
    results.reduce((sum, result) => sum + result.cells.reduce((n, cell) => n + cell.trials, 0), 0),
    observations.length,
    'A trial was omitted or counted twice',
  );
  const audit = {
    runId: specification.runId,
    campaignRoot: specification.campaignRoot,
    recordedTrials: recorded.length,
    excludedTrials: [...exclusions.values()].map(({ cellId, reason }) => ({ cellId, reason })),
    ...(rerun
      ? {
          harnessRerun: {
            campaignRoot: rerunSpec.campaignRoot,
            harnessChanges: rerunSpec.harnessChanges,
            trials: rerun.entries.length,
            sourceHashes: [identity.source.sha256, rerun.campaign.identity.source.sha256],
          },
        }
      : {}),
    publishedTrials: observations.length,
    passedTrials: observations.filter((o) => o.success).length,
    failedTrials: observations.filter((o) => !o.success).length,
    unrunCells: results.reduce(
      (n, result) => n + result.cells.filter((cell) => !cell.trials).length,
      0,
    ),
    classificationCorrections: corrections.size,
    originalRawEvidenceModified: false,
    scope: specification.scope,
    inputSha256: Object.fromEntries(inputs),
    observations,
    ...(campaign.identityCorrections
      ? { priorIdentityCorrections: campaign.identityCorrections }
      : {}),
  };
  return { dataset, audit };
}

export function importCampaigns(root, manifestPath, check = false) {
  const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'));
  const imports = manifest.campaigns.map((specification) => importCampaign(root, specification));
  const output = resolve(root, 'packages/core/src/scorecard/data/runs');
  const persist = (path, value) => {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    if (check)
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), value, `Publication drift: ${path}`);
    else {
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path) || !isDeepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), value))
        writeFileSync(path, bytes);
    }
  };
  for (const { dataset } of imports)
    persist(resolve(output, `${dataset.runs[0].id}.json`), dataset);
  persist(resolve(root, manifest.auditPath), {
    schemaVersion: 1,
    manifest: manifestPath,
    newInferenceCalls: 0,
    note: 'Recorded pass/fail and fixed scores are unchanged. Reviewed non-model failures stay recorded and are attributed away from the model. Trials the evaluator broke before the model could act are excluded; a harness rerun replaces them only on an identical service build, catalog and CLI version. Rounds on different builds are never merged.',
    campaigns: imports.map(({ audit }) => audit),
  });
  return imports;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestPath, ...flags] = process.argv.slice(2);
  assert(
    manifestPath && flags.every((flag) => flag === '--check'),
    'Usage: import-scorecard-campaigns.mjs <manifest.json> [--check]',
  );
  const imported = importCampaigns(repoRoot, manifestPath, flags.includes('--check'));
  for (const { audit } of imported)
    console.log(
      `${audit.runId}: ${audit.passedTrials}/${audit.publishedTrials} passes published; ${audit.excludedTrials.length} excluded; ${audit.harnessRerun?.trials ?? 0} from a harness rerun; ${audit.unrunCells} unrun; ${audit.classificationCorrections} reviewed non-model failures`,
    );
}
