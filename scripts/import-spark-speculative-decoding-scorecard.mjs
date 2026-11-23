#!/usr/bin/env node
// Publish the 2026-11-13 DGX Spark speculative-decoding A/B from its evidence, without inference, judging or rescoring.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = '2026-11-13-spark-speculative-decoding';
const studyRoot = 'evals/runs/spec-ab-2026-11-13';
const ROUNDS = ['r1', 'r2', 'r3'];
const roundRoot = (round) => `evals/runs/scorecard-spec-ab-2026-11-13-${round}`;
const destination = `docs/handboek/assets/scorecards/${runId}`;
const check = process.argv.includes('--check');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const sourceHashes = {};
const bytes = (path, expected) => {
  const value = readFileSync(resolve(root, path));
  const hash = sha(value);
  if (expected) assert.equal(hash, expected, `Evidence changed: ${path}`);
  sourceHashes[path] = hash;
  return value;
};
const read = (path, expected) => JSON.parse(bytes(path, expected));
const dirs = (path) =>
  readdirSync(resolve(root, path))
    .filter((name) => statSync(resolve(root, path, name)).isDirectory())
    .sort();

// Pinned when the study closed on 2026-11-22: the three judge ledgers (round 2's
// is the re-run that replaced an empty in-driver pass) and the study's notes.
const judgeReports = Object.fromEntries(
  ROUNDS.map((round) => [round, read(`${roundRoot(round)}/judge-report.json`)]),
);
// Published under the names the readouts use for one another.
const studyFiles = {
  'report.md': 'FINAL.md',
  'PLAN.md': 'PLAN.md',
  'ROUND1.md': 'ROUND1.md',
  'ROUND2.md': 'ROUND2.md',
  'results.md': 'results.md',
};
const study = Object.fromEntries(
  Object.entries(studyFiles).map(([name, file]) => [
    name,
    bytes(`${studyRoot}/${file}`).toString(),
  ]),
);
const studyResults = read(`${studyRoot}/results.json`);
const driverLog = bytes(`${studyRoot}/driver-main.log`).toString();

const HARNESS_COMMIT = '9e5fd58f';
// The service package's exact pin at that commit; the catalog drafter entries
// (Qwen 1.0.7, Muse 1.0.4, Gemma 1.2.1) are the versions it resolved.
const GILDE_VERSION = '0.3.10';
const NATIVE_RELEASE = '0.1.62';
const CUDA_TOOLKIT = '13.0';
const SUITES = ['core', 'productivity', 'developer', 'complex-work'];
const MODELS = {
  'qwen3.8-27b-q4': { name: 'Qwen 3.8 (27B, Q4)', parameterSize: '27B', quantization: 'UD-Q4_K_M' },
  'gemma4-12b-q4': { name: 'Gemma 4 (12B, Q4)', parameterSize: '12B', quantization: 'UD-Q4_K_XL' },
  'muse-glimmer-30b-q4': {
    name: 'Muse Glimmer (30B, Q4)',
    parameterSize: '30B',
    quantization: 'Q4_K',
  },
};
const SPECULATION = {
  none: 'no speculation',
  mtp: 'MTP',
  dflash: 'DFlash2',
};
// The arm that matches the catalog's own CUDA setting carries the plain model
// id, so model pages and `gezel doctor` quote only what a person gets by
// default. The others carry the arm suffix and appear only in this round.
const ARMS = [
  {
    arm: 'qwen3.8-27b-q4.none',
    model: 'qwen3.8-27b-q4',
    speculation: 'none',
    setBy: 'GEZEL_EVAL_LLAMA_SPEC_TYPE=none',
  },
  {
    arm: 'qwen3.8-27b-q4.mtp',
    model: 'qwen3.8-27b-q4',
    speculation: 'mtp',
    setBy: 'GEZEL_EVAL_LLAMA_SPEC_TYPE=draft-mtp (the model’s built-in MTP head)',
  },
  {
    arm: 'qwen3.8-27b-q4.dflash',
    model: 'qwen3.8-27b-q4',
    speculation: 'dflash',
    catalogDefault: true,
    setBy: 'catalog default on CUDA',
    drafter: 'Qwen3.8-27B-DFlash2-Q4_K_M.gguf',
  },
  {
    arm: 'gemma4-12b-q4.none',
    model: 'gemma4-12b-q4',
    speculation: 'none',
    setBy: 'GEZEL_EVAL_LLAMA_SPEC_TYPE=none',
  },
  {
    arm: 'gemma4-12b-q4.mtp',
    model: 'gemma4-12b-q4',
    speculation: 'mtp',
    catalogDefault: true,
    setBy: 'catalog default (separate MTP assistant model)',
    drafter: 'mtp-gemma-4-12B-it-Q4_0.gguf',
  },
  {
    arm: 'muse-glimmer-30b-q4.none',
    model: 'muse-glimmer-30b-q4',
    speculation: 'none',
    setBy: 'GEZEL_EVAL_LLAMA_SPEC_TYPE=none',
  },
  {
    arm: 'muse-glimmer-30b-q4.dflash',
    model: 'muse-glimmer-30b-q4',
    speculation: 'dflash',
    catalogDefault: true,
    setBy: 'catalog default on CUDA',
    drafter: 'Muse-Glimmer-30B-DFlash2-Q4_K_M.gguf',
  },
].map((a) => ({
  ...a,
  catalogDefault: a.catalogDefault === true,
  modelId: a.catalogDefault ? a.model : a.arm,
  label: `${MODELS[a.model].name} · ${SPECULATION[a.speculation]}${a.catalogDefault ? ' (default)' : ''}`,
}));
const armByName = new Map(ARMS.map((a) => [a.arm, a]));
const COMPARISONS = [
  ['qwen3.8-27b-q4.mtp', 'qwen3.8-27b-q4.none'],
  ['qwen3.8-27b-q4.dflash', 'qwen3.8-27b-q4.none'],
  ['qwen3.8-27b-q4.dflash', 'qwen3.8-27b-q4.mtp'],
  ['gemma4-12b-q4.mtp', 'gemma4-12b-q4.none'],
  ['muse-glimmer-30b-q4.dflash', 'muse-glimmer-30b-q4.none'],
];
// Scenarios that declare a judge rubric (`scenario.judge`) at the run's commit.
// A trial of one of these with no review produced no deliverable; any other
// unreviewed trial had no rubric to apply.
const DECLARED_RUBRIC = new Set([
  'meeting-followup',
  'craftbook-spreadsheet-model',
  'docblocks-theme-roundtrip',
  'craftbook-powerpoint-deck',
  'wikipedia-research-brief',
  'craftbook-week-plan',
  'craftbook-ab-test-readout',
  'craftbook-annotated-bibliography',
  'craftbook-research-to-document',
  'craftbook-code-review',
  'craftbook-api-contract-review',
  'craftbook-deep-security-review',
  'craftbook-codemod-sweep',
  'craftbook-refactor-module',
  'craftbook-bug-fix-tdd',
  'craftbook-invoice-run',
]);
const GAME_SCENARIOS = new Set(['tictactoe', 'petshop', 'tankcombat']);
const NON_MODEL_CLASSES = new Set(['infra', 'operator', 'grader']);
// Diagnostic event lists, kept in the local archive; everything else in each
// trial's score-trial facts is published.
const FACT_KEYS_LEFT_OUT = ['miscEvents', 'continuity', 'retrieval'];

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const observation = (values) => {
  const present = values.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
  return present.length
    ? {
        samples: present.length,
        median: median(present),
        min: Math.min(...present),
        max: Math.max(...present),
      }
    : undefined;
};

/** What the engine actually ran, from llama-server's own lines in the trial's daemon log. */
function observedSpeculation(log, modelId) {
  const launches = [...log.matchAll(/\[llama-server\] launch (\{.*\})/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    })
    .filter((launch) => launch && launch.model === modelId);
  const kinds = [...log.matchAll(/common_speculative_init_result: ([^\n]*)/g)].map((m) => {
    if (/creating MTP draft context/i.test(m[1])) return 'mtp';
    if (/loading draft model .*dflash/i.test(m[1])) return 'dflash';
    if (/loading draft model .*mtp/i.test(m[1])) return 'mtp';
    return `other:${m[1].slice(0, 80)}`;
  });
  let accepted = 0;
  let generated = 0;
  let acceptanceLines = 0;
  for (const m of log.matchAll(
    /draft acceptance = [\d.]+ \(\s*(\d+) accepted \/\s*(\d+) generated\)/g,
  )) {
    accepted += Number(m[1]);
    generated += Number(m[2]);
    acceptanceLines += 1;
  }
  const distinct = [...new Set(kinds)];
  let mode;
  if (kinds.length === 0 && acceptanceLines === 0) mode = 'none';
  else if (distinct.length === 1 && kinds.length >= launches.length) mode = distinct[0];
  else mode = `mixed(${kinds.join(',') || 'accept-only'};launches=${launches.length})`;
  return { mode, launches, accepted, generated };
}

/**
 * A stop is speed-sensitive when it is the hard ceiling, or a stop triggered by
 * elapsed time (not by counted attempts) that cut off a model turn still
 * running. At a higher decode rate such a stop would have come later or not at
 * all. The harness logs the stop; the daemon logs each turn it abandoned.
 */
function interruptedTurnMs(harnessLog, daemonLog) {
  const terminal = harnessLog.match(/^\[(\S+)\] \[poll\] terminal/m);
  if (!terminal) return null;
  const stopMs = Date.parse(terminal[1]);
  let longest = null;
  for (const m of daemonLog.matchAll(
    /^(\S+) DEBUG \[chat\] runSend#\w+ EXIT throw afterMs=(\d+) This turn was stopped before the model finished/gm,
  )) {
    const at = Date.parse(m[1]);
    if (at >= stopMs - 2000 && at <= stopMs + 20000) longest = Math.max(longest ?? 0, Number(m[2]));
  }
  return longest;
}
const hardCeiling = (reason) => /maxDuration|hard ceiling/i.test(reason);
const TIME_TRIGGERED = /stale no-write repair loop|retry loop \((stall|long)-path\)/;

function tableReview(scenarioId, judge, ledgerRubric) {
  if (DECLARED_RUBRIC.has(scenarioId)) {
    if (!judge) return { status: 'noArtifact' };
    assert.equal(ledgerRubric, 'scenario', `Unexpected rubric for ${scenarioId}`);
    return { status: 'judged', rubricId: scenarioId };
  }
  if (!judge) return { status: 'notApplicable' };
  assert(GAME_SCENARIOS.has(scenarioId), `Unexpected review of ${scenarioId}`);
  assert.equal(ledgerRubric, 'default-html', `Unexpected rubric for ${scenarioId}`);
  return { status: 'judged', rubricId: 'default-html-v1' };
}

// Every cell of the sweep ran on one commit, with a clean tree and one build.
const cellStarts = [
  ...driverLog.matchAll(
    /^\[driver\] cell start spec-ab-2026-11-13-(r\d) (\S+) (\S+) spec=(\S+) attempt=(\d+) head=(\S+) dirty=(\d+) dist=(.*?), (\S+)$/gm,
  ),
].map((m) => ({
  round: m[1],
  arm: m[2],
  suite: m[3],
  spec: m[4],
  attempt: Number(m[5]),
  head: m[6],
  dirty: Number(m[7]),
  dist: m[8],
  at: m[9],
}));
const cellEnds = [
  ...driverLog.matchAll(/^\[driver\] cell end spec-ab-2026-11-13-(r\d) (\S+) (\S+) rc=(\d+) /gm),
].map((m) => ({ round: m[1], arm: m[2], suite: m[3], rc: Number(m[4]) }));
assert.equal(cellStarts.length, ROUNDS.length * ARMS.length * SUITES.length);
assert.equal(cellEnds.length, cellStarts.length);
assert(cellStarts.every((c) => c.head === HARNESS_COMMIT && c.dirty === 0 && c.attempt === 1));
assert.equal(new Set(cellStarts.map((c) => c.dist)).size, 1);
assert(
  cellEnds.every((c) => c.rc === 0 || c.rc === 1),
  'A cell ended on a setup failure',
);

const trials = [];
const scenariosBySuite = {};
const hostnames = new Set();
for (const [roundIndex, round] of ROUNDS.entries()) {
  const ledger = new Map(judgeReports[round].perTrial.map((entry) => [entry.trialId, entry]));
  assert.deepEqual(dirs(roundRoot(round)), ARMS.map((a) => a.arm).toSorted());
  for (const arm of ARMS) {
    assert.deepEqual(dirs(`${roundRoot(round)}/${arm.arm}`), SUITES.toSorted());
    for (const suiteId of SUITES) {
      const suiteDir = `${roundRoot(round)}/${arm.arm}/${suiteId}`;
      const summary = read(`${suiteDir}/summary.json`);
      assert.equal(summary.status, 'complete');
      assert.equal(summary.count, 1);
      assert(summary.requestedScenarios.every((s) => s.trials === 1));
      const scenarios = summary.requestedScenarios.map((s) => s.scenarioId);
      scenariosBySuite[suiteId] ??= scenarios;
      assert.deepEqual(scenarios, scenariosBySuite[suiteId], `Scenario set moved: ${suiteDir}`);
      assert.deepEqual(dirs(suiteDir), scenarios.toSorted());
      for (const scenarioId of scenarios) {
        const [trialId, ...extra] = dirs(`${suiteDir}/${scenarioId}`);
        assert(trialId && extra.length === 0, `Expected one trial: ${suiteDir}/${scenarioId}`);
        const trialDir = `${suiteDir}/${scenarioId}/${trialId}`;
        const result = read(`${trialDir}/result.json`);
        const facts = read(`${trialDir}/facts.json`);
        const metrics = read(`${trialDir}/metrics.json`);
        const judgePath = `${trialDir}/llm-judge.json`;
        const judge = existsSync(resolve(root, judgePath)) ? read(judgePath) : null;
        const daemonLog = bytes(`${trialDir}/daemon.log`).toString('latin1');
        const harnessLog = bytes(`${trialDir}/log.txt`).toString('latin1');
        assert.equal(result.trialId, trialId);
        assert.equal(facts.trialId, trialId);
        assert.equal(result.modelId, arm.model);
        assert.equal(result.scenarioId, scenarioId);
        assert.equal(facts.outcome.success, result.success);
        assert.deepEqual(facts.judge ?? null, judge);
        assert.equal(metrics.usage?.source, 'engine-log');
        if (facts.host?.hostname) hostnames.add(facts.host.hostname);
        const entry = ledger.get(trialId);
        assert.equal(Boolean(entry), Boolean(judge), `Judge ledger disagrees: ${trialId}`);
        if (entry) {
          assert.equal(entry.modelId, arm.arm);
          assert.equal(entry.meanScore, judge.meanScore);
          assert.equal(
            `${judge.judgeProvider}/${judge.judgeModel}`,
            'anthropic-cli/claude-sonnet-5-5',
          );
        }
        const speculation = observedSpeculation(daemonLog, arm.model);
        assert.equal(speculation.mode, arm.speculation, `Wrong speculation mode: ${trialDir}`);
        assert(speculation.launches.length > 0, `No engine launch recorded: ${trialDir}`);
        for (const launch of speculation.launches) {
          assert.equal(launch.nativeRelease, NATIVE_RELEASE);
          assert.equal(launch.cudaToolkit, CUDA_TOOLKIT);
          assert.equal(launch.backend, 'cuda');
          assert.equal(launch.specDraftModel, arm.drafter ?? 'none');
        }
        const reason = String(result.reason ?? '');
        const failed = !result.success;
        const ceiling = failed && hardCeiling(reason);
        const turnMs = failed ? interruptedTurnMs(harnessLog, daemonLog) : null;
        const speedSensitive =
          failed && (ceiling || (turnMs !== null && TIME_TRIGGERED.test(reason)));
        const trimmedFacts = Object.fromEntries(
          Object.entries(facts).filter(([key]) => !FACT_KEYS_LEFT_OUT.includes(key)),
        );
        trials.push({
          arm: arm.arm,
          modelId: arm.modelId,
          catalogModelId: arm.model,
          speculation: arm.speculation,
          suiteId,
          scenarioId,
          unit: `${suiteId}/${scenarioId}`,
          round,
          repetition: roundIndex + 1,
          trialId,
          success: result.success,
          nonModelFailure: failed && NON_MODEL_CLASSES.has(result.failureClass ?? ''),
          speedSensitive,
          ...(speedSensitive
            ? {
                speedSensitiveBecause: ceiling
                  ? 'hard ceiling'
                  : `turn ${Math.round(turnMs / 1000)} s old`,
              }
            : {}),
          engine: {
            observedSpeculation: speculation.mode,
            launches: speculation.launches.length,
            draftAccepted: speculation.accepted,
            draftGenerated: speculation.generated,
            contextTokens: result.engineContext?.grantedPerSlotTokens ?? null,
            kvCacheType: result.engineContext?.kvCacheType ?? null,
          },
          result,
          metrics,
          facts: trimmedFacts,
          judge,
          tableReview: tableReview(scenarioId, judge, entry?.rubric),
          evidence: Object.fromEntries(
            [
              'result.json',
              'facts.json',
              'metrics.json',
              'daemon.log',
              'log.txt',
              ...(judge ? ['llm-judge.json'] : []),
            ].map((name) => [
              name,
              { path: `${trialDir}/${name}`, sha256: sourceHashes[`${trialDir}/${name}`] },
            ]),
          ),
        });
      }
    }
  }
  assert.equal(judgeReports[round].perTrial.length, judgeReports[round].trials);
  assert.equal(
    judgeReports[round].trials + judgeReports[round].skipped,
    ARMS.length * 43,
    `Judge ledger does not cover round ${round}`,
  );
}
assert.deepEqual(Object.keys(scenariosBySuite), SUITES);
assert.equal(Object.values(scenariosBySuite).flat().length, 43);
assert.equal(trials.length, 903);
assert.equal(new Set(trials.map((t) => t.trialId)).size, 903);

const revisions = new Set(trials.map((t) => t.facts.host.frameworkBuild?.revision));
assert.equal(revisions.size, 1);
const revision = [...revisions][0];
assert(trials.every((t) => t.facts.host.frameworkVariant === 'cuda'));
assert(trials.every((t) => t.facts.host.gpuModel === 'NVIDIA GB10'));
const osReleases = new Set(trials.map((t) => t.facts.host.osRelease));
assert.equal(osReleases.size, 1);
const ramGb = new Set(trials.map((t) => t.facts.host.totalRamGb));
assert.equal(ramGb.size, 1);

const startedAt = trials
  .map((t) => t.result.startedAt)
  .sort()
  .at(0);
const finishedAt = trials
  .map((t) => t.result.finishedAt)
  .sort()
  .at(-1);

// ── The paired analysis the study fixed in advance ──────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bootstrapCi(diffs, iters = 10000) {
  const r = rng(20261113);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(r() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * iters)], means[Math.floor(0.975 * iters)]];
}
/** Exact two-sided sign-flip test over the scenarios whose arms differ. */
function signFlip(diffs) {
  const nonzero = diffs.filter((d) => Math.abs(d) > 1e-12);
  const observed = Math.abs(nonzero.reduce((a, b) => a + b, 0));
  let extreme = 0;
  const total = 2 ** nonzero.length;
  for (let mask = 0; mask < total; mask++) {
    let sum = 0;
    for (let i = 0; i < nonzero.length; i++) sum += (mask >> i) & 1 ? -nonzero[i] : nonzero[i];
    if (Math.abs(sum) >= observed - 1e-9) extreme++;
  }
  return { differingScenarios: nonzero.length, p: extreme / total };
}
function unitMeans(arm, pick) {
  const byUnit = new Map();
  for (const t of trials.filter((x) => x.arm === arm)) {
    const value = pick(t);
    if (value === null || value === undefined) continue;
    if (!byUnit.has(t.unit)) byUnit.set(t.unit, []);
    byUnit.get(t.unit).push(value);
  }
  return new Map(
    [...byUnit].map(([unit, values]) => [
      unit,
      { mean: mean(values), n: values.length, sum: values.reduce((a, b) => a + b, 0) },
    ]),
  );
}
function paired(armA, armB, pick) {
  const a = unitMeans(armA, pick);
  const b = unitMeans(armB, pick);
  const units = [...a.keys()].filter((unit) => b.has(unit)).sort();
  const diffs = units.map((unit) => a.get(unit).mean - b.get(unit).mean);
  return {
    units: units.length,
    diff: mean(diffs),
    ci: bootstrapCi(diffs),
    exact: signFlip(diffs),
    perUnit: units.map((unit, i) => ({ unit, a: a.get(unit), b: b.get(unit), diff: diffs[i] })),
  };
}
const passValue = (t) => (t.success ? 1 : 0);
const comparisons = COMPARISONS.map(([a, b]) => ({
  a,
  b,
  pass: paired(a, b, passValue),
  passExSpeed: paired(a, b, (t) => (t.speedSensitive ? null : passValue(t))),
  judge: paired(a, b, (t) => t.judge?.meanScore ?? null),
}));
// The importer must reach the study's own numbers from the raw evidence.
for (const comparison of comparisons) {
  const theirs = studyResults.comparisons.find((c) => c.a === comparison.a && c.b === comparison.b);
  for (const key of ['pass', 'passExSpeed', 'judge']) {
    assert.equal(comparison[key].units, theirs[key].units);
    assert(Math.abs(comparison[key].diff - theirs[key].diff) < 1e-12, `${key} drift`);
    assert.deepEqual(comparison[key].ci, theirs[key].ci, `${key} interval drift`);
  }
}
const pValues = comparisons.flatMap((c) => [c.pass.exact.p, c.judge.exact.p]);
assert.equal(
  pValues.filter((p) => p < 0.005).length,
  0,
  'A test survives Holm correction; the published text says none does',
);

const armSummaries = ARMS.map((arm) => {
  const selected = trials.filter((t) => t.arm === arm.arm);
  const judged = selected.filter((t) => t.judge);
  const accepted = selected.reduce((n, t) => n + t.engine.draftAccepted, 0);
  const generated = selected.reduce((n, t) => n + t.engine.draftGenerated, 0);
  return {
    arm: arm.arm,
    modelId: arm.modelId,
    label: arm.label,
    trials: selected.length,
    passes: selected.filter((t) => t.success).length,
    speedSensitiveFailures: selected.filter((t) => t.speedSensitive).length,
    judged: judged.length,
    judgeMean: round2(mean(judged.map((t) => t.judge.meanScore))),
    medianOutputTokensPerSec: median(
      selected.map((t) => t.metrics.derived?.genTokensPerSec).filter((n) => n > 0),
    ),
    draftAcceptance: generated ? round2(accepted / generated) : null,
    medianTrialMinutes: round1(median(selected.map((t) => t.result.durationMs)) / 60000),
    totalHours: round1(selected.reduce((n, t) => n + t.result.durationMs, 0) / 3600000),
  };
});
assert.deepEqual(
  Object.fromEntries(armSummaries.map((s) => [s.arm, [s.passes, s.speedSensitiveFailures]])),
  {
    'qwen3.8-27b-q4.none': [120, 4],
    'qwen3.8-27b-q4.mtp': [123, 0],
    'qwen3.8-27b-q4.dflash': [123, 0],
    'gemma4-12b-q4.none': [103, 0],
    'gemma4-12b-q4.mtp': [106, 0],
    'muse-glimmer-30b-q4.none': [113, 3],
    'muse-glimmer-30b-q4.dflash': [121, 1],
  },
);

// ── The scorecard round ────────────────────────────────────────────────────
const judgeModel = 'anthropic-cli/claude-sonnet-5-5';
const note =
  'A speculative-decoding A/B on a DGX Spark (NVIDIA GB10, Linux) with native 0.1.62: llama.cpp v0.9.0 on CUDA. Qwen 3.8 27B Q4 ran with no speculation, MTP and DFlash2; Gemma 4 12B Q4 with none and MTP; Muse Glimmer 30B Q4 with none and DFlash2. Rows marked default use the catalog’s own setting and carry the plain model id. 903 trials, three per arm and scenario, ran November 13–22, 2026, in three rounds with the arm order rotated. Every trial’s engine log confirmed its speculation mode, and none was repeated, replaced or set aside. Speculation changed no measured quality: artifact review means match within 0.1, and no pass-rate difference is significant (Muse with DFlash2 +6.2 points, exact p = 0.055, one of ten tests). Eight failures came from time-based stops that faster decoding might have avoided: 4 for Qwen and 3 for Muse without speculation, 1 for Muse with DFlash2. They count as failures here. Task speeds are engine-log medians over every attempt; speculation decoded 2.7–2.9 times faster. Memory is not shown: the GB10 shares its memory with the GPU in a way the measurement cannot see. Artifact reviews are by Claude Sonnet 5.5, one column per rubric.';
const run = {
  id: runId,
  provenance: {
    startedAt,
    device: {
      label: 'DGX Spark Class',
      platform: 'linux',
      arch: 'arm64',
      memoryGb: [...ramGb][0],
      osRelease: `linux ${[...osReleases][0]}`,
      cpuModel: 'Arm Cortex-X925 + Cortex-A725 (20 cores)',
      gpuModel: 'NVIDIA GB10',
    },
    harnessCommit: HARNESS_COMMIT,
    gildeVersion: GILDE_VERSION,
    count: 3,
    judgeModelId: judgeModel,
    engineBuilds: {
      'llama-cpp': `Gezel native ${NATIVE_RELEASE} · CUDA ${CUDA_TOOLKIT} · ${revision}`,
    },
  },
  scope: 'suite',
  memoryCoverage: 'incomplete',
  suites: SUITES,
  scenariosBySuite,
  note,
};

const mode = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
};
const results = ARMS.flatMap((arm) =>
  SUITES.map((suiteId) => {
    const selected = trials.filter((t) => t.arm === arm.arm && t.suiteId === suiteId);
    const cells = scenariosBySuite[suiteId].map((scenarioId) => {
      const observed = selected
        .filter((t) => t.scenarioId === scenarioId)
        .toSorted((a, b) => a.repetition - b.repetition);
      assert.deepEqual(
        observed.map((t) => t.repetition),
        [1, 2, 3],
      );
      return {
        scenarioId,
        trials: observed.length,
        successes: observed.filter((t) => t.success).length,
        nonModelFailures: observed.filter((t) => t.nonModelFailure).length,
        medianDurationMs: Math.round(median(observed.map((t) => t.result.durationMs))),
      };
    });
    const reviewed = selected.filter((t) => t.tableReview.status === 'judged');
    const rubricIds = [...new Set(reviewed.map((t) => t.tableReview.rubricId))].sort();
    const kvTypes = new Set(selected.map((t) => t.engine.kvCacheType));
    assert.equal(kvTypes.size, 1);
    return {
      modelId: arm.modelId,
      label: arm.label,
      engine: 'llama-cpp',
      tier: 'medium',
      parameterSize: MODELS[arm.model].parameterSize,
      quantization: MODELS[arm.model].quantization,
      runId,
      suiteId,
      runtime: {
        contextTokens: mode(selected.map((t) => t.engine.contextTokens)),
        peakMemoryMb: Math.round(median(selected.map((t) => t.metrics.process.peakRssMb))),
        kvCacheType: [...kvTypes][0],
      },
      taskMeasurements: [
        {
          id: 'all-attempts',
          label: `Native ${NATIVE_RELEASE} · CUDA · ${SPECULATION[arm.speculation]} · all attempts`,
          trials: selected.length,
          source: 'engine-log',
          outputTokensPerSec: observation(selected.map((t) => t.metrics.derived?.genTokensPerSec)),
          prefillTokensPerSec: observation(
            selected.map((t) => t.metrics.derived?.promptTokensPerSec),
          ),
          durationMs: observation(selected.map((t) => t.result.durationMs)),
          judgments: rubricIds.map((rubricId) => {
            const reports = reviewed
              .filter((t) => t.tableReview.rubricId === rubricId)
              .map((t) => t.judge);
            return {
              rubricId,
              meanScore: mean(reports.map((j) => j.meanScore)),
              artifacts: reports.length,
              judgeModel,
            };
          }),
          noArtifact: selected.filter((t) => t.tableReview.status === 'noArtifact').length,
          excludedReviews: 0,
          notApplicableReviews: selected.filter((t) => t.tableReview.status === 'notApplicable')
            .length,
        },
      ],
      cells,
    };
  }),
);
const dataset = ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [run], results });

const counts = {
  trials: trials.length,
  passes: trials.filter((t) => t.success).length,
  taskFailures: trials.filter((t) => !t.success && !t.nonModelFailure).length,
  rawNonModelFailures: trials.filter((t) => t.nonModelFailure).length,
  speedSensitiveFailures: trials.filter((t) => t.speedSensitive).length,
  judged: trials.filter((t) => t.judge).length,
  tableJudged: trials.filter((t) => t.tableReview.status === 'judged').length,
  tableNoArtifact: trials.filter((t) => t.tableReview.status === 'noArtifact').length,
  tableExcludedReviews: 0,
  tableNotApplicable: trials.filter((t) => t.tableReview.status === 'notApplicable').length,
  wrongSpeculationMode: 0,
};
assert.deepEqual(counts, {
  trials: 903,
  passes: 809,
  taskFailures: 94,
  rawNonModelFailures: 0,
  speedSensitiveFailures: 8,
  judged: 397,
  tableJudged: 397,
  tableNoArtifact: 2,
  tableExcludedReviews: 0,
  tableNotApplicable: 504,
  wrongSpeculationMode: 0,
});

// Public data uses repository-relative references, never personal machine paths.
const home = homedir();
const sanitize = (value) => {
  if (typeof value === 'string') {
    let out = value
      .replaceAll(`${root}/`, '')
      .replaceAll(home, '<home>')
      .replace(/\/home\/[^/\s"'<>]+/g, '<home>');
    for (const name of hostnames) out = out.replaceAll(name, '<host>');
    return out;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitize(k), sanitize(v)]));
  return value;
};

const analysis = {
  method:
    'Paired by scenario: each arm’s mean over its three trials of a scenario, the difference averaged over scenarios, with a 95% bootstrap interval over scenarios (10,000 resamples, seed 20261113) and an exact two-sided sign-flip test over the scenarios whose arms differ. Pass rate covers all 43 scenarios; the review mean covers the 19 scenarios with a rubric. passExSpeed leaves speed-sensitive failures out, which favors the arm that had them, so it bounds rather than estimates.',
  practicalMargin: { reviewMean: 0.5 },
  multipleTests:
    'Ten tests (five comparisons, two endpoints). With Holm’s correction the smallest p-value would need to be below 0.005.',
  speedSensitiveRule:
    'A failure is speed-sensitive when it hit the hard ceiling, or when a stop triggered by elapsed time (the craftbook stale no-write repair loop, or the retry loop’s stall or long path) cut off a model turn that was still running: the daemon logged that turn as stopped within 20 seconds of the harness’s stop. Attempt-counted stops never count, whatever was running.',
  arms: armSummaries,
  comparisons,
  speedSensitive: trials
    .filter((t) => t.speedSensitive)
    .map((t) => ({
      arm: t.arm,
      round: t.round,
      unit: t.unit,
      trialId: t.trialId,
      because: t.speedSensitiveBecause,
      reason: String(t.result.reason ?? ''),
    })),
};

const details = {
  schemaVersion: 1,
  kind: 'scorecard-details',
  publicationId: runId,
  scorecardFile: 'scorecard.json',
  complete: true,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  counts,
  models: MODELS,
  arms: ARMS.map(({ arm, modelId, model, speculation, catalogDefault, setBy, drafter, label }) => ({
    arm,
    modelId,
    catalogModelId: model,
    label,
    speculation,
    catalogDefault,
    setBy,
    drafter: drafter ?? null,
  })),
  condition: {
    runId,
    scope: 'suite',
    note,
    startedAt,
    finishedAt,
    provenance: run.provenance,
    scenariosBySuite,
    design:
      'Three rounds, each running every suite once per arm (count 1), with the arm order rotated per suite and round, so an interrupted sweep still leaves balanced arms. A repetition is a round. Muse Glimmer was added during round 1’s first cell, before any result was read (plan amendment 1).',
    cells: cellStarts.map(({ round, arm, suite, spec, head, dirty, dist, at }) => ({
      round,
      arm,
      suite,
      spec,
      head,
      dirty,
      dist,
      startedAt: at,
      rc: cellEnds.find((e) => e.round === round && e.arm === arm && e.suite === suite).rc,
    })),
    judging:
      'Each round was judged after it finished. Round 2’s in-driver judge pass exited 0 having judged none of its 301 trials; it was re-run by hand on 2026-11-20 and judged the expected 133. That ledger is the one published.',
    excludedAttempts:
      'Five verification trials (one tictactoe per original arm, 2026-11-13 07:34–08:07) ran before the sweep to confirm each speculation mode and are not part of this publication.',
  },
  analysis,
  trials,
  judging: { judgeReports },
  reports: study,
  evidence: {
    availability:
      'Structured outcomes, score-trial facts (without the miscEvents, continuity and retrieval event lists), metrics, judge reports, the study plan, its interim and final readouts, and the driver log’s per-cell provenance are included. Generated artifacts, session transcripts and process logs remain in the local archive; their hashes are listed here.',
    pathConvention:
      'Repository-relative archive references, not download URLs. Home paths and the hostname are redacted; hashes identify the original files.',
    sourceFiles: sourceHashes,
  },
};

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csvColumns = [
  ['arm', (t) => t.arm],
  ['model', (t) => t.modelId],
  ['catalogModel', (t) => t.catalogModelId],
  ['speculation', (t) => t.speculation],
  ['suite', (t) => t.suiteId],
  ['scenario', (t) => t.scenarioId],
  ['round', (t) => t.repetition],
  ['trialId', (t) => t.trialId],
  ['success', (t) => t.success],
  ['failureClass', (t) => (t.success ? '' : t.result.failureClass)],
  ['failureMode', (t) => (t.success ? '' : (t.facts.outcome?.failureMode ?? ''))],
  ['speedSensitive', (t) => t.speedSensitive],
  ['durationMin', (t) => round1(t.result.durationMs / 60000)],
  ['toolCalls', (t) => t.facts.toolUse?.totalToolCalls ?? ''],
  ['outputTokens', (t) => t.metrics.derived?.genTokens ?? ''],
  ['outputTokensPerSec', (t) => t.metrics.derived?.genTokensPerSec ?? ''],
  ['prefillTokensPerSec', (t) => t.metrics.derived?.promptTokensPerSec ?? ''],
  ['draftAccepted', (t) => (t.speculation === 'none' ? '' : t.engine.draftAccepted)],
  ['draftGenerated', (t) => (t.speculation === 'none' ? '' : t.engine.draftGenerated)],
  ['tableReview', (t) => t.tableReview.status],
  ['rubricId', (t) => t.tableReview.rubricId ?? ''],
  ['judgeMean', (t) => t.judge?.meanScore ?? ''],
  ['reason', (t) => (t.success ? '' : String(t.result.reason ?? '').slice(0, 240))],
];
const csv = [
  csvColumns.map(([name]) => name).join(','),
  ...trials.map((t) => csvColumns.map(([, get]) => csvCell(get(t))).join(',')),
].join('\n');

const files = new Map();
const addJson = (path, value) => files.set(path, `${JSON.stringify(sanitize(value), null, 2)}\n`);
addJson(`packages/core/src/scorecard/data/runs/${runId}.json`, dataset);
addJson(`${destination}/runs/${runId}.json`, dataset);
addJson(`${destination}/scorecard.json`, dataset);
addJson(`${destination}/scorecard-details.json`, details);
addJson(`${destination}/paired-analysis.json`, analysis);
for (const round of ROUNDS)
  addJson(`${destination}/judging/judge-report-${round}.json`, judgeReports[round]);
files.set(`${destination}/trials.csv`, `${sanitize(csv)}\n`);
for (const [name, text] of Object.entries(study))
  files.set(`${destination}/${name}`, sanitize(text));
addJson(`${destination}/verification.json`, {
  counts,
  arms: ARMS.length,
  armScenarioCells: ARMS.length * 43,
  repetitions: 3,
  exactRepetitions: true,
  everyTrialRanItsArmsSpeculation: true,
  everyCellOnOneCommitAndBuild: true,
  pairedAnalysisMatchesStudy: true,
  originalEvidenceModified: false,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  rawClassificationCorrections: 0,
  judgeLedgerMatchesTrialReports: true,
  evidenceFilesVerified: Object.keys(sourceHashes).length,
  schemas: ['ScorecardDatasetSchema v1'],
});
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId: runId,
  regenerate:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-spark-speculative-decoding-scorecard.mjs',
  check:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-spark-speculative-decoding-scorecard.mjs --check',
  files: [...files].map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: sha(value),
  })),
});
for (const [path, value] of files) {
  assert(!value.includes('/home/') && !value.includes(home), `Personal path in ${path}`);
  for (const name of hostnames) assert(!value.includes(name), `Hostname in ${path}`);
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
  `${check ? 'Verified' : 'Wrote'} ${files.size} publication files: ${trials.length} trials; ${Object.keys(sourceHashes).length} evidence hashes.`,
);
