/**
 * `pnpm --filter @bendyline/gezel-evals run ab-retrieval [...flags]`
 *
 * Annotated-work A/B: does knowledge/index-annotated work produce better
 * deliverables? Runs the annotated-work scenarios under paired retrieval
 * arms, proves each trial ran under its arm (`facts.retrieval`), grades every
 * deliverable against the scenario's fact oracle, and reports paired effects.
 *
 * Pre-registered hypotheses (the summary tests these and nothing else):
 *   H1  annotated raises the fact score over control (annotated-deck-knowledge,
 *       annotated-chat-policy).
 *   H2  annotated does not raise decoy leakage (annotated-deck-absent).
 *   H3  (once the relevance model is calibrated) annotated-relevance is non-inferior to
 *       annotated on fact score (margin −0.10) and lowers injected tokens.
 *
 * Design: per scenario, replicates alternate ABBA (r1: A B, r2: B A, …) so
 * throughput drift on this machine spreads across both arms; `--aba` adds a
 * trailing control replicate to measure the drift. A trial whose arm proof
 * fails is re-run once and never scored. Infra / grader / operator failures
 * drop out of the paired analysis together with their partner.
 *
 * Flags:
 *   --model <id>                 chat model under test (required)
 *   --provider <p>               engine (default: platform default)
 *   --scenarios <id,…>           default: all annotated-work scenarios
 *   --arms <a,b>                 default: control,annotated (see ARMS)
 *   --replicates <N>             pairs per scenario (default 3)
 *   --aba                        trailing control replicate per scenario
 *   --resume <dir>               continue a run directory
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { pairedEffect, pairsNeeded } from '../ab-stats.ts';
import { deliverableTextFromRunDir, gradeText } from '../annotated/oracle.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { repoRoot } from '../native-bin.ts';
import { type ChatProvider, defaultModelFor, defaultProvider } from '../providers.ts';
import { retrievalArmProof, summarizeRetrievalForRunDir } from '../retrieval-facts.ts';
import { runTrial } from '../runner.ts';
import { ANNOTATED_ORACLES } from '../scenarios/annotated-work.ts';
import { getScenario } from '../scenarios/index.ts';
import type { TrialRetrievalArm } from '../types.ts';
import { parseArgs, resolveProviderFlag } from './args.ts';

export const ARMS: Record<string, TrialRetrievalArm> = {
  control: { mode: 'off', references: false, embeddings: true },
  annotated: { mode: 'balanced', references: true, embeddings: true },
  'references-only': { mode: 'off', references: true, embeddings: true },
  'turn-only': { mode: 'balanced', references: false, embeddings: true },
  // Thresholds come from the registry: until the bench calibrates the model,
  // this arm reorders and never drops.
  'annotated-relevance': {
    mode: 'balanced',
    references: true,
    embeddings: true,
    relevanceModel: { modelId: 'ms-marco-minilm-l6@1' },
  },
};

const EXCLUDED_FAILURE_CLASSES = new Set(['infra', 'grader', 'operator']);

export interface TrialRecord {
  scenarioId: string;
  arm: string;
  replicate: number;
  runDir: string;
  success: boolean;
  failureClass: string | null;
  durationMs: number;
  proofOk: boolean;
  proofProblems: string[];
  /** Intention-to-treat: a missing deliverable scores 0. */
  factScore: number;
  deliverableFound: boolean;
  forbiddenHits: string[];
  injectedTokens: number;
  referenceItems: number;
}

interface AbState {
  model: string;
  provider: string;
  arms: string[];
  records: Record<string, TrialRecord>;
}

const recordKey = (scenarioId: string, arm: string, replicate: number) =>
  `${scenarioId}\0${arm}\0${replicate}`;

async function runOne(opts: {
  scenarioId: string;
  arm: string;
  replicate: number;
  provider: ChatProvider;
  model: string;
  outRoot: string;
}): Promise<TrialRecord> {
  const scenario = getScenario(opts.scenarioId);
  const oracle = ANNOTATED_ORACLES[opts.scenarioId];
  if (!oracle) throw new Error(`no annotated oracle for ${opts.scenarioId}`);
  const armSpec = ARMS[opts.arm];
  if (!armSpec) throw new Error(`unknown arm ${opts.arm}`);
  let last: TrialRecord | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await runTrial(scenario, {
      engine: opts.provider,
      modelId: opts.model,
      retrieval: armSpec,
      disableBackgroundEnrich: true,
      generalistMode: 'off',
      repairPolicy: 'runtime',
      runsDir: join(opts.outRoot, opts.scenarioId, opts.arm, `r${opts.replicate}-a${attempt}`),
    });
    const resultJson = JSON.parse(
      await readFile(join(result.runDir, 'result.json'), 'utf8').catch(() => '{}'),
    ) as { failureClass?: string };
    const facts = summarizeRetrievalForRunDir(
      result.runDir,
      { retrievalArm: armSpec },
      oracle.retrieval,
    );
    const proof = facts ? retrievalArmProof(facts) : { ok: false, problems: ['no facts'] };
    const grade = gradeText(deliverableTextFromRunDir(result.runDir, oracle), oracle);
    last = {
      scenarioId: opts.scenarioId,
      arm: opts.arm,
      replicate: opts.replicate,
      runDir: result.runDir,
      success: result.success,
      failureClass: resultJson.failureClass ?? null,
      durationMs: result.durationMs,
      proofOk: proof.ok,
      proofProblems: proof.problems,
      factScore: grade.factScore ?? 0,
      deliverableFound: grade.deliverableFound,
      forbiddenHits: grade.forbiddenHits,
      injectedTokens: facts?.turn.injectedTokens ?? 0,
      referenceItems: facts?.references.items ?? 0,
    };
    console.log(
      `[ab-retrieval] ${opts.scenarioId} ${opts.arm} r${opts.replicate} attempt ${attempt}: ${result.success ? 'pass' : 'fail'} facts=${last.factScore.toFixed(2)} decoys=${last.forbiddenHits.length} proof=${proof.ok ? 'ok' : proof.problems.join('; ')}`,
    );
    if (proof.ok) break;
  }
  return last!;
}

export function summarizeAb(state: AbState) {
  const records = Object.values(state.records);
  const [armA, armB] = state.arms as [string, string];
  const scored = records.filter(
    (r) => r.proofOk && !EXCLUDED_FAILURE_CLASSES.has(r.failureClass ?? ''),
  );
  const scenarios = [...new Set(records.map((r) => r.scenarioId))];
  const cells = scenarios.flatMap((scenarioId) =>
    state.arms.map((arm) => {
      const rows = scored.filter((r) => r.scenarioId === scenarioId && r.arm === arm);
      const mean = (pick: (r: TrialRecord) => number) =>
        rows.length === 0 ? null : rows.reduce((sum, r) => sum + pick(r), 0) / rows.length;
      return {
        scenarioId,
        arm,
        n: rows.length,
        passRate: mean((r) => (r.success ? 1 : 0)),
        factScore: mean((r) => r.factScore),
        decoyHits: mean((r) => r.forbiddenHits.length),
        durationMin: mean((r) => r.durationMs / 60_000),
        injectedTokens: mean((r) => r.injectedTokens),
        referenceItems: mean((r) => r.referenceItems),
      };
    }),
  );
  const pairs: Array<{ scenarioId: string; a: TrialRecord; b: TrialRecord }> = [];
  for (const b of scored.filter((r) => r.arm === armB)) {
    const a = scored.find(
      (r) => r.arm === armA && r.scenarioId === b.scenarioId && r.replicate === b.replicate,
    );
    if (a) pairs.push({ scenarioId: b.scenarioId, a, b });
  }
  const factPairs = pairs.filter((p) => ANNOTATED_ORACLES[p.scenarioId]!.facts.length > 0);
  const factDeltas = factPairs.map((p) => p.b.factScore - p.a.factScore);
  const decoyPairs = pairs;
  const decoyDeltas = decoyPairs.map((p) => p.b.forbiddenHits.length - p.a.forbiddenHits.length);
  const mean = factDeltas.reduce((s, d) => s + d, 0) / (factDeltas.length || 1);
  const sd =
    factDeltas.length > 1
      ? Math.sqrt(factDeltas.reduce((s, d) => s + (d - mean) ** 2, 0) / (factDeltas.length - 1))
      : null;
  return {
    model: state.model,
    provider: state.provider,
    arms: state.arms,
    trials: records.length,
    scored: scored.length,
    proofFailures: records.filter((r) => !r.proofOk).length,
    cells,
    h1FactScore: pairedEffect(factDeltas, { strata: factPairs.map((p) => p.scenarioId) }),
    h2DecoyHits: pairedEffect(decoyDeltas, { strata: decoyPairs.map((p) => p.scenarioId) }),
    passFlips: {
      aOnly: pairs.filter((p) => p.a.success && !p.b.success).length,
      bOnly: pairs.filter((p) => !p.a.success && p.b.success).length,
    },
    futility:
      sd === null
        ? null
        : { deltaSd: sd, pairsFor015: pairsNeeded(sd, 0.15), pairsFor020: pairsNeeded(sd, 0.2) },
  };
}

function renderSummary(summary: ReturnType<typeof summarizeAb>): string {
  const n = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));
  const effect = (e: ReturnType<typeof pairedEffect>) =>
    `mean ${n(e.meanDelta)} · 95% CI ${e.bootstrap ? `[${n(e.bootstrap.low)}, ${n(e.bootstrap.high)}]` : '—'} · wins/ties/losses ${e.wins}/${e.ties}/${e.losses} · sign test p=${n(e.signTestP, 3)} · n=${e.n}`;
  const [a, b] = summary.arms;
  return [
    `# Annotated-work A/B — ${summary.model} (${summary.provider})`,
    '',
    `Arms: **${a}** vs **${b}**. ${summary.scored}/${summary.trials} trials scored; ${summary.proofFailures} failed arm proof.`,
    '',
    '| scenario | arm | n | pass | fact score | decoy hits | injected tokens | reference items | minutes |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...summary.cells.map(
      (c) =>
        `| ${c.scenarioId} | ${c.arm} | ${c.n} | ${n(c.passRate)} | ${n(c.factScore)} | ${n(c.decoyHits)} | ${n(c.injectedTokens, 0)} | ${n(c.referenceItems, 1)} | ${n(c.durationMin, 1)} |`,
    ),
    '',
    `**H1 — fact score (${b} − ${a}):** ${effect(summary.h1FactScore)}`,
    '',
    `**H2 — decoy hits (${b} − ${a}):** ${effect(summary.h2DecoyHits)}`,
    '',
    `Pass flips: ${a} only ${summary.passFlips.aOnly}, ${b} only ${summary.passFlips.bOnly}.`,
    '',
    summary.futility
      ? `Futility: paired-delta sd ${n(summary.futility.deltaSd)} → ${summary.futility.pairsFor015} pairs to detect 0.15, ${summary.futility.pairsFor020} for 0.20.`
      : 'Futility: not enough pairs to estimate the spread.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = resolveProviderFlag(args.flags) ?? defaultProvider();
  const model = String(args.flags.model ?? defaultModelFor(provider));
  const scenarios = String(args.flags.scenarios ?? Object.keys(ANNOTATED_ORACLES).join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const arms = String(args.flags.arms ?? 'control,annotated')
    .split(',')
    .map((s) => s.trim());
  if (arms.length !== 2 || arms.some((arm) => !ARMS[arm])) {
    console.error(`--arms needs two of: ${Object.keys(ARMS).join(', ')}`);
    process.exit(2);
  }
  const replicates = Number(args.flags.replicates ?? 3) || 3;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outRoot = args.flags.resume
    ? String(args.flags.resume)
    : join(repoRoot(), 'evals', 'runs', `ab-retrieval-${ts}`);
  await mkdir(outRoot, { recursive: true });
  const statePath = join(outRoot, 'state.json');
  const state: AbState = existsSync(statePath)
    ? (JSON.parse(await readFile(statePath, 'utf8')) as AbState)
    : { model, provider, arms, records: {} };

  const deviceLock = acquireEvalDeviceLockIfNeeded({
    provider,
    scenarios: scenarios.map((id) => getScenario(id)),
  });

  const plan: Array<{ scenarioId: string; arm: string; replicate: number }> = [];
  for (const scenarioId of scenarios) {
    for (let r = 1; r <= replicates; r++) {
      const order = r % 2 === 1 ? arms : [...arms].reverse();
      for (const arm of order) plan.push({ scenarioId, arm, replicate: r });
    }
    if (args.flags.aba) plan.push({ scenarioId, arm: arms[0]!, replicate: replicates + 1 });
  }
  try {
    for (const item of plan) {
      const key = recordKey(item.scenarioId, item.arm, item.replicate);
      if (state.records[key]) continue;
      state.records[key] = await runOne({ ...item, provider, model, outRoot });
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    }
  } finally {
    deviceLock?.release();
  }
  const summary = summarizeAb(state);
  await writeFile(join(outRoot, 'ab-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const markdown = renderSummary(summary);
  await writeFile(join(outRoot, 'ab-summary.md'), markdown);
  console.log(markdown);
  console.log(`[ab-retrieval] wrote ${outRoot}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error('[ab-retrieval] fatal:', error);
    process.exitCode = 2;
  });
}
