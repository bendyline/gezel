#!/usr/bin/env node
/**
 * Publish the 2026-11-11 Windows small-model sweep from its local evidence.
 *
 *   node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-small-outcome-bare-scorecard.mjs --prepare --gilde-tarball=<bendyline-gilde-0.3.8.tgz> --gilde-dir=<its extracted package/>
 *   node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-small-outcome-bare-scorecard.mjs
 *   node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-small-outcome-bare-scorecard.mjs --check
 *
 * `--prepare` freezes what later code could change into the archive's
 * `publication-inputs.json`: the judge plan from the scenario registry at the
 * run's commit, each judged deliverable's hash, and the model install records
 * checked against the exact Gilde release the run pinned. The default mode
 * reads only frozen evidence. It never runs inference, the judge or a rescore.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicationId = '2026-11-11-windows-small-outcome-bare';
const sourceRoot = `evals/runs/scorecard-${publicationId}`;
const destination = `docs/handboek/assets/scorecards/${publicationId}`;
const shardPath = `packages/core/src/scorecard/data/runs/${publicationId}.json`;
const inputsName = 'publication-inputs.json';
const harnessCommit = '92437e37';
/**
 * The code that ran is one commit older than the checkout. packages/service/dist
 * was last built at 2026-11-11 09:18 local, after pulling 7e7fb07c (09:12) and
 * before pulling 92437e37 (11:23), and the preflight fingerprints, which include
 * the daemon entry's size and mtime, stayed constant for every model through the
 * run. 92437e37 changed no evals code; it changed core, service, catalog and MCP
 * (project-type updates), none of which reached the daemon.
 */
const builtFrom = '7e7fb07c';
const gildeVersion = '0.3.8';
const judgeId = 'anthropic-cli/claude-sonnet-5-5';
const hostname = 'mikeam-gdev';
const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const check = args.includes('--check');
const prepare = args.includes('--prepare');
assert(!(check && prepare), 'Choose --prepare or --check, not both');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const n = (value) => value.toLocaleString('en-US');
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const at = (iso) => Date.parse(iso);

/**
 * Power state, in UTC, from the G-Helper log (`%APPDATA%\GHelper\log.txt`,
 * local time UTC-8). The plugged-in mode was Silent ("Mode = 2") from before
 * the start until 2026-11-16 6:17:15 AM, when it moved to Turbo ("Mode = 1").
 * nvidia-smi read an enforced 45 W limit under Silent and about 77 W under
 * Turbo. On battery G-Helper switches to Balanced ("Mode = 0").
 */
const TURBO_FROM = '2026-11-16T14:17:15Z';
const BATTERY_WINDOWS = [
  // "Power Mode StatusChange: Offline" at 1:41:16 PM; the machine suspended at
  // 2:32:43 PM when the battery ran out. That cell was discarded and rerun.
  { from: '2026-11-16T21:41:16Z', to: '2026-11-16T22:32:43Z' },
  // Offline 11:36:21 AM, back online 11:58:05 AM.
  { from: '2026-11-24T19:36:21Z', to: '2026-11-24T19:58:05Z' },
];
/** Kernel-Power 506 (enter) / 507 (exit) Modern Standby pairs during the run. */
const STANDBY_WINDOWS = [
  { from: '2026-11-12T03:27:04Z', to: '2026-11-12T06:55:19Z' },
  { from: '2026-11-12T07:16:40Z', to: '2026-11-12T13:57:19Z' },
  { from: '2026-11-12T22:38:51Z', to: '2026-11-14T15:41:34Z' },
];
const PERIODS = {
  silent: {
    id: 'silent-45w',
    label: 'Plugged in, G-Helper Silent · 45 W GPU limit',
  },
  turbo: {
    id: 'turbo-77w',
    label: 'Plugged in, G-Helper Turbo · about 77 W GPU limit',
  },
  battery: {
    id: 'battery-overlap',
    label: 'Partly on battery, G-Helper Balanced',
  },
};
const overlaps = (trial, window) =>
  at(trial.startedAt) < at(window.to) && at(trial.finishedAt) > at(window.from);
const periodFor = (trial) =>
  BATTERY_WINDOWS.some((window) => overlaps(trial, window))
    ? PERIODS.battery
    : at(trial.startedAt) < at(TURBO_FROM)
      ? PERIODS.silent
      : PERIODS.turbo;

const sourceFiles = {};
function evidence(name) {
  const path = resolve(root, sourceRoot, name);
  const bytes = readFileSync(path);
  sourceFiles[name] = sha(bytes);
  return bytes;
}
const json = (bytes) => JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
const prior = JSON.parse(readFileSync(resolve(root, shardPath), 'utf8'));
const priorRun = prior.runs[0];
assert.equal(prior.runs.length, 1);
assert.equal(priorRun.id, publicationId);
const suites = priorRun.suites;
assert.deepEqual(suites, ['core', 'productivity', 'developer', 'complex-work']);
const models = [...new Set(prior.results.map((result) => result.modelId))].sort();
assert.equal(models.length, 14);

/** Trial directories in the order the cell summaries list them. */
function trialDirs() {
  const out = [];
  for (const modelId of models) {
    for (const suiteId of suites) {
      for (const scenarioId of priorRun.scenariosBySuite[suiteId]) {
        const cell = `${modelId}/${suiteId}/${scenarioId}`;
        const summary = json(evidence(`${cell}/summary.json`));
        const present = readdirSync(resolve(root, sourceRoot, cell)).filter((name) =>
          statSync(resolve(root, sourceRoot, cell, name)).isDirectory(),
        );
        assert.deepEqual(
          present.toSorted(),
          summary.trialIds.toSorted(),
          `Stray trials in ${cell}`,
        );
        assert.equal(summary.trialIds.length, 3, `${cell} needs three trials`);
        for (const trialId of summary.trialIds)
          out.push({ modelId, suiteId, scenarioId, trialId, dir: `${cell}/${trialId}` });
      }
    }
  }
  return out;
}

/** Mirrors evals/src/trial-llm-judge.ts `resolveJudgeArtifact` at the run's commit. */
function resolveJudgeArtifact(runDir, rubric) {
  if (rubric.rubric === 'scenario') {
    const walk = (dir) => {
      let names;
      try {
        names = readdirSync(dir);
      } catch {
        return null;
      }
      for (const name of names) {
        const full = join(dir, name);
        let stats;
        try {
          stats = statSync(full);
        } catch {
          continue;
        }
        const found = stats.isDirectory()
          ? walk(full)
          : name === rubric.artifactBasename
            ? full
            : null;
        if (found) return found;
      }
      return null;
    };
    return walk(join(runDir, 'workspace')) ?? walk(join(runDir, 'artifacts'));
  }
  let projects;
  try {
    projects = readdirSync(join(runDir, 'workspace'));
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = join(runDir, 'workspace', project, rubric.htmlDeliverable);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this project.
    }
  }
  return null;
}

if (prepare) {
  const tarball = flag('gilde-tarball');
  const gildeDir = flag('gilde-dir');
  assert(tarball && gildeDir, 'Pass --gilde-tarball=<.tgz> and --gilde-dir=<extracted package/>');
  assert.equal(
    JSON.parse(readFileSync(join(gildeDir, 'package.json'), 'utf8')).version,
    gildeVersion,
  );
  const tarballBytes = readFileSync(tarball);
  const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;
  const { SCENARIOS } = await import(
    pathToFileURL(resolve(root, 'evals/src/scenarios/index.ts')).href
  );
  const { suiteScenarios } = await import(pathToFileURL(resolve(root, 'evals/src/suites.ts')).href);
  const rubrics = {};
  for (const suiteId of suites) {
    assert.deepEqual(
      suiteScenarios(suiteId).map((scenario) => scenario.id),
      priorRun.scenariosBySuite[suiteId],
      `${suiteId} membership moved since the run`,
    );
    for (const scenarioId of priorRun.scenariosBySuite[suiteId]) {
      const scenario = SCENARIOS[scenarioId];
      rubrics[scenarioId] = scenario.judge
        ? {
            rubric: 'scenario',
            artifactBasename: scenario.judge.artifactBasename,
            artifactKind: scenario.judge.artifactKind ?? null,
            axes: scenario.judge.axes ?? null,
          }
        : scenario.htmlDeliverable
          ? { rubric: 'default-html', htmlDeliverable: scenario.htmlDeliverable }
          : null;
    }
  }
  const artifacts = {};
  for (const trial of trialDirs()) {
    const rubric = rubrics[trial.scenarioId];
    if (!rubric) continue;
    const runDir = resolve(root, sourceRoot, trial.dir);
    const found = resolveJudgeArtifact(runDir, rubric);
    artifacts[trial.trialId] = found
      ? {
          path: found.slice(runDir.length + 1).replaceAll('\\', '/'),
          bytes: statSync(found).size,
          sha256: sha(readFileSync(found)),
        }
      : null;
  }
  const chatModels = join(gildeDir, 'data', 'chat-models');
  const installs = {};
  for (const modelId of models) {
    const record = JSON.parse(
      readFileSync(
        join(
          homedir(),
          '.gezel-eval-cache',
          'engines',
          'llama-cpp',
          'models',
          modelId,
          'manifest.json',
        ),
        'utf8',
      ),
    );
    const family = readdirSync(chatModels).find((prefix) =>
      existsSync(join(chatModels, prefix, modelId, 'manifest.json')),
    );
    assert(family, `${modelId} is not in Gilde ${gildeVersion}`);
    const identity = JSON.parse(
      readFileSync(join(chatModels, family, modelId, 'manifest.json'), 'utf8'),
    );
    const version = JSON.parse(
      readFileSync(
        join(chatModels, family, modelId, 'versions', record.catalogVersion, 'manifest.json'),
        'utf8',
      ),
    );
    assert.equal(record.id, modelId);
    assert.equal(record.name, identity.name, `${modelId} name differs from Gilde`);
    assert.equal(record.weightsFilename, version.llamaCpp.filename, `${modelId} weights differ`);
    assert.equal(record.sha256, version.llamaCpp.sha256, `${modelId} weights hash differs`);
    installs[modelId] = {
      name: record.name,
      quantization: record.quantization,
      catalogVersion: record.catalogVersion,
      huggingfaceRepo: record.huggingfaceRepo,
      weightsFilename: record.weightsFilename,
      weightsSha256: record.sha256,
      installedAt: record.installedAt,
      architecture: record.architecture ?? null,
      catalogParameterSize: identity.parameterSize ?? null,
      catalogContextWindow: identity.contextWindow ?? null,
    };
  }
  const inputs = {
    schemaVersion: 1,
    publicationId,
    harnessCommit,
    gilde: {
      version: gildeVersion,
      tarball: `@bendyline/gilde@${gildeVersion}`,
      integrity,
      tarballSha256: sha(tarballBytes),
    },
    rubrics,
    artifacts,
    installs,
  };
  writeFileSync(resolve(root, sourceRoot, inputsName), `${JSON.stringify(inputs, null, 2)}\n`);
  console.log(
    JSON.stringify({
      mode: 'prepared',
      judgeable: Object.keys(artifacts).length,
      withArtifact: Object.values(artifacts).filter(Boolean).length,
      models: Object.keys(installs).length,
    }),
  );
  process.exit(0);
}

const inputs = json(evidence(inputsName));
assert.equal(inputs.harnessCommit, harnessCommit);
assert.equal(inputs.gilde.version, gildeVersion);
const judgeReport = json(evidence('judge-report.json'));
assert.deepEqual(judgeReport.judgeModels, ['claude-sonnet-5-5']);
const reportByTrial = new Map(judgeReport.perTrial.map((entry) => [entry.trialId, entry]));

const LAUNCH = /\[llama-server\] launch (\{.*\})\s*$/;
const OFFLOAD = /offload plan \(([^)]+)\): (.*)$/;
const sanitize = (value) => {
  if (typeof value === 'string')
    return value
      .replaceAll(`${root.replaceAll('\\', '/')}/`, '')
      .replaceAll(`${root}\\`, '')
      .replaceAll(hostname, '<host>')
      .replace(/\b[A-Za-z]:\\Program Files(?: \(x86\))?\\/g, '<program-files>\\')
      .replace(/\b[A-Za-z]:[\\/][^\s"'<>)]*/g, '<local-path>');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitize(k), sanitize(v)]));
  return value;
};

const trials = trialDirs().map((entry) => {
  const files = {};
  const read = (name) => {
    const bytes = evidence(`${entry.dir}/${name}`);
    files[name] = sourceFiles[`${entry.dir}/${name}`];
    return bytes;
  };
  const result = json(read('result.json'));
  const metrics = json(read('metrics.json'));
  const host = json(read('host.json'));
  const log = read('daemon.log').toString('utf8');
  const judgePath = resolve(root, sourceRoot, entry.dir, 'llm-judge.json');
  const judge = existsSync(judgePath) ? json(read('llm-judge.json')) : null;
  assert.equal(result.trialId, entry.trialId);
  assert.equal(result.modelId, entry.modelId);
  assert.equal(result.scenarioId, entry.scenarioId);
  assert.equal(host.frameworkVariant, 'cuda');
  assert.equal(host.frameworkBuild.revision, 'cd959bae99ff4bed22bef2604f45241c09bbb8c8');
  const launches = [];
  const offload = new Set();
  for (const line of log.split(/\r?\n/)) {
    const launch = LAUNCH.exec(line);
    if (launch) launches.push(JSON.parse(launch[1]));
    const plan = OFFLOAD.exec(line);
    if (plan && plan[1] === entry.modelId) offload.add(plan[2]);
  }
  for (const launch of launches) {
    assert.equal(launch.nativeRelease, '0.1.62');
    assert.equal(launch.backend, 'cuda');
    assert.equal(launch.upstreamRevision, host.frameworkBuild.revision);
    assert.equal(launch.cudaToolkit, '12.8');
  }
  const engineRan = launches.length > 0;
  assert(engineRan || result.failureClass === 'infra', `${entry.trialId} never launched an engine`);
  const outcome = {
    success: result.success,
    failureMode: result.failureMode ?? null,
    failureClass: result.success ? null : result.failureClass,
    failureClassRule: result.success ? null : result.failureClassRule,
    reason: result.reason,
  };
  if (!result.success) assert(['model', 'infra'].includes(result.failureClass));
  const rubricPlan = inputs.rubrics[entry.scenarioId];
  const planned = rubricPlan ? inputs.artifacts[entry.trialId] : undefined;
  let review;
  if (!rubricPlan) {
    assert.equal(judge, null, `${entry.trialId} judged without a rubric`);
    review = { status: 'notApplicable' };
  } else if (!judge) {
    assert.equal(planned, null, `${entry.trialId} has a deliverable but no review`);
    assert(!reportByTrial.has(entry.trialId));
    review = { status: 'noArtifact', rubricId: rubricIdFor(rubricPlan, entry.scenarioId) };
  } else {
    assert(planned, `${entry.trialId} reviewed without a deliverable`);
    evidence(`${entry.dir}/${planned.path}`);
    assert.equal(sourceFiles[`${entry.dir}/${planned.path}`], planned.sha256);
    const fromReport = reportByTrial.get(entry.trialId);
    assert(fromReport, `${entry.trialId} missing from the judge report`);
    assert.equal(fromReport.meanScore, judge.meanScore);
    assert.equal(fromReport.rubric, rubricPlan.rubric);
    assert.deepEqual(fromReport.scoreAxes, judge.scoreAxes);
    assert.equal(judge.judgeProvider, 'anthropic-cli');
    assert.equal(judge.judgeModel, 'claude-sonnet-5-5');
    const axes = Object.values(judge.scoreAxes);
    assert(axes.length > 0 && axes.every((n) => Number.isInteger(n) && n >= 0 && n <= 10));
    assert(Math.abs(mean(axes) - judge.meanScore) <= 0.05 + 1e-9);
    review = {
      status: 'judged',
      rubricId: rubricIdFor(rubricPlan, entry.scenarioId),
      judgeProvider: judge.judgeProvider,
      judgeModel: judge.judgeModel,
      scoreAxes: judge.scoreAxes,
      axisMean: round(mean(axes), 4),
      recordedMeanScore: judge.meanScore,
      justification: judge.justification,
      reviewDurationMs: judge.durationMs,
      artifact: planned,
    };
  }
  const usage = metrics.usage ?? {};
  const derived = metrics.derived ?? {};
  const speed = usage.source === 'engine-log';
  const positive = (value) => (typeof value === 'number' && value > 0 ? value : null);
  const performance = {
    usageSource: usage.source ?? null,
    decodeTokensPerSec: speed ? positive(derived.genTokensPerSec) : null,
    prefillTokensPerSec: speed ? positive(derived.promptTokensPerSec) : null,
    inputTokens: speed ? (usage.totalInputTokens ?? null) : null,
    outputTokens: speed ? (usage.totalOutputTokens ?? null) : null,
    peakRssMb: engineRan ? positive(metrics.process?.peakRssMb) : null,
    peakCpuPercent: engineRan ? (metrics.process?.peakCpuPercent ?? null) : null,
    peakGpuMemMb: engineRan ? positive(metrics.gpu?.peakMemUsedMb) : null,
    peakGpuUtilPercent: engineRan ? (metrics.gpu?.peakUtilPercent ?? null) : null,
    gpuMemTotalMb: metrics.gpu?.memTotalMb ?? null,
    peakSystemMemMb: engineRan ? (metrics.systemMemory?.peakUsedMb ?? null) : null,
    systemMemTotalMb: metrics.systemMemory?.totalMb ?? null,
    telemetrySamples: metrics.process?.sampleCount ?? 0,
  };
  const first = launches[0];
  return {
    trialId: entry.trialId,
    modelId: entry.modelId,
    suiteId: entry.suiteId,
    scenarioId: entry.scenarioId,
    evidencePath: entry.dir,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    period: periodFor(result).id,
    outcome,
    capabilityEligible: result.success || result.failureClass === 'model',
    finalSniff: result.finalSniff ?? null,
    engine: first
      ? {
          launches: launches.length,
          nativeRelease: first.nativeRelease,
          upstreamRevision: first.upstreamRevision,
          cudaToolkit: first.cudaToolkit,
          driverVersion: first.driverVersion,
          gpu: first.gpu,
          contextPerSlot: first.contextPerSlot,
          slots: first.slots,
          kvCacheType: first.kvCacheType,
          reasoningBudgetTokens: first.reasoningBudgetTokens ?? null,
          offloadPlan: [...offload],
        }
      : null,
    performance,
    review,
    evidenceHashes: files,
  };
});

function rubricIdFor(plan, scenarioId) {
  return plan.rubric === 'default-html' ? 'default-html-v1' : scenarioId;
}

assert.equal(trials.length, 1806);
for (const trial of trials) {
  for (const window of STANDBY_WINDOWS)
    assert(!overlaps(trial, window), `${trial.trialId} overlaps Modern Standby`);
  if (trial.period === PERIODS.battery.id) continue;
  const lost = BATTERY_WINDOWS[0];
  assert(
    at(trial.startedAt) >= at('2026-11-17T12:58:15Z') || at(trial.finishedAt) <= at(lost.from),
    `${trial.trialId} ran between the power loss and Turbo's restore`,
  );
}
const fullGpu = /— full GPU residency$/;
const spill = /exceed VRAM .* — leaving whole-layer fit to the engine$/;
const residency = {};
for (const modelId of models) {
  const plans = trials
    .filter((trial) => trial.modelId === modelId && trial.engine)
    .flatMap((trial) => trial.engine.offloadPlan);
  const fits = plans.every((plan) => fullGpu.test(plan));
  const spills = plans.every((plan) => spill.test(plan));
  assert(plans.length > 0 && (fits || spills), `${modelId} has mixed offload plans`);
  residency[modelId] = fits ? 'full-gpu' : 'cpu-spill';
}
assert.deepEqual(
  Object.entries(residency).filter(([, value]) => value === 'cpu-spill'),
  [['granite4.2-8b-q4', 'cpu-spill']],
);
for (const [modelId, install] of Object.entries(inputs.installs)) {
  const firstTrial = trials
    .filter((trial) => trial.modelId === modelId)
    .map((trial) => trial.startedAt)
    .sort()[0];
  assert(at(install.installedAt) < at(firstTrial), `${modelId} reinstalled after its trials began`);
}

const observation = (values) => {
  const present = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (present.length === 0) return undefined;
  return {
    samples: present.length,
    median: round(median(present), 2),
    min: round(Math.min(...present), 2),
    max: round(Math.max(...present), 2),
  };
};
const priorRow = (modelId, suiteId) => {
  const row = prior.results.find((r) => r.modelId === modelId && r.suiteId === suiteId);
  assert(row, `${modelId}/${suiteId} missing from the ingested shard`);
  return row;
};
const results = [];
for (const suiteId of suites) {
  for (const modelId of models) {
    const selected = trials.filter((t) => t.modelId === modelId && t.suiteId === suiteId);
    const original = priorRow(modelId, suiteId);
    const cells = priorRun.scenariosBySuite[suiteId].map((scenarioId) => {
      const group = selected.filter((trial) => trial.scenarioId === scenarioId);
      return {
        scenarioId,
        trials: group.length,
        successes: group.filter((trial) => trial.outcome.success).length,
        nonModelFailures: group.filter((trial) => !trial.capabilityEligible).length,
        medianDurationMs: median(group.map((trial) => trial.durationMs)),
      };
    });
    assert.deepEqual(cells, original.cells, `${modelId}/${suiteId} cells differ from the ingest`);
    const granted = [
      ...new Set(selected.flatMap((t) => (t.engine ? [t.engine.contextPerSlot] : []))),
    ];
    assert.equal(granted.length, 1, `${modelId} context varied`);
    const periodIds = [...new Set(selected.map((trial) => trial.period))];
    const taskMeasurements = Object.values(PERIODS)
      .filter((period) => periodIds.includes(period.id))
      .map((period) => {
        const group = selected.filter((trial) => trial.period === period.id);
        const judged = group.filter((trial) => trial.review.status === 'judged');
        const rubricIds = [...new Set(judged.map((trial) => trial.review.rubricId))].sort();
        return {
          id: period.id,
          label: period.label,
          trials: group.length,
          source: 'engine-log',
          outputTokensPerSec: observation(group.map((t) => t.performance.decodeTokensPerSec)),
          prefillTokensPerSec: observation(group.map((t) => t.performance.prefillTokensPerSec)),
          durationMs: observation(group.filter((t) => t.engine).map((t) => t.durationMs)),
          peakRssMb: observation(group.map((t) => t.performance.peakRssMb)),
          peakGpuMemMb: observation(group.map((t) => t.performance.peakGpuMemMb)),
          judgments: rubricIds.map((rubricId) => {
            const scored = judged.filter((trial) => trial.review.rubricId === rubricId);
            return {
              meanScore: round(mean(scored.map((trial) => trial.review.axisMean)), 4),
              artifacts: scored.length,
              judgeModel: judgeId,
              rubricId,
            };
          }),
          noArtifact: group.filter((trial) => trial.review.status === 'noArtifact').length,
          excludedReviews: 0,
          notApplicableReviews: group.filter((trial) => trial.review.status === 'notApplicable')
            .length,
        };
      });
    const { judge: _ingestMean, ...kept } = original;
    results.push({
      ...kept,
      label: inputs.installs[modelId].name,
      quantization: inputs.installs[modelId].quantization,
      grantedContextTokens: granted[0],
      taskMeasurements,
      cells,
    });
  }
}

const count = (predicate) => trials.filter(predicate).length;
const counts = {
  planned: 1806,
  recorded: trials.length,
  passes: count((t) => t.outcome.success),
  modelFailures: count((t) => !t.outcome.success && t.outcome.failureClass === 'model'),
  infrastructureExclusions: count((t) => !t.capabilityEligible),
  judgeable: count((t) => t.review.status !== 'notApplicable'),
  judged: count((t) => t.review.status === 'judged'),
  noArtifact: count((t) => t.review.status === 'noArtifact'),
  notApplicable: count((t) => t.review.status === 'notApplicable'),
  excludedReviews: 0,
  speedSamples: count((t) => t.performance.decodeTokensPerSec !== null),
  periods: Object.fromEntries(
    Object.values(PERIODS).map((p) => [p.id, count((t) => t.period === p.id)]),
  ),
};
assert.deepEqual(counts, {
  planned: 1806,
  recorded: 1806,
  passes: 848,
  modelFailures: 952,
  infrastructureExclusions: 6,
  judgeable: 798,
  judged: 724,
  noArtifact: 74,
  notApplicable: 1008,
  excludedReviews: 0,
  speedSamples: 1800,
  periods: { 'silent-45w': 408, 'turbo-77w': 1393, 'battery-overlap': 5 },
});

const byModel = Object.fromEntries(
  models.map((modelId) => {
    const own = trials.filter((trial) => trial.modelId === modelId);
    const judged = own.filter((trial) => trial.review.status === 'judged');
    return [
      modelId,
      {
        label: inputs.installs[modelId].name,
        residency: residency[modelId],
        passes: own.filter((trial) => trial.outcome.success).length,
        trials: own.length,
        decodeTokensPerSec: observation(own.map((t) => t.performance.decodeTokensPerSec)),
        reviewMean: judged.length ? round(mean(judged.map((t) => t.review.axisMean)), 2) : null,
        reviewed: judged.length,
      },
    ];
  }),
);
const firstStart = trials.map((trial) => trial.startedAt).sort()[0];
const lastFinish = trials
  .map((trial) => trial.finishedAt)
  .sort()
  .at(-1);
const nativeLine =
  'Gezel native 0.1.62 · llama.cpp build 12110 · CUDA 12.8 · cd959bae99ff4bed22bef2604f45241c09bbb8c8';
const spillDecode = byModel['granite4.2-8b-q4'].decodeTokensPerSec;
const spillTrials = trials.filter((t) => t.modelId === 'granite4.2-8b-q4' && !t.outcome.success);
const spillFailures = spillTrials.length;
// The progress watchdog and the hard ceiling, which slow CPU-offloaded decode reaches mid-task.
const stalled = spillTrials.filter(
  (t) =>
    t.outcome.failureMode === 'timeout' ||
    /no real progress|hard ceiling|maxDuration/i.test(t.outcome.reason ?? ''),
).length;
assert.deepEqual([stalled, spillFailures], [50, 78]);
const run = {
  ...priorRun,
  scope: 'suite',
  memoryCoverage: 'system-only',
  provenance: {
    ...priorRun.provenance,
    harnessCommit,
    catalogHash: inputs.gilde.tarballSha256,
    gildeVersion,
    judgeModelId: judgeId,
    engineBuilds: { 'llama-cpp': nativeLine },
  },
  note: `Fourteen small models on a 12 GB RTX 5070 Ti Laptop GPU, three trials of every scenario in core, productivity, developer and complex-work: ${n(counts.recorded)} attempts, ${n(counts.passes)} passes, ${n(counts.modelFailures)} model failures and ${n(counts.infrastructureExclusions)} infrastructure exclusions (four daemon crashes, two unavailable sandboxes). Run serially from a checkout at ${harnessCommit} whose daemon and packages were last built from ${builtFrom}, one commit earlier, with native 0.1.62 and task strategy auto, which is outcome without the recipe; books without a contract run stepwise. Every model ran entirely on the GPU except Granite 4.2 8B: at its catalog 64K context with f16 KV it needs about 15 GiB, so llama.cpp placed layers on the CPU in all 129 trials, it decoded ${spillDecode.min}–${spillDecode.max} tokens/s, and ${stalled} of its ${spillFailures} failures were attempts stopped for lack of progress or by the time limit, so its results are probably understated. Nanbeige 4.2 3B was left out for the same reason. GPU power changed during the run, so measurement periods are kept separate: the three Gemma models and the first 21 Qwen 3.5 9B core trials ran under a 45 W limit, the rest at about 77 W, and five Nemotron productivity trials overlapped 22 minutes on battery. Cells first measured during Windows Modern Standby, and one cell interrupted by a power loss, were discarded and rerun; no published trial overlaps standby. Claude Sonnet 5.5 reviewed the ${n(counts.judged)} judgeable trials that produced a deliverable afterward, through the Claude CLI; ${n(counts.noArtifact)} produced none. Reviews are advisory and kept separate by rubric. The download has every trial's review, speeds, memory, engine record and evidence hashes.`,
};
// The ingest's order (evals mergeScorecard): suite, then model. Matching it
// keeps a later `eval:scorecard` ingest from rewriting this hash-pinned shard.
results.sort((a, b) => a.suiteId.localeCompare(b.suiteId) || a.modelId.localeCompare(b.modelId));
const dataset = ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [run], results });

const details = {
  schemaVersion: 1,
  kind: 'scorecard-details',
  publicationId,
  complete: true,
  newInferenceCalls: 0,
  counts,
  window: { firstTrialStartedAt: firstStart, lastTrialFinishedAt: lastFinish },
  provenance: {
    ...run.provenance,
    builtFrom,
    buildEvidence:
      'packages/service/dist was last built at 2026-11-11T17:18Z, after 7e7fb07c was pulled and before 92437e37; preflight fingerprints (daemon entry size and mtime) are constant for each model across the run.',
    gilde: inputs.gilde,
    models: inputs.installs,
    host: {
      cpu: 'AMD Ryzen AI 9 HX 370 w/ Radeon 890M',
      gpu: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU, 12,227 MiB',
      systemMemoryMb: 31865,
      os: 'Windows 11 10.0.26300',
      nvidiaDriver: '610.88',
    },
  },
  power: {
    source: 'G-Helper log (local time UTC-8), Windows Kernel-Power events, nvidia-smi',
    turboFrom: TURBO_FROM,
    batteryWindows: BATTERY_WINDOWS,
    standbyWindows: STANDBY_WINDOWS,
    periods: Object.values(PERIODS).map((period) => ({
      ...period,
      trials: counts.periods[period.id],
    })),
    note: 'Each trial is assigned by its start time; a trial overlapping a battery window is assigned to the battery period. One Silent-period trial (qwen3.5-9b-q4 data-wrangle, started 14:02:26Z) finished after the switch to Turbo. Cells measured during Modern Standby before 2026-11-14 were moved aside and rerun with the host held awake; they are not part of this record.',
  },
  residency,
  byModel,
  judging: {
    provider: 'anthropic-cli',
    model: 'claude-sonnet-5-5',
    command:
      'GEZEL_JUDGE_MODEL=claude-sonnet-5-5 pnpm eval:judge-sweep --run-id 2026-11-11-windows-small-outcome-bare',
    when: 'After every trial finished, from the saved deliverables. Four calls failed without output in the first pass and were rerun the same night; the other 720 reviews were reused.',
    inputLimitBytes: 20480,
    blinding:
      'The judge saw the task prompt, scenario brief and the deliverable, not the pass/fail outcome or the model name.',
    aggregation:
      'Rubric means average each review’s unrounded axis mean; the judge rounded its own meanScore to one decimal.',
    rubrics: inputs.rubrics,
  },
  performance: {
    notes: [
      'Speeds are engine-log rates per trial (llama-server timings), excluding tool and scheduling time; wall time includes them.',
      'The four daemon-crash trials never started an engine and contribute no measurements. Two minicpm5-1b-q4 trials recorded no engine-log speeds.',
      'RSS is the daemon and engine process tree in system memory; GPU memory is the discrete card, measured separately. MB fields are MiB. Do not add them.',
      'Admission-probe speeds on the page are separate from these per-trial medians.',
    ],
  },
  trials,
  evidence: {
    availability:
      'Transcripts, workspaces and deliverables stay in the local evaluation archive; they are not in this download.',
    pathConvention:
      'Evidence paths are relative to the archived sweep folder. Workstation paths and the hostname are redacted.',
    sourceFiles,
  },
};

const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csvRows = [
  [
    'model',
    'suite',
    'scenario',
    'trial_id',
    'period',
    'started_at',
    'duration_min',
    'passed',
    'failure_class',
    'failure_rule',
    'decode_tok_s',
    'prefill_tok_s',
    'peak_rss_mib',
    'peak_gpu_mib',
    'review',
    'rubric',
    'review_mean',
  ],
  ...trials.map((t) => [
    t.modelId,
    t.suiteId,
    t.scenarioId,
    t.trialId,
    t.period,
    t.startedAt,
    round(t.durationMs / 60000, 2),
    t.outcome.success,
    t.outcome.failureClass,
    t.outcome.failureClassRule,
    t.performance.decodeTokensPerSec,
    t.performance.prefillTokensPerSec,
    t.performance.peakRssMb,
    t.performance.peakGpuMemMb,
    t.review.status,
    t.review.rubricId,
    t.review.axisMean,
  ]),
];
const csv = `${csvRows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;

const pct = (n, d) => `${Math.round((100 * n) / d)}%`;
const modelTable = models
  .map((modelId) => byModel[modelId])
  .toSorted((a, b) => b.passes - a.passes)
  .map(
    (m) =>
      `| ${m.label} | ${m.passes}/${m.trials} (${pct(m.passes, m.trials)}) | ${m.decodeTokensPerSec.median} | ${m.reviewMean ?? '—'} (${m.reviewed}) | ${m.residency === 'full-gpu' ? 'GPU' : 'GPU + CPU'} |`,
  );
const readme = `# November 2026 Windows small-model scorecard

Fourteen small models ran every scenario in core, productivity, developer and
complex-work three times on a Windows laptop with a 12 GB NVIDIA RTX 5070 Ti
Laptop GPU: ${n(counts.recorded)} attempts, ${n(counts.passes)} passes,
${n(counts.modelFailures)} model failures and ${n(counts.infrastructureExclusions)}
infrastructure exclusions. Trials ran one at a time from ${firstStart.slice(0, 10)}
to ${lastFinish.slice(0, 10)}, from a checkout at \`${harnessCommit}\` whose
daemon and packages were last built from \`${builtFrom}\`, one commit earlier
(the newer commit changed no evaluation code), with Gezel native 0.1.62
(llama.cpp build 12110, CUDA 12.8) and Gilde ${gildeVersion}.

- [scorecard.json](scorecard.json) is the page dataset, validated against
  ScorecardDatasetSchema v1: pass counts per scenario, per-trial speed and
  memory medians by power period, and review means by rubric.
- [scorecard-details.json](scorecard-details.json) keeps all ${n(counts.recorded)}
  trials: outcome and failure class, engine launch record, speeds, tokens,
  memory and GPU telemetry, the full Sonnet 5.5 review with its axes and
  rationale, and a hash of every evidence file read.
- [trials.csv](trials.csv) is the same trials as one spreadsheet row each.
- [verification.json](verification.json) records the coverage checks, and
  [manifest.json](manifest.json) the file hashes and the commands that
  regenerate or check this export from the local archive.

## Results

| Model | Passed | Median output (tok/s) | Review mean (reviews) | Ran on |
|---|---:|---:|---:|---|
${modelTable.join('\n')}

Passed counts every attempt, including the six infrastructure exclusions.
Output speeds pool each model's trials: the three Gemma models ran entirely,
and Qwen 3.5 9B partly, under the 45 W limit described below, so their speeds
are not comparable with the rest. The page splits them by period. Review
means are advisory, pooled here across rubrics for a quick read; the page
and the dataset keep each rubric separate, and a mean covers only trials
that produced a deliverable.

## What was run

Task strategy was \`auto\`, which for these models is outcome without the
recipe; craftbooks without a contract fall back to stepwise by design. Each
model used its catalog context with f16 KV cache and one slot. Every model
was fully resident on the GPU except Granite 4.2 8B, whose offload plan
needed about 15 GiB at a 65,536-token context. llama.cpp placed part of it on
the CPU in all 129 trials, it decoded ${spillDecode.min}–${spillDecode.max}
tokens/s (median ${spillDecode.median}), and ${stalled} of its ${spillFailures} failures
were attempts stopped for lack of progress or by the time limit rather than
wrong answers, so its results are probably understated.
Nanbeige 4.2 3B was not run for the same reason. Model weights match the
Gilde ${gildeVersion} catalog entries byte for byte (SHA-256 recorded per model).

## Power periods

GPU power changed during the sweep, so speeds are reported per period:

- **${PERIODS.silent.label}**: ${n(counts.periods['silent-45w'])} trials, all
  three Gemma models and the first 21 Qwen 3.5 9B core trials, until
  ${TURBO_FROM}.
- **${PERIODS.turbo.label}**: ${n(counts.periods['turbo-77w'])} trials, the rest.
- **${PERIODS.battery.label}**: ${n(counts.periods['battery-overlap'])} Nemotron
  productivity trials that overlapped 22 minutes without AC power on
  2026-11-24.

Windows Modern Standby throttled the GPU about tenfold early in the run.
Cells measured during standby, and the Qwen 3.5 9B complex-work cell a
power loss interrupted, were discarded and rerun with the host held awake.
No published trial overlaps a standby window from the Kernel-Power log. Speed
differences between periods are hardware, not model, effects.

## Reviews

Claude Sonnet 5.5 reviewed each deliverable after the sweep, through the
Claude CLI (\`anthropic-cli/claude-sonnet-5-5\`), with up to 20 KiB of the
artifact. ${n(counts.judgeable)} trials had a rubric: ${n(counts.judged)} were
reviewed and ${n(counts.noArtifact)} produced no deliverable. The other
${n(counts.notApplicable)} trials have no qualitative rubric and are marked not
applicable. Four reviews failed silently in the first pass and were rerun the
same night. The three game anchors share the generic HTML rubric; every
other reviewed scenario has its own axes. Reviews never change pass/fail.

## Measurements

Speeds come from llama-server's own timings in each trial's engine log and
exclude tool and scheduling time. Wall time includes them. The four
daemon-crash trials never started an engine, and two MiniCPM5 1B trials
logged no speeds, so their periods have fewer samples than trials. Memory
fields are MiB: system RSS covers the daemon and engine processes, GPU
memory is the card, and the two must not be added. The page's probe speeds
are separate admission probes, not task medians.

Regenerate or check this export with the commands in [manifest.json](manifest.json).
Nothing here required new inference.
`;

const verification = {
  counts,
  cells: 14 * 43,
  trialsPerCell: 3,
  checks: [
    'Every cell has exactly the three trials its summary lists, and no other directories.',
    'Recounted cells match the ingested shard exactly.',
    'Every engine launch was native 0.1.62, CUDA 12.8, llama.cpp cd959bae.',
    'Model weights match the Gilde 0.3.8 entry and were installed before the model’s first trial.',
    'Every review matches the judge report and its deliverable hash; every unreviewed judgeable trial has no deliverable.',
    'No trial overlaps a Modern Standby window or the gap between the power loss and the restart.',
    'Only Granite 4.2 8B has a CPU-spill offload plan, in every trial.',
  ],
  evidenceFilesVerified: Object.keys(sourceFiles).length,
  sourceEvidenceModified: false,
  newInferenceCalls: 0,
};

const files = new Map();
const addJson = (name, value) => files.set(name, `${JSON.stringify(sanitize(value), null, 2)}\n`);
addJson(shardPath, dataset);
addJson(`${destination}/scorecard.json`, dataset);
addJson(`${destination}/scorecard-details.json`, details);
files.set(`${destination}/trials.csv`, sanitize(csv));
files.set(`${destination}/README.md`, readme);
addJson(`${destination}/verification.json`, verification);
const command =
  'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-small-outcome-bare-scorecard.mjs';
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId,
  regenerate: command,
  check: `${command} --check`,
  prepare: `${command} --prepare --gilde-tarball=<bendyline-gilde-${gildeVersion}.tgz> --gilde-dir=<extracted package/>`,
  files: [...files].map(([name, value]) => ({
    path: name,
    bytes: Buffer.byteLength(value),
    sha256: sha(value),
  })),
});
for (const [name, value] of files) {
  // Serialized JSON doubles a path's backslashes; `Slide N:\"` is a quote, not a drive.
  const leak = /.{0,60}(?:\b[A-Za-z]:(?:\\\\|\/)\w|mikeam-gdev|\\Users\\|\/Users\/).{0,60}/.exec(
    value,
  );
  assert(!leak, `Workstation path in ${name}: ${leak?.[0]}`);
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
      files: [...files].map(([name, value]) => `${name} (${Buffer.byteLength(value)} bytes)`),
      evidenceFilesVerified: Object.keys(sourceFiles).length,
    },
    null,
    2,
  ),
);
