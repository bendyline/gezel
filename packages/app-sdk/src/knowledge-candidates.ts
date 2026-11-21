import type {
  AppKnowledgeCandidate,
  AppKnowledgeRetrieval,
} from '@bendyline/gezel-client/app-models';

/**
 * A passage the app found in its own content, such as one of the person's
 * notes, under a `knowledge://local/<collection>/<path>` reference. Hand
 * candidates to `knowledge.retrieve` or `knowledgeContext` so Gezel ranks
 * them with catalog passages.
 */
export type KnowledgeCandidate = AppKnowledgeCandidate;

const LOCAL_PREFIX = 'knowledge://local/';

/**
 * Catalog passages and the app's candidates taking turns, a catalog passage
 * first, within the budget; a passage that would overrun it is shortened.
 * This is what Gezel does without the relevance model, applied here for a
 * Gezel that predates candidates, a device without one, or a failed catalog
 * search. `reranked` stays true only when no candidate was included.
 */
export function interleaveKnowledgeCandidates(
  retrieval: AppKnowledgeRetrieval,
  candidates: readonly KnowledgeCandidate[],
  budget: { readonly maxResults: number; readonly maxCharacters: number },
): AppKnowledgeRetrieval {
  const own = candidates.map((candidate) => ({
    uri: candidate.uri,
    title: candidate.title,
    text: candidate.text,
    catalogId: candidate.uri.slice(LOCAL_PREFIX.length).split('/', 1)[0] ?? '',
    version: 'local',
    own: true,
  }));
  const turns = Math.max(retrieval.passages.length, own.length);
  const ordered = [];
  for (let index = 0; index < turns; index++) {
    const catalog = retrieval.passages[index];
    if (catalog) ordered.push({ ...catalog, own: false });
    const candidate = own[index];
    if (candidate) ordered.push(candidate);
  }
  const passages: AppKnowledgeRetrieval['passages'] = [];
  let remaining = budget.maxCharacters;
  let includesOwn = false;
  for (const { own: isOwn, ...passage } of ordered) {
    if (remaining <= 0 || passages.length >= budget.maxResults) break;
    const text = passage.text.slice(0, remaining);
    passages.push({ ...passage, text });
    remaining -= text.length;
    includesOwn ||= isOwn;
  }
  return { reranked: retrieval.reranked && !includesOwn, passages };
}
