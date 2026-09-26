import {
  type RelevanceModelOverride,
  type RetrievalDecisionTrace,
  type RetrievalMode,
  type RetrievalPreviewResponse,
  type RetrievalTraceSurface,
  estimateTokens,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { BenchCorpus } from './corpus/build.ts';
import { type BenchQuery, type Grade, reachableCorpora } from './corpus/queries.ts';
import type { JudgedRow } from './metrics.ts';

export interface DriveOptions {
  projectId: string;
  /** Per-turn policy mode the turn surface is judged under (the runner turns retrieval off). */
  mode: RetrievalMode;
  /** Measured rounds per query; round 1 is judged, every round feeds latency. */
  rounds: number;
  surfaces?: readonly RetrievalTraceSurface[];
  /** This arm's relevance model (absent: the daemon's setting, which the bench leaves off). */
  relevanceModel?: RelevanceModelOverride;
  log: (line: string) => void;
}

export interface CandidateRecord {
  queryId: string;
  surface: RetrievalTraceSurface;
  trace: RetrievalDecisionTrace | null;
}

export interface DriveResult {
  /** One judged row per (query, surface), from round 1. */
  rows: JudgedRow[];
  /** Server-side latency of every round, per surface. */
  latencies: Record<string, number[]>;
  /** (query, surface) pairs whose kept set differed between warm rounds. */
  unstable: string[];
  /** Round-1 decision traces — the raw material for threshold sweeps. */
  traces: CandidateRecord[];
  errors: string[];
}

/**
 * Run every query on each of its surfaces through the retrieval preview —
 * the real decision code, no side effects — and turn the responses into
 * judged rows. Latency is the route's own `totalMs`, so HTTP overhead does
 * not dilute the surface's cost.
 */
export async function driveRetrievalBench(
  client: GezelClient,
  corpus: BenchCorpus,
  queries: readonly BenchQuery[],
  opts: DriveOptions,
): Promise<DriveResult> {
  const corpusOf = new Map(corpus.docs.map((doc) => [doc.docKey, doc.corpus]));
  const rows: JudgedRow[] = [];
  const latencies: Record<string, number[]> = {};
  const unstable: string[] = [];
  const traces: CandidateRecord[] = [];
  const errors: string[] = [];

  for (const query of queries) {
    for (const surface of query.surfaces) {
      if (opts.surfaces && !opts.surfaces.includes(surface)) continue;
      let first: RetrievalPreviewResponse | null = null;
      let firstKept = '';
      for (let round = 0; round < opts.rounds; round++) {
        let response: RetrievalPreviewResponse;
        try {
          response = await client.previewRetrieval(opts.projectId, {
            surface,
            query: query.text,
            messageOrigin: query.messageOrigin,
            ...(surface === 'turn' ? { mode: opts.mode } : {}),
            ...(query.craftbookName ? { craftbookName: query.craftbookName } : {}),
            ...(surface === 'references' ? { includeText: true } : {}),
            ...(opts.relevanceModel ? { relevanceModel: opts.relevanceModel } : {}),
          });
        } catch (err) {
          errors.push(
            `${query.id} ${surface}: ${err instanceof Error ? err.message : String(err)}`,
          );
          break;
        }
        const surfaceLatencies = latencies[surface] ?? [];
        surfaceLatencies.push(response.timings.totalMs);
        latencies[surface] = surfaceLatencies;
        const kept = unique(response.kept.map((hit) => hit.docKey));
        if (round === 0) {
          first = response;
          firstKept = kept.join('|');
        } else if (kept.join('|') !== firstKept) {
          unstable.push(`${query.id}@${surface}`);
        }
      }
      if (!first) continue;
      const reachable = reachableCorpora(surface);
      const reachableGrades = Object.entries(query.labels)
        .filter(([key]) => reachable.has(corpusOf.get(key)!))
        .map(([, grade]) => grade as Grade);
      const tokens =
        surface === 'turn'
          ? (first.estimatedTokens ?? 0)
          : surface === 'references'
            ? first.prompt
              ? estimateTokens(first.prompt)
              : 0
            : undefined;
      rows.push({
        queryId: query.id,
        class: query.class,
        split: query.split,
        surface,
        expect: query.expect,
        kept: unique(first.kept.map((hit) => hit.docKey)),
        labels: query.labels,
        decoys: query.decoys,
        reachableGrades,
        ...(tokens !== undefined ? { tokens } : {}),
        latencyMs: first.timings.totalMs,
        coldSkipped: first.embedder.status !== 'ready' || first.relevanceModel?.status === 'cold',
        ...(first.trace?.timedOut ? { timedOut: true } : {}),
      });
      traces.push({ queryId: query.id, surface, trace: first.trace });
    }
  }
  opts.log(
    `[drive] ${rows.length} judged rows, ${unstable.length} unstable, ${errors.length} errors`,
  );
  return { rows, latencies, unstable, traces, errors };
}

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}
