import { MERGE_WEIGHTS, type UnifiedSearchResult } from '@bendyline/gezel';
const INJECTION_MIN_RELEVANCE: Partial<Record<UnifiedSearchResult['kind'], number>> = {
  content: 120 / 420,
  symbol: 120 / 520,
  document: 120 / 680,
  memory: 120 / 360,
  session: 120 / 400,
  // The behavior-preserving quotient over the knowledge merge weight; the
  // knowledge-bench evals own tuning it from here.
  knowledge: 120 / 370,
};
const INJECTION_MIN_RELEVANCE_DEFAULT = 0.25;
export function clearsInjectionFloor(result: UnifiedSearchResult): boolean {
  const floor = INJECTION_MIN_RELEVANCE[result.kind] ?? INJECTION_MIN_RELEVANCE_DEFAULT;
  // Results from older callers/stubs may lack `relevance`; derive it from the
  // weighted score so the check stays exactly equivalent to the old floor.
  const relevance = result.relevance ?? result.score / (MERGE_WEIGHTS[result.kind] || 1);
  return relevance >= floor;
}

export function admitsUnjudgedKnowledge(result: UnifiedSearchResult): boolean {
  return result.arm === 'vector' && clearsInjectionFloor(result);
}
