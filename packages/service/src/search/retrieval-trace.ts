import {
  type GezelConfig,
  type RetrievalDecisionReason,
  type RetrievalDecisionTrace,
  type RetrievalRelevanceSummary,
  type RetrievalTraceCandidate,
  type RetrievalTraceSurface,
  type UnifiedSearchResult,
  retrievalDocKey,
} from '@bendyline/gezel';

/**
 * Records one decision per search candidate while a retrieval surface
 * filters them. A candidate's first decision stands; `rejectRemaining`
 * closes out whatever a surface never reached, so a finished trace always
 * accounts for every candidate the search returned.
 */
export class RetrievalTraceBuilder {
  private readonly candidates = new Map<string, RetrievalTraceCandidate>();
  private readonly decided = new Set<string>();

  constructor(
    private readonly surface: RetrievalTraceSurface,
    private readonly queryHash: string,
  ) {}

  addAll(results: readonly UnifiedSearchResult[]): void {
    results.forEach((result, index) => {
      if (this.candidates.has(result.id)) return;
      this.candidates.set(result.id, {
        id: result.id,
        docKey: retrievalDocKey(result),
        ...(result.retrievalSource ? { source: result.retrievalSource } : {}),
        kind: result.kind,
        ...(result.arm ? { arm: result.arm } : {}),
        fusedRank: index,
        ...(result.relevance !== undefined ? { fusedRelevance: result.relevance } : {}),
        ...(result.similarity !== undefined
          ? { similarity: Math.round(result.similarity * 10_000) / 10_000 }
          : {}),
        kept: false,
        reason: 'budget',
      });
    });
  }

  /** Record the relevance model's score on each candidate it judged. */
  scored(scores: ReadonlyMap<string, number>): void {
    for (const [id, score] of scores) {
      const candidate = this.candidates.get(id);
      if (candidate) candidate.modelScore = Math.round(score * 10_000) / 10_000;
    }
  }

  keep(result: { id: string }): void {
    this.decide(result.id, true, 'kept');
  }

  reject(result: { id: string }, reason: Exclude<RetrievalDecisionReason, 'kept'>): void {
    this.decide(result.id, false, reason);
  }

  rejectRemaining(reason: Exclude<RetrievalDecisionReason, 'kept'>): void {
    for (const id of this.candidates.keys()) this.decide(id, false, reason);
  }

  finish(
    extra: {
      timedOut?: boolean;
      sourcesIncomplete?: boolean;
      relevanceModel?: RetrievalRelevanceSummary;
    } = {},
  ): RetrievalDecisionTrace {
    const candidates = [...this.candidates.values()];
    const counts: Record<string, number> = {};
    for (const candidate of candidates) {
      counts[candidate.reason] = (counts[candidate.reason] ?? 0) + 1;
    }
    return {
      surface: this.surface,
      queryHash: this.queryHash,
      candidates,
      counts,
      ...(extra.timedOut ? { timedOut: true } : {}),
      ...(extra.sourcesIncomplete ? { sourcesIncomplete: true } : {}),
      ...(extra.relevanceModel ? { relevanceModel: extra.relevanceModel } : {}),
    };
  }

  private decide(id: string, kept: boolean, reason: RetrievalDecisionReason): void {
    if (this.decided.has(id)) return;
    const candidate = this.candidates.get(id);
    if (!candidate) return;
    candidate.kept = kept;
    candidate.reason = reason;
    this.decided.add(id);
  }
}

/**
 * Per-candidate rows in history are opt-in: a busy install writes a
 * `retrieval.context-injected` event on most turns, and the counts answer
 * the everyday question. `GEZEL_RETRIEVAL_TRACE=1` (evals) or debug mode
 * turns the rows on.
 */
export function retrievalTraceEnabled(config: Pick<GezelConfig, 'debugMode'> | null): boolean {
  return process.env.GEZEL_RETRIEVAL_TRACE === '1' || config?.debugMode === true;
}

/** Trace fields for a retrieval history event. No text, only citations and scores. */
export function traceHistoryDetails(
  trace: RetrievalDecisionTrace,
  full: boolean,
): Record<string, unknown> {
  const rejected = Object.fromEntries(
    Object.entries(trace.counts).filter(([reason]) => reason !== 'kept'),
  );
  return {
    surface: trace.surface,
    rejected,
    ...(trace.timedOut ? { timedOut: true } : {}),
    ...(trace.relevanceModel ? { relevanceModel: trace.relevanceModel } : {}),
    ...(full ? { candidates: trace.candidates } : {}),
  };
}
