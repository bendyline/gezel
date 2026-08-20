import type { GezelClient } from '@bendyline/gezel-client/node';
import {
  type CorpusManifest,
  loadCorpusManifest,
  materializeCorpus,
  seedCorpusIntoProject,
} from '../index-bench/corpus.ts';
import { driveEnrichmentToCompletion } from '../index-bench/drive.ts';
import { type RetrievalScore, scoreQuery, scoreRetrieval } from '../index-bench/metrics.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Index-quality bench — NO agent involved. All the work happens in `setup`:
 * seed the pinned corpus, measure retrieval at three checkpoints
 * (structural-only → post-file-enrichment → post-area-pass), write the
 * report as a project artifact so the runner's captureFinalState lands it
 * in the trial runDir. Because the trial model IS the enricher model, a
 * `--models a,b,c` sweep of this scenario is the enricher A/B.
 *
 * Env knobs (set by the index-bench bin): GEZEL_INDEX_BENCH_CORPUS,
 * GEZEL_INDEX_BENCH_LIMIT_FILES (smoke mode), GEZEL_INDEX_BENCH_DRIVE_MS.
 */

const REPORT_ARTIFACT = 'index-bench/report.json';
const MODES = ['keyword', 'semantic', 'auto'] as const;

interface CheckpointScores {
  keyword: RetrievalScore;
  semantic: RetrievalScore;
  auto: RetrievalScore;
}

export interface IndexBenchReport {
  corpus: string;
  sha: string;
  embedModel: string;
  seeded: number;
  limitFiles: number | null;
  scan: { fileCount: number; durationMs: number };
  checkpoint1: CheckpointScores;
  drive: {
    files: number;
    summarized: number;
    embedded: number;
    calls: number;
    durationMs: number;
    /** Files processed by the review pass, and its separate wall-clock — a
     *  second full LLM sweep whose cost must sit next to the recall numbers. */
    reviewed: number;
    reviewMs: number;
  };
  enrichment: { eligible: number; summarized: number; embedded: number; pending: number } | null;
  reviews: {
    eligible: number;
    reviewed: number;
    stale: number;
    pending: number;
    avgHealth: number | null;
    majorIssues: number;
    minorIssues: number;
  } | null;
  checkpoint2: CheckpointScores;
  areas: {
    updated: number;
    architecture: boolean;
    architectureLength: number;
    withPurpose: number;
    expectedCovered: number;
    expectedTotal: number;
  };
  ok: boolean;
}

// Module-level, not WeakMap<EvalContext>: the runner hands setup and
// successCheck DIFFERENT ctx objects, and trials run sequentially in-process,
// so a singleton is the reliable channel (wild-caught in the first smoke run).
let lastReport: IndexBenchReport | null = null;

async function runGoldenQueries(
  client: GezelClient,
  projectId: string,
  manifest: CorpusManifest,
): Promise<CheckpointScores> {
  const out = {} as CheckpointScores;
  for (const mode of MODES) {
    const outcomes = [];
    for (const q of manifest.goldenQueries) {
      const res = await client
        .toolSearchCode(projectId, { query: q.query, mode, maxResults: 10 })
        .catch(() => null);
      outcomes.push(
        scoreQuery(
          (res?.results ?? []).map((r) => r.path),
          q,
        ),
      );
    }
    out[mode] = scoreRetrieval(outcomes);
  }
  return out;
}

async function pollScanComplete(
  client: GezelClient,
  projectId: string,
  log: (line: string) => void,
): Promise<{ fileCount: number; durationMs: number }> {
  const started = Date.now();
  const deadline = started + 10 * 60_000;
  await client.refreshProjectIndex(projectId).catch(() => undefined);
  for (;;) {
    const status = await client.getProjectIndexStatus(projectId).catch(() => null);
    if (status?.state === 'fresh') {
      return { fileCount: status.meta?.fileCount ?? 0, durationMs: Date.now() - started };
    }
    if (Date.now() > deadline) throw new Error('structural scan did not complete within 10m');
    log(`[bench] waiting for structural scan (state=${status?.state ?? 'unknown'})`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  const corpusId = process.env.GEZEL_INDEX_BENCH_CORPUS ?? 'squisq';
  const limitFiles = process.env.GEZEL_INDEX_BENCH_LIMIT_FILES
    ? Number.parseInt(process.env.GEZEL_INDEX_BENCH_LIMIT_FILES, 10)
    : null;
  const driveMs = process.env.GEZEL_INDEX_BENCH_DRIVE_MS
    ? Number.parseInt(process.env.GEZEL_INDEX_BENCH_DRIVE_MS, 10)
    : 90 * 60_000;

  lastReport = null;
  const manifest = await loadCorpusManifest(corpusId);
  const corpusDir = await materializeCorpus(manifest);
  log(`[bench] corpus ${manifest.id}@${manifest.sha.slice(0, 12)} at ${corpusDir}`);

  const project = await client.createProject({
    name: `index-bench-${manifest.id}`,
    about: `Benchmark corpus: a pinned subset of ${manifest.id} used to measure index quality. Read-only for agents.`,
    missionObjectives: 'Serve as the boekwachter index-quality benchmark corpus.',
  });
  const { seeded } = await seedCorpusIntoProject(client, project.id, corpusDir, {
    ...(limitFiles ? { limitFiles } : {}),
    priorityPaths: [
      manifest.refactor.defFile,
      ...manifest.goldenQueries.flatMap((q) => q.expected),
    ],
    log,
  });

  const scan = await pollScanComplete(client, project.id, log);
  log(`[bench] structural scan done: ${scan.fileCount} files in ${scan.durationMs}ms`);

  log('[bench] checkpoint 1 (structural only)');
  const checkpoint1 = await runGoldenQueries(client, project.id, manifest);

  log('[bench] driving enrichment to completion');
  // reviews:true also drains the review pass; on control daemons running
  // GEZEL_FILE_REVIEWS=0 it cleanly no-ops (no rubrics → zero review work).
  const drive = await driveEnrichmentToCompletion(client, project.id, {
    deadlineMs: driveMs,
    areas: true,
    reviews: true,
    log,
  });
  const status = await client.getProjectIndexStatus(project.id).catch(() => null);

  log('[bench] checkpoint 2 (post enrichment)');
  const checkpoint2 = await runGoldenQueries(client, project.id, manifest);

  const map = await client.toolMapRepo(project.id, {});
  const withPurpose = map.areas.filter((a) => a.purpose?.trim()).length;
  const covered = manifest.expectedAreas.filter((area) =>
    map.areas.some((a) => a.path === area && a.purpose?.trim()),
  ).length;

  const report: IndexBenchReport = {
    corpus: manifest.id,
    sha: manifest.sha,
    // The daemon stamps the actual embedder into the index; fall back to the
    // env only if the stamp is somehow absent.
    embedModel:
      status?.enrichment?.embedModel ?? process.env.GEZEL_EMBED_MODEL ?? '(daemon default)',
    seeded,
    limitFiles,
    scan,
    checkpoint1,
    drive: {
      files: drive.files,
      summarized: drive.summarized,
      embedded: drive.embedded,
      calls: drive.calls,
      durationMs: drive.durationMs,
      reviewed: drive.reviewed,
      reviewMs: drive.reviewMs,
    },
    enrichment: status?.enrichment ?? null,
    reviews: status?.enrichment?.reviews
      ? {
          ...status.enrichment.reviews,
          avgHealth: map.health?.avgHealth ?? null,
          majorIssues: map.health?.majorIssues ?? 0,
          minorIssues: map.health?.minorIssues ?? 0,
        }
      : null,
    checkpoint2,
    areas: {
      updated: drive.areasUpdated,
      architecture: Boolean(map.architecture?.trim()),
      architectureLength: map.architecture?.trim().length ?? 0,
      withPurpose,
      expectedCovered: covered,
      expectedTotal: manifest.expectedAreas.length,
    },
    // "ok" = the pipeline ran to completion; quality lives in the numbers.
    ok: scan.fileCount > 0 && drive.durationMs > 0,
  };
  await client.writeProjectArtifact(project.id, REPORT_ARTIFACT, JSON.stringify(report, null, 2));
  lastReport = report;
  log(
    `[bench] done: c1 semantic R@5=${checkpoint1.semantic.recallAt5.toFixed(2)} → c2 semantic R@5=${checkpoint2.semantic.recallAt5.toFixed(2)}, summarized=${report.enrichment?.summarized ?? '?'}/${report.enrichment?.eligible ?? '?'}, reviewed=${report.reviews?.reviewed ?? 0}/${report.reviews?.eligible ?? 0} (+${Math.round(drive.reviewMs / 1000)}s review sweep)`,
  );
}

export const indexBenchScenario: EvalScenario = {
  id: 'index-bench',
  requiresEmbeddings: true,
  description:
    'Direct index-quality benchmark (no agent): seeds a pinned real-codebase corpus, measures golden-query retrieval before/after LLM enrichment, and reports coverage + cost. The --models sweep is the enricher A/B.',
  prompt: 'Index bench runs entirely in setup; this prompt is never sent.',
  skipInitialPrompt: true,
  timeoutMs: 3 * 60 * 60_000,
  setup,
  successCheck: async (): Promise<SuccessCheckResult> => {
    if (!lastReport) {
      return { done: true, success: false, reason: 'setup did not produce a report' };
    }
    const report = lastReport;
    const lift = report.checkpoint2.semantic.recallAt5 - report.checkpoint1.semantic.recallAt5;
    return {
      done: true,
      success: report.ok,
      reason: `semantic R@5 ${report.checkpoint1.semantic.recallAt5.toFixed(2)}→${report.checkpoint2.semantic.recallAt5.toFixed(2)} (lift ${lift >= 0 ? '+' : ''}${lift.toFixed(2)}), MRR ${report.checkpoint2.auto.mrr.toFixed(2)}, summarized ${report.enrichment?.summarized ?? '?'}/${report.enrichment?.eligible ?? '?'}, areas ${report.areas.expectedCovered}/${report.areas.expectedTotal}`,
    };
  },
};
