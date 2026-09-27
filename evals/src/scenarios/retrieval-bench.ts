import type { RelevanceModelOverride, RelevanceThresholds, RetrievalMode } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { buildBenchCorpus } from '../retrieval-bench/corpus/build.ts';
import { buildBenchQueries } from '../retrieval-bench/corpus/queries.ts';
import { type DriveResult, driveRetrievalBench } from '../retrieval-bench/drive.ts';
import {
  type BenchReport,
  buildBenchReport,
  renderArmComparison,
  renderBenchMarkdown,
} from '../retrieval-bench/report.ts';
import {
  type SurfaceSweep,
  recommendThresholds,
  renderSweepMarkdown,
  sweepSurface,
} from '../retrieval-bench/sweep.ts';
import { seedRetrievalCorpus } from '../retrieval-corpora/seed.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Retrieval-quality bench — NO agent involved. Setup seeds a labeled corpus
 * (a knowledge catalog, shared-library documents, project files; fictional
 * entity families with graded labels and deliberate decoys), then runs every
 * query through the retrieval preview route, which executes the real
 * decision code of each surface: the per-turn injection, the launch
 * reference list, and the model's search. It measures ranking AND filtering:
 * nDCG / MRR / recall, plus false-injection and distractor rates on queries
 * that should get nothing. See evals/src/retrieval-bench/LABELS.md.
 *
 * Levers (env, read by the bin): GEZEL_RETRIEVAL_BENCH_MODE (turn policy
 * mode, default balanced), GEZEL_RETRIEVAL_BENCH_ROUNDS (default 3),
 * GEZEL_RETRIEVAL_BENCH_ARM (label for the report), and
 * GEZEL_RETRIEVAL_BENCH_RELEVANCE — `{"modelId": "...", "thresholds": [...]}`
 * — which turns one seeded trial into several arms: the model off, the
 * model uncalibrated (scores everything, drops nothing — the sweep's raw
 * material), and one arm per candidate threshold triple.
 */

export const REPORT_ARTIFACT = 'retrieval-bench/report.json';
export const REPORT_MARKDOWN = 'retrieval-bench/report.md';
export const TRACES_ARTIFACT = 'retrieval-bench/traces.json';
export const ARMS_ARTIFACT = 'retrieval-bench/arms.json';
export const COMPARISON_MARKDOWN = 'retrieval-bench/comparison.md';
export const SWEEP_ARTIFACT = 'retrieval-bench/sweep.json';
export const SWEEP_MARKDOWN = 'retrieval-bench/sweep.md';

interface BenchArm {
  label: string;
  relevanceModel?: RelevanceModelOverride;
}

interface RelevanceArmsSpec {
  modelId: string;
  thresholds?: RelevanceThresholds[];
}

function benchArms(defaultLabel: string): {
  arms: BenchArm[];
  relevance: RelevanceArmsSpec | null;
} {
  const raw = process.env.GEZEL_RETRIEVAL_BENCH_RELEVANCE;
  if (!raw) return { arms: [{ label: defaultLabel }], relevance: null };
  const relevance = JSON.parse(raw) as RelevanceArmsSpec;
  return {
    relevance,
    arms: [
      { label: 'off', relevanceModel: { enabled: false } },
      {
        label: 'raw',
        relevanceModel: { enabled: true, modelId: relevance.modelId, thresholds: null },
      },
      ...(relevance.thresholds ?? []).map((t) => ({
        label: `t=${t.drop}/${t.keep}/${t.strong}`,
        relevanceModel: { enabled: true, modelId: relevance.modelId, thresholds: t },
      })),
    ],
  };
}

/** Install the relevance model into the trial daemon (a shared cache makes it a no-op). */
async function ensureRelevanceModel(
  client: GezelClient,
  modelId: string,
  log: (line: string) => void,
): Promise<void> {
  const started = await client.retrieval.installRelevanceModel(modelId);
  if (!started.installed && !started.started) {
    throw new Error(`relevance model ${modelId} did not start installing: ${started.reason ?? ''}`);
  }
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const status = await client.retrieval.relevanceModelStatus();
    if (status.models.find((model) => model.id === modelId)?.installed) return;
    if (status.error) throw new Error(`relevance model ${modelId} install failed: ${status.error}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  log(`[retrieval-bench] relevance model ${modelId} still installing after 15 min`);
  throw new Error(`relevance model ${modelId} install timed out`);
}

let lastReport: BenchReport | null = null;

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  lastReport = null;
  const mode = (process.env.GEZEL_RETRIEVAL_BENCH_MODE ?? 'balanced') as RetrievalMode;
  const rounds = Number(process.env.GEZEL_RETRIEVAL_BENCH_ROUNDS ?? 3) || 3;
  const { arms, relevance } = benchArms(process.env.GEZEL_RETRIEVAL_BENCH_ARM ?? 'baseline');

  // Reactive engagement: the index drains its embed-only tier (vectors, no
  // summaries), so no chat model takes part in seeding.
  await client.updateConfig({ aiEngagementMode: 'reactive' });
  const project = await client.createProject({ name: 'Retrieval bench' });
  const corpus = buildBenchCorpus(project.id);
  const queries = buildBenchQueries(corpus);
  const seed = await seedRetrievalCorpus(client, project.id, corpus, log);
  log(
    `[retrieval-bench] seeded in ${Math.round(seed.seedMs / 1000)}s; unembedded project=${seed.embedPending.project} shared=${seed.embedPending.shared}`,
  );
  if (relevance) await ensureRelevanceModel(client, relevance.modelId, log);
  // Load the embedding (and relevance) models before measuring, so latency
  // is the warm path. A relevance model that fails its load-time self-check
  // shows here, not as an arm that quietly scored nothing.
  const warmed = await client.retrieval.previewRetrieval(project.id, {
    surface: 'search',
    query: 'warm up',
    warm: true,
    ...(relevance ? { relevanceModel: { enabled: true, modelId: relevance.modelId } } : {}),
  });
  if (relevance && warmed.relevanceModel?.status !== 'scored') {
    throw new Error(
      `relevance model ${relevance.modelId} is not answering after warm-up (status ${warmed.relevanceModel?.status ?? 'none'})`,
    );
  }

  const reports: BenchReport[] = [];
  const drives = new Map<string, DriveResult>();
  for (const arm of arms) {
    log(`[retrieval-bench] arm ${arm.label}`);
    const drive = await driveRetrievalBench(client, corpus, queries, {
      projectId: project.id,
      mode,
      rounds,
      ...(arm.relevanceModel ? { relevanceModel: arm.relevanceModel } : {}),
      log,
    });
    drives.set(arm.label, drive);
    const report = buildBenchReport({ arm: arm.label, mode, seed, queries, drive });
    reports.push(report);
    const suffix = arms.length > 1 ? `-${arm.label.replace(/[^\w.-]+/g, '_')}` : '';
    await client.writeProjectArtifact(
      project.id,
      `retrieval-bench/report${suffix}.md`,
      renderBenchMarkdown(report),
    );
    await client.writeProjectArtifact(
      project.id,
      `retrieval-bench/traces${suffix}.json`,
      JSON.stringify({ rows: drive.rows, traces: drive.traces }, null, 2),
    );
  }
  const first = reports[0]!;
  await client.writeProjectArtifact(project.id, REPORT_ARTIFACT, JSON.stringify(first, null, 2));
  await client.writeProjectArtifact(project.id, REPORT_MARKDOWN, renderBenchMarkdown(first));
  if (arms.length === 1) {
    const drive = drives.get(arms[0]!.label)!;
    await client.writeProjectArtifact(
      project.id,
      TRACES_ARTIFACT,
      JSON.stringify({ rows: drive.rows, traces: drive.traces }, null, 2),
    );
  } else {
    await client.writeProjectArtifact(project.id, ARMS_ARTIFACT, JSON.stringify(reports, null, 2));
    await client.writeProjectArtifact(
      project.id,
      COMPARISON_MARKDOWN,
      renderArmComparison(reports, drives),
    );
  }
  const off = drives.get('off');
  const raw = drives.get('raw');
  if (relevance && off && raw) {
    const offDev = first.summaries.dev;
    const floor = (surface: string) => {
      const summary = offDev.find((s) => s.surface === surface);
      return {
        strictRecall5: summary?.strictRecall5?.estimate ?? null,
        setPrecision: summary?.setPrecision?.estimate ?? null,
      };
    };
    const turnCap = Math.max(
      1,
      ...off.rows.filter((row) => row.surface === 'turn').map((row) => row.kept.length),
    );
    const caps = {
      turn: { items: turnCap, knowledge: 2 },
      references: { items: 5 },
      search: {
        items: Math.max(
          1,
          ...raw.rows.filter((r) => r.surface === 'search').map((r) => r.kept.length),
        ),
      },
    } as const;
    const sweeps: SurfaceSweep[] = [];
    for (const split of ['dev', 'test'] as const) {
      for (const surface of ['turn', 'references', 'search'] as const) {
        sweeps.push(
          sweepSurface({ surface, split, rows: raw.rows, traces: raw.traces, caps: caps[surface] }),
        );
      }
    }
    const dev = (surface: string) =>
      sweeps.find((sweep) => sweep.split === 'dev' && sweep.surface === surface) ?? null;
    const recommendation = recommendThresholds({
      turn: dev('turn'),
      references: dev('references'),
      search: dev('search'),
      baselines: { turn: floor('turn'), references: floor('references'), search: floor('search') },
    });
    await client.writeProjectArtifact(
      project.id,
      SWEEP_ARTIFACT,
      JSON.stringify({ modelId: relevance.modelId, recommendation, sweeps }, null, 2),
    );
    await client.writeProjectArtifact(
      project.id,
      SWEEP_MARKDOWN,
      renderSweepMarkdown({ sweeps, recommendation, modelId: relevance.modelId }),
    );
    log(
      `[retrieval-bench] sweep recommends ${recommendation.thresholds ? JSON.stringify(recommendation.thresholds) : 'nothing'}`,
    );
  }
  lastReport = first;
}

export const retrievalBenchScenario: EvalScenario = {
  id: 'retrieval-bench',
  requiresEmbeddings: true,
  description:
    'Retrieval-quality benchmark (no agent): seeds a labeled multi-corpus fixture with decoys and measures ranking, filtering (false-injection, distractor rate), and latency for the turn, reference-list, and search surfaces through the retrieval preview route.',
  prompt: 'Retrieval bench runs entirely in setup; this prompt is never sent.',
  skipInitialPrompt: true,
  timeoutMs: 60 * 60_000,
  setup,
  successCheck: async (): Promise<SuccessCheckResult> => {
    const report = lastReport;
    if (!report) return { done: true, success: false, reason: 'setup did not produce a report' };
    const unembedded = report.seed.embedPending.project + report.seed.embedPending.shared;
    const turn = report.summaries.all.find((s) => s.surface === 'turn');
    const valid = unembedded === 0 && report.errors.length === 0;
    return {
      done: true,
      success: valid,
      reason: valid
        ? `labels ${report.labelsHash}; turn nDCG@5=${turn?.ndcg5?.estimate.toFixed(2) ?? '—'} false-injection=${turn?.falseInjectionStrict?.estimate.toFixed(2) ?? '—'} p95=${turn?.latencyP95Ms.toFixed(0) ?? '—'}ms`
        : `measurement invalid: ${unembedded} files unembedded, ${report.errors.length} preview errors`,
    };
  },
};
