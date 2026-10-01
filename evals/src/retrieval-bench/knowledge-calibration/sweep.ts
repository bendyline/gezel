import { type RelevanceThresholds, relevanceFromModelScore } from '@bendyline/gezel';
import type { KnowledgeCalibrationQuery } from './queries.ts';

/**
 * Pure scoring for knowledge calibration. Evidence rows come from the
 * retrieval preview's `search` surface with every floor off
 * (GEZEL_KNOWLEDGE_VECTOR_FLOORS=off) and the relevance model in raw mode, so
 * each knowledge candidate carries its cosine and its model score; the
 * sweeps below replay what a floor or a knowledge bar would have admitted.
 */

export interface KnowledgeCandidate {
  docKey: string;
  arm?: string;
  similarity?: number;
  modelScore?: number;
}

export interface EvidenceRow {
  query: KnowledgeCalibrationQuery;
  candidates: readonly KnowledgeCandidate[];
}

export interface FloorSweepRow {
  floor: number;
  /** Off-topic queries where some hit from this catalog cleared the floor. */
  offTopicCleared: number;
  /** On-topic queries (of this catalog's class) whose answer cleared the floor. */
  answered: number;
  answersCleared: number;
  answersWithSimilarity: number;
}

const inCatalog = (docKey: string, catalogKey: string) =>
  docKey.startsWith(`knowledge://${catalogKey}/`);

/** What a cosine floor for one catalog admits, query by query. */
export function sweepVectorFloor(
  rows: readonly EvidenceRow[],
  catalogKey: string,
  onTopicClass: KnowledgeCalibrationQuery['class'],
  floors: readonly number[],
): FloorSweepRow[] {
  return floors.map((floor) => {
    let offTopicCleared = 0;
    let answered = 0;
    let answersCleared = 0;
    let answersWithSimilarity = 0;
    for (const { query, candidates } of rows) {
      const vector = candidates.filter(
        (c) => inCatalog(c.docKey, catalogKey) && c.similarity !== undefined,
      );
      if (query.class === 'abstain') {
        if (vector.some((c) => (c.similarity ?? 0) >= floor)) offTopicCleared++;
        continue;
      }
      if (query.class !== onTopicClass) continue;
      let hit = false;
      for (const c of vector) {
        if (!query.answers.includes(c.docKey)) continue;
        answersWithSimilarity++;
        if ((c.similarity ?? 0) >= floor) {
          answersCleared++;
          hit = true;
        }
      }
      if (hit) answered++;
    }
    return { floor, offTopicCleared, answered, answersCleared, answersWithSimilarity };
  });
}

export interface KeepSweepRow {
  keep: number;
  /** Off-topic queries where the model admitted some knowledge candidate. */
  falseInjection: number;
  /** On-topic queries with an answer among the first `cap` admitted candidates. */
  answered: number;
  answersKept: number;
  answersScored: number;
}

/** What a knowledge relevance bar admits, with each score mapped through `thresholds`. */
export function sweepKnowledgeKeep(
  rows: readonly EvidenceRow[],
  thresholds: RelevanceThresholds,
  keeps: readonly number[],
  cap = 2,
): KeepSweepRow[] {
  return keeps.map((keep) => {
    let falseInjection = 0;
    let answered = 0;
    let answersKept = 0;
    let answersScored = 0;
    for (const { query, candidates } of rows) {
      const admitted = candidates.filter(
        (c) =>
          c.modelScore !== undefined && relevanceFromModelScore(c.modelScore, thresholds) >= keep,
      );
      if (query.class === 'abstain') {
        if (admitted.length > 0) falseInjection++;
        continue;
      }
      if (query.class === 'either') continue;
      if (admitted.slice(0, cap).some((c) => query.answers.includes(c.docKey))) answered++;
      for (const c of candidates) {
        if (!query.answers.includes(c.docKey) || c.modelScore === undefined) continue;
        answersScored++;
        if (relevanceFromModelScore(c.modelScore, thresholds) >= keep) answersKept++;
      }
    }
    return { keep, falseInjection, answered, answersKept, answersScored };
  });
}

export interface InjectionScore {
  falseInjection: number;
  abstain: number;
  answered: number;
  onTopic: number;
  keptRelevant: number;
  kept: number;
  eitherInjected: number;
  either: number;
}

/** Score what per-turn injection actually kept (knowledge docKeys, in order). */
export function scoreInjection(
  rows: ReadonlyArray<{ query: KnowledgeCalibrationQuery; kept: readonly string[] }>,
): InjectionScore {
  const score: InjectionScore = {
    falseInjection: 0,
    abstain: 0,
    answered: 0,
    onTopic: 0,
    keptRelevant: 0,
    kept: 0,
    eitherInjected: 0,
    either: 0,
  };
  for (const { query, kept } of rows) {
    if (query.class === 'abstain') {
      score.abstain++;
      if (kept.length > 0) score.falseInjection++;
    } else if (query.class === 'either') {
      score.either++;
      if (kept.length > 0) score.eitherInjected++;
    } else {
      score.onTopic++;
      if (kept.some((key) => query.answers.includes(key))) score.answered++;
      score.kept += kept.length;
      score.keptRelevant += kept.filter(
        (key) => query.answers.includes(key) || query.related.includes(key),
      ).length;
    }
  }
  return score;
}
