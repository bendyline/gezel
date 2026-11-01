#!/usr/bin/env node
// Publish the 2026-10-28 DGX Spark sweep from its evidence, without inference, judging or rescoring.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = '2026-10-28-dgx-spark-class';
const sourceRoot = `evals/runs/scorecard-${runId}`;
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

// The shard exactly as `eval:scorecard` and `eval:judge-sweep --ingest-only`
// wrote it, archived before this script replaced the published copy.
const ingested = read(
  `${sourceRoot}/ingested-shard.json`,
  '63688a3e2686a18529e87761d7e288bcde34dbf0137a804d5fcd749fc17fa2ac',
);
const judgeReport = read(
  `${sourceRoot}/judge-report.json`,
  '30f280cd5b087fc00799bd37e0fe9226ae9af44e98d0be78c0c54b1fc3ff9662',
);
const report = bytes(`${sourceRoot}/report.md`).toString();

const modelMetadata = {
  'qwen3.8-27b-q4': {
    label: 'Qwen 3.8 (27B, Q4)',
    parameterSize: '27B',
    quantization: 'UD-Q4_K_M',
  },
  'gemma4-12b-q4': { label: 'Gemma 4 (12B, Q4)', parameterSize: '12B', quantization: 'UD-Q4_K_XL' },
};
// Not in the trial evidence: the installed native release and its build manifest.
const NATIVE_RELEASE = '0.1.54';
const CUDA_TOOLKIT = '13.0';
const NON_MODEL_CLASSES = new Set(['infra', 'operator', 'grader']);
// Scenarios in these suites that declare a judge rubric (`scenario.judge`) at
// the run's commit. A trial of one of these with no review is a missing
// deliverable; any other unreviewed trial had no rubric to apply.
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
// Steps whose gate needs a `commandEvidence` receipt in the pinned gilde 0.3.1 books.
const COMMAND_EVIDENCE_STEPS = new Set([
  'craftbook-codemod-sweep:verify',
  'craftbook-codemod-sweep:repair',
  'craftbook-refactor-module:baseline',
  'craftbook-refactor-module:verify',
  'craftbook-refactor-module:repair',
  'craftbook-bug-fix-tdd:reproduce',
  'craftbook-bug-fix-tdd:validate',
  'craftbook-bug-fix-tdd:repair',
]);

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const round1 = (n) => Math.round(n * 10) / 10;
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

// The eval-run skill's fixed 0-10 rubric, applied to score-trial facts.
// Interpolations between the rubric's anchor points are marked.
function completion(f) {
  const o = f.outcome;
  if (o.success) return [10, 'outcome.success'];
  const reason = String(o.reason ?? '');
  if (/^repair-(exhausted|aborted)/.test(reason))
    return [6, `failureMode=${o.failureMode}; ${reason.slice(0, 40)}`];
  const s = f.sniff?.latest;
  const half = s?.scoreMax
    ? s.score / s.scoreMax >= 0.5
    : (f.artifacts?.htmlFiles?.length ?? 0) + (f.artifacts?.otherFileCount ?? 0) > 0;
  return [
    half ? 3 : 0,
    `failureMode=${o.failureMode}; ${half ? 'artifact/sniff >= half' : 'little output'}`,
  ];
}
function quality(f) {
  const s = f.sniff?.latest;
  const images = f.artifacts?.imageFiles ?? [];
  if (images.some((i) => i.real === true) && f.outcome.success) return [10, 'imageFiles real'];
  if (f.outcome.success) {
    if (s?.scoreMax)
      return [
        Math.max(5, Math.round((10 * s.score) / s.scoreMax)),
        `sniff ${s.score}/${s.scoreMax} (floor 5)`,
      ];
    if (s?.failReason) return [5, 'success floor; failReason present'];
    return [
      10,
      s
        ? 'all signals, no failReason'
        : `success floor via gate: ${String(f.outcome.reason).slice(0, 30)}`,
    ];
  }
  if (s && /no inline `<script>`|does not parse/.test(s.failReason ?? ''))
    return [0, 'failReason parse/no-script'];
  if (s?.scoreMax)
    return [Math.min(9, Math.round((10 * s.score) / s.scoreMax)), `sniff ${s.score}/${s.scoreMax}`];
  const any =
    (f.artifacts?.htmlFiles?.length ?? 0) + (f.artifacts?.otherFileCount ?? 0) + images.length;
  return any ? [5, 'artifact exists, no graded max'] : [0, 'no artifact'];
}
function efficiency(f) {
  const b = f.outcome.budgetUsedFraction ?? 1;
  const c = f.toolUse?.totalToolCalls ?? 0;
  const why = `budget=${b.toFixed(2)} calls=${c}`;
  if (b >= 1 && c >= 30) return [0, why];
  if (b <= 0.5 && c <= 10) return [10, why];
  if (b <= 0.5 && c < 20) return [8, `${why} (interpolated)`];
  if ((b > 0.5 && b <= 0.9) || (c >= 20 && c <= 30)) return [5, why];
  if (b <= 0.9 && c > 30) return [3, `${why} (interpolated)`];
  return [2, `${why} (interpolated)`];
}
function behavior(f, ignore = new Set()) {
  const flags = (f.toolUse?.redFlags ?? []).filter((x) => !ignore.has(x.pattern));
  const missing = f.team?.missingExpectedRoles ?? [];
  const answers = f.autoAnswer?.total ?? 0;
  if (flags.length || missing.length)
    return [
      0,
      `redFlags=${flags.map((x) => x.pattern).join(',') || 0} missing=${missing.join(',') || 0}`,
    ];
  if (answers >= 3) return [5, `autoAnswer=${answers}`];
  if (answers <= 1) return [10, `autoAnswer=${answers}`];
  return [8, `autoAnswer=${answers} (interpolated)`];
}
const composite = (c, q, e, b) => round1(0.4 * c + 0.25 * q + 0.2 * e + 0.15 * b);
const band = (n) => (n >= 8 ? 'ship-ready' : n >= 5 ? 'needs-tuning' : 'framework-gap');
function fixedScore(facts) {
  const [c, cw] = completion(facts);
  const [q, qw] = quality(facts);
  const [e, ew] = efficiency(facts);
  const [b, bw] = behavior(facts);
  const [bAdjusted] = behavior(facts, new Set(['prose-as-deliverable']));
  const score = composite(c, q, e, b);
  return {
    composite: score,
    // score-trial reads a closing status summary after `craftbook_write` or a
    // task launch as prose-as-deliverable; see the report's defect 8.
    compositeIgnoringProseFlag: composite(c, q, e, bAdjusted),
    band: band(score),
    axes: {
      completion: { score: c, why: cw },
      quality: { score: q, why: qw },
      efficiency: { score: e, why: ew },
      behavior: { score: b, why: bw },
    },
  };
}

function lastStep(trialDir) {
  const lines = bytes(`${trialDir}/log.txt`)
    .toString('latin1')
    .split('\n')
    .filter((line) => line.includes('step milestones'));
  const match = lines.at(-1)?.match(/\([^|]*\|[^|]*\|([^|]*)\|/);
  return match?.[1] ?? null;
}
function packageScriptSurfaces(trialDir) {
  return bytes(`${trialDir}/daemon.log`)
    .toString('latin1')
    .split('\n')
    .filter((line) => line.includes('tool surface has') && line.includes('run_package_script'))
    .length;
}

function tableReview(scenarioId, judge) {
  if (DECLARED_RUBRIC.has(scenarioId)) {
    if (!judge) return { status: 'noArtifact' };
    if (scenarioId === 'craftbook-ab-test-readout')
      return {
        status: 'excluded',
        reason:
          'The declared rubric (safety, mapping, signals, containment) was written for a runbook, not an A/B analysis.',
      };
    return { status: 'judged', rubricId: scenarioId };
  }
  if (!judge) return { status: 'notApplicable' };
  if (GAME_SCENARIOS.has(scenarioId)) return { status: 'judged', rubricId: 'default-html-v1' };
  return {
    status: 'excluded',
    reason:
      scenarioId === 'craftbook-find-vs-create'
        ? "The default HTML rubric graded the seeded shop page, not the model's work."
        : 'The default HTML rubric graded an incidental page; the task asked for an authored recipe.',
  };
}

const trials = [];
for (const modelId of dirs(sourceRoot).filter((name) => !name.startsWith('_'))) {
  for (const suiteId of dirs(`${sourceRoot}/${modelId}`)) {
    for (const scenarioId of dirs(`${sourceRoot}/${modelId}/${suiteId}`)) {
      const cellDir = `${sourceRoot}/${modelId}/${suiteId}/${scenarioId}`;
      const cell = dirs(cellDir).map((trialId) => {
        const trialDir = `${cellDir}/${trialId}`;
        const result = read(`${trialDir}/result.json`);
        const facts = read(`${trialDir}/facts.json`);
        const metrics = read(`${trialDir}/metrics.json`);
        const judgePath = `${trialDir}/llm-judge.json`;
        const judge = existsSync(resolve(root, judgePath)) ? read(judgePath) : null;
        assert.equal(result.trialId, trialId);
        assert.equal(facts.trialId, trialId);
        assert.equal(result.modelId, modelId);
        assert.equal(result.scenarioId, scenarioId);
        assert.equal(facts.outcome.success, result.success);
        assert.deepEqual(facts.judge ?? null, judge);
        const failed = !result.success;
        const nonModel = failed && NON_MODEL_CLASSES.has(result.failureClass ?? '');
        let developerToolPhase;
        if (suiteId === 'developer' && failed) {
          const step = lastStep(trialDir);
          const surfaces = packageScriptSurfaces(trialDir);
          developerToolPhase = {
            lastStep: step,
            packageScriptSurfaces: surfaces,
            toolPhase: surfaces === 0 && COMMAND_EVIDENCE_STEPS.has(`${scenarioId}:${step}`),
          };
        }
        return {
          modelId,
          suiteId,
          scenarioId,
          trialId,
          success: result.success,
          nonModelFailure: nonModel,
          result,
          metrics,
          facts,
          judge,
          tableReview: tableReview(scenarioId, judge),
          fixedScore: fixedScore(facts),
          ...(developerToolPhase ? { developerToolPhase } : {}),
          evidence: Object.fromEntries(
            ['result.json', 'facts.json', 'metrics.json', ...(judge ? ['llm-judge.json'] : [])].map(
              (name) => [
                name,
                { path: `${trialDir}/${name}`, sha256: sourceHashes[`${trialDir}/${name}`] },
              ],
            ),
          ),
        };
      });
      cell.sort((a, b) => a.result.startedAt.localeCompare(b.result.startedAt));
      cell.forEach((trial, index) => trials.push({ repetition: index + 1, ...trial }));
    }
  }
}
assert.equal(trials.length, 258);
assert.equal(new Set(trials.map((t) => t.trialId)).size, 258);

// The judge ledger and each trial's own report must agree.
assert.equal(judgeReport.runId, runId);
assert.equal(judgeReport.perTrial.length, judgeReport.trials);
assert.equal(judgeReport.trials + judgeReport.skipped, 258);
const ledger = new Map(judgeReport.perTrial.map((entry) => [entry.trialId, entry]));
for (const trial of trials) {
  const entry = ledger.get(trial.trialId);
  assert.equal(Boolean(entry), Boolean(trial.judge), `Judge ledger disagrees: ${trial.trialId}`);
  if (!entry) continue;
  assert.equal(entry.meanScore, trial.judge.meanScore);
  assert.equal(entry.rubric, DECLARED_RUBRIC.has(trial.scenarioId) ? 'scenario' : 'default-html');
}
const judges = new Set(
  trials.filter((t) => t.judge).map((t) => `${t.judge.judgeProvider}/${t.judge.judgeModel}`),
);
assert.equal(judges.size, 1);
const judgeModel = [...judges][0];

const runtime = {
  revisions: new Set(trials.map((t) => t.facts.host.frameworkBuild?.revision)),
  backends: new Set(trials.map((t) => t.facts.host.frameworkVariant)),
};
assert.equal(runtime.revisions.size, 1);
assert.deepEqual([...runtime.backends], ['cuda']);
const revision = [...runtime.revisions][0];
assert(trials.every((t) => t.metrics.usage?.source === 'engine-log'));

const run = structuredClone(ingested.runs[0]);
assert.equal(ingested.runs.length, 1);
assert.equal(run.id, runId);
assert.equal(run.provenance.count, 3);
const finishedAt = trials
  .map((t) => t.result.finishedAt)
  .sort()
  .at(-1);
const note =
  'Qwen 3.8 27B Q4 and Gemma 4 12B Q4 on a DGX Spark (NVIDIA GB10, Linux) with native 0.1.54: llama.cpp on CUDA, with MTP speculative decoding on by default for both models. 258 trials, three per model and scenario, ran October 28–30, 2026; none was repeated or replaced, and every raw verdict is kept. Three failures are set aside as infrastructure: one Linux script-sandbox failure and two gates the model wrote itself, which the harness classed as setup failures. Evaluation homes had package scripts switched off, so bug-fix-tdd, codemod-sweep and refactor-module could not pass for either model; without those 18 trials the developer failure rate is 0/21 for Qwen and 7/21 for Gemma. docblocks-theme-roundtrip lacked its DocBlocks tools in all six trials, and the harness stopped two Qwen route-multi trials and one Qwen author-fanout trial while they were still progressing. Task speeds are engine-log medians over every attempt. Memory is not shown: the GB10 shares its memory with the GPU in a way the measurement cannot see. Artifact reviews are by Claude Sonnet 4.6, one column per rubric. The six A/B readout reviews used a mismatched rubric and seven reviews graded a starting or incidental page instead of the work, so those 13 are excluded.';
Object.assign(run, { scope: 'suite', memoryCoverage: 'incomplete', note });
Object.assign(run.provenance, {
  gildeVersion: '0.3.1',
  judgeModelId: judgeModel,
  engineBuilds: {
    'llama-cpp': `Gezel native ${NATIVE_RELEASE} · CUDA ${CUDA_TOOLKIT} · ${revision}`,
  },
});
run.provenance.device.cpuModel = 'Arm Cortex-X925 + Cortex-A725 (20 cores)';

const results = ingested.results.map((source) => {
  const selected = trials.filter(
    (t) => t.modelId === source.modelId && t.suiteId === source.suiteId,
  );
  for (const cell of source.cells) {
    const observed = selected.filter((t) => t.scenarioId === cell.scenarioId);
    assert.deepEqual(
      {
        scenarioId: cell.scenarioId,
        trials: observed.length,
        successes: observed.filter((t) => t.success).length,
        nonModelFailures: observed.filter((t) => t.nonModelFailure).length,
        medianDurationMs: median(observed.map((t) => t.result.durationMs)),
      },
      cell,
      `Ingested cell disagrees with evidence: ${source.modelId}/${source.suiteId}/${cell.scenarioId}`,
    );
    assert.deepEqual(
      observed.map((t) => t.repetition),
      [1, 2, 3],
    );
  }
  assert.equal(
    selected.length,
    source.cells.reduce((n, cell) => n + cell.trials, 0),
  );
  const reviewed = selected.filter((t) => t.tableReview.status === 'judged');
  const rubricIds = [...new Set(reviewed.map((t) => t.tableReview.rubricId))].sort();
  // The pooled judge mean mixes rubrics and the probe is one admission sample;
  // both stay in the download's ingested shard, not in the table.
  const { judge: _pooled, performance: _probe, ...kept } = source;
  return {
    ...kept,
    ...modelMetadata[source.modelId],
    taskMeasurements: [
      {
        id: 'all-attempts',
        label: `Native ${NATIVE_RELEASE} · CUDA · all attempts`,
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
        excludedReviews: selected.filter((t) => t.tableReview.status === 'excluded').length,
        notApplicableReviews: selected.filter((t) => t.tableReview.status === 'notApplicable')
          .length,
      },
    ],
  };
});
const dataset = ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [run], results });

const byModel = (modelId) => trials.filter((t) => t.modelId === modelId);
const developer = Object.fromEntries(
  Object.keys(modelMetadata).map((modelId) => {
    const selected = byModel(modelId).filter((t) => t.suiteId === 'developer');
    const failed = selected.filter((t) => !t.success);
    const toolPhase = failed.filter((t) => t.developerToolPhase.toolPhase);
    return [
      modelId,
      {
        trials: selected.length,
        failed: failed.length,
        toolPhase: toolPhase.length,
        failureRate: `${failed.length}/${selected.length}`,
        failureRateExcludingToolPhase: `${failed.length - toolPhase.length}/${selected.length - toolPhase.length}`,
        toolPhaseTrials: toolPhase.map((t) => ({
          scenarioId: t.scenarioId,
          trialId: t.trialId,
          lastStep: t.developerToolPhase.lastStep,
        })),
      },
    ];
  }),
);
assert.deepEqual(
  Object.fromEntries(Object.entries(developer).map(([id, d]) => [id, [d.failed, d.toolPhase]])),
  { 'qwen3.8-27b-q4': [9, 9], 'gemma4-12b-q4': [16, 9] },
);

const counts = {
  trials: 258,
  passes: trials.filter((t) => t.success).length,
  taskFailures: trials.filter((t) => !t.success && !t.nonModelFailure).length,
  rawNonModelFailures: trials.filter((t) => t.nonModelFailure).length,
  developerToolPhaseFailures: Object.values(developer).reduce((n, d) => n + d.toolPhase, 0),
  judged: trials.filter((t) => t.judge).length,
  notJudged: trials.filter((t) => !t.judge).length,
  tableJudged: trials.filter((t) => t.tableReview.status === 'judged').length,
  tableNoArtifact: trials.filter((t) => t.tableReview.status === 'noArtifact').length,
  tableExcludedReviews: trials.filter((t) => t.tableReview.status === 'excluded').length,
  tableNotApplicable: trials.filter((t) => t.tableReview.status === 'notApplicable').length,
};
assert.deepEqual(counts, {
  trials: 258,
  passes: 196,
  taskFailures: 59,
  rawNonModelFailures: 3,
  developerToolPhaseFailures: 18,
  judged: 121,
  notJudged: 137,
  tableJudged: 108,
  tableNoArtifact: 0,
  tableExcludedReviews: 13,
  tableNotApplicable: 137,
});

// The reviewed report quotes these means; a rubric change must not drift past it.
const rubricMeans = {};
for (const modelId of Object.keys(modelMetadata))
  for (const suiteId of run.suites) {
    const selected = byModel(modelId).filter((t) => t.suiteId === suiteId);
    rubricMeans[`${modelId}/${suiteId}`] = [
      round1(mean(selected.map((t) => t.fixedScore.composite))),
      round1(mean(selected.map((t) => t.fixedScore.compositeIgnoringProseFlag))),
    ];
  }
assert.deepEqual(rubricMeans, {
  'qwen3.8-27b-q4/core': [9.7, 9.7],
  'qwen3.8-27b-q4/productivity': [9, 9],
  'qwen3.8-27b-q4/developer': [8, 8.1],
  'qwen3.8-27b-q4/complex-work': [7.2, 7.8],
  'gemma4-12b-q4/core': [9.6, 9.6],
  'gemma4-12b-q4/productivity': [8.9, 8.9],
  'gemma4-12b-q4/developer': [7.4, 7.4],
  'gemma4-12b-q4/complex-work': [7, 7],
});

// Public data uses repository-relative references, never personal machine paths.
const hostnames = new Set(trials.map((t) => t.facts.host.hostname).filter(Boolean));
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

const details = {
  schemaVersion: 1,
  kind: 'scorecard-details',
  publicationId: runId,
  scorecardFile: 'scorecard.json',
  complete: true,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  counts,
  modelMetadata,
  condition: {
    runId,
    scope: 'suite',
    note,
    startedAt: run.provenance.startedAt,
    finishedAt,
    judgedAt: judgeReport.judgedAt,
    provenance: run.provenance,
    scenariosBySuite: run.scenariosBySuite,
    harnessNote:
      'Service built from 22fec991 plus an uncommitted fix to constrained-turn.ts (conditional clauses in step procedures); gilde 0.3.1 from the registry pin.',
    excludedAttempts:
      'Two earlier Qwen tictactoe attempts started before Chromium was installed (one interrupted, one passed without its runtime check). They were set aside before the sweep began and are not part of this publication.',
  },
  ingestedShard: ingested,
  developerSuite: {
    rule: 'A failed developer trial is a tool-phase failure when its task ended on a step whose gate needs a commandEvidence receipt (a test run) and no model-facing tool surface in the trial listed run_package_script. Evaluation homes run at the lockdown security level, which has switched package scripts off since 2026-10-26.',
    commandEvidenceSteps: [...COMMAND_EVIDENCE_STEPS],
    byModel: developer,
  },
  fixedRubric: {
    weights: { completion: 0.4, quality: 0.25, efficiency: 0.2, behavior: 0.15 },
    bands: { 'ship-ready': '>= 8', 'needs-tuning': '5 to 7.9', 'framework-gap': '< 5' },
    interpolations:
      'Efficiency: 11-19 calls within half the budget scores 8, over 30 calls within the budget 3, over 0.9 of the budget 2. Behavior: exactly two auto-answers scores 8. compositeIgnoringProseFlag recomputes behavior without the prose-as-deliverable red flag, which fires on closing status summaries after craftbook authoring (report defect 8).',
  },
  judgingInterpretation: {
    judge: judgeModel,
    scale:
      'Integer axes from 0 to 10 per rubric; meanScore is their mean. The judge saw the original prompt and one artifact per trial.',
    artifactSelection:
      'A scenario that declares a rubric is judged on its declared artifact and axes. Any other scenario is judged on the first HTML file under the default HTML rubric (visual quality, functional completeness, code quality, polish), or not at all when it produced none.',
    primaryTableSelection:
      'Declared rubrics, one column each, plus the default HTML rubric for the three game scenarios. Docblocks-theme-roundtrip is kept under its own rubric although its tools were missing: the judge graded a real report.',
    exclusions:
      "Six A/B readout reviews used the runbook rubric (safety, mapping, signals, containment). Six find-vs-create reviews graded the seeded shop page and one author-gate-script review graded an incidental page; neither is the model's work. All 13 stay in this file.",
    notApplicable:
      '137 trials had no declared rubric and produced no HTML page; they are not missing deliverables.',
  },
  performanceInterpretation: {
    source: 'engine-log',
    population: 'All 258 attempted trials, including failures and set-aside trials.',
    speculativeDecoding:
      'MTP speculative decoding was on by default for both models (Gemma through its separate MTP head, Qwen through its built-in one), so output speeds include accepted draft tokens.',
    memory:
      'Process RSS and system memory samples are in each trial’s metrics. Neither is the model’s footprint: the GB10 serves GPU allocations from shared memory the RSS probe cannot see, and system memory includes everything else running. The GPU reports no memory figure on this chip. The table therefore shows no memory column.',
    units: { durations: 'ms', throughput: 'tokens/second', memoryMb: 'MiB' },
  },
  trials,
  judging: { judgeReport },
  reports: { 'report.md': report },
  evidence: {
    availability:
      'Structured outcomes, score-trial facts, metrics, judge reports and the reviewed report are included. Generated artifacts, session transcripts and process logs remain in the local archive.',
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
  ['model', (t) => t.modelId],
  ['suite', (t) => t.suiteId],
  ['scenario', (t) => t.scenarioId],
  ['repetition', (t) => t.repetition],
  ['trialId', (t) => t.trialId],
  ['success', (t) => t.success],
  ['failureClass', (t) => (t.success ? '' : t.result.failureClass)],
  ['failureClassRule', (t) => (t.success ? '' : t.result.failureClassRule)],
  ['developerToolPhase', (t) => t.developerToolPhase?.toolPhase ?? ''],
  ['composite', (t) => t.fixedScore.composite],
  ['compositeIgnoringProseFlag', (t) => t.fixedScore.compositeIgnoringProseFlag],
  ['band', (t) => t.fixedScore.band],
  ['completion', (t) => t.fixedScore.axes.completion.score],
  ['quality', (t) => t.fixedScore.axes.quality.score],
  ['efficiency', (t) => t.fixedScore.axes.efficiency.score],
  ['behavior', (t) => t.fixedScore.axes.behavior.score],
  ['durationMin', (t) => round1(t.result.durationMs / 60000)],
  ['toolCalls', (t) => t.facts.toolUse?.totalToolCalls ?? ''],
  ['autoAnswers', (t) => t.facts.autoAnswer?.total ?? ''],
  ['redFlags', (t) => (t.facts.toolUse?.redFlags ?? []).map((f) => f.pattern).join(' ')],
  ['outputTokensPerSec', (t) => t.metrics.derived?.genTokensPerSec ?? ''],
  ['prefillTokensPerSec', (t) => t.metrics.derived?.promptTokensPerSec ?? ''],
  ['peakRssMb', (t) => t.metrics.process?.peakRssMb ?? ''],
  ['peakSystemMemoryMb', (t) => t.metrics.systemMemory?.peakUsedMb ?? ''],
  ['tableReview', (t) => t.tableReview.status],
  ['rubricId', (t) => t.tableReview.rubricId ?? ''],
  ['judgeMean', (t) => t.judge?.meanScore ?? ''],
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
addJson(`${destination}/judging/judge-report.json`, judgeReport);
files.set(`${destination}/trials.csv`, `${sanitize(csv)}\n`);
files.set(`${destination}/report.md`, sanitize(report));
addJson(`${destination}/verification.json`, {
  counts,
  developerSuite: Object.fromEntries(
    Object.entries(developer).map(([id, d]) => [
      id,
      {
        failureRate: d.failureRate,
        failureRateExcludingToolPhase: d.failureRateExcludingToolPhase,
      },
    ]),
  ),
  modelScenarioCells: 86,
  repetitions: 3,
  exactRepetitions: true,
  originalEvidenceModified: false,
  newInferenceCalls: 0,
  newJudgeCalls: 0,
  rawClassificationCorrections: 0,
  ingestedCellsMatchEvidence: true,
  judgeLedgerMatchesTrialReports: true,
  evidenceFilesVerified: Object.keys(sourceHashes).length,
  schemas: ['ScorecardDatasetSchema v1'],
});
addJson(`${destination}/manifest.json`, {
  schemaVersion: 1,
  publicationId: runId,
  regenerate:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-dgx-spark-class-scorecard.mjs',
  check:
    'node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-dgx-spark-class-scorecard.mjs --check',
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
  `${check ? 'Verified' : 'Wrote'} ${files.size} publication files: 258 trials; ${Object.keys(sourceHashes).length} evidence hashes.`,
);
