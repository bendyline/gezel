# 0017 — A relevance model: an on-device cross-encoder, calibrated or reorder-only

Status: Accepted (2026-09)

## Context

A "PowerPoint about quiche", launched from the Meester with a food knowledge
catalog installed, surfaced QuEChERS (a pesticide-residue method) at a
"strong" 0.79, beside "Top Deck (drink)" and "Priority review". Nothing in
retrieval could have stopped it. Every relevance the search arms report is
derived from **rank**: RRF scores a rank-0 hit at its arm weight, keyword
arms use `ftsRankRelevance(rank)`, and knowledge hits are normalized so the
top result is 1.0. A floor on those numbers rejects only an empty arm, and a
query with nothing relevant still injects its best-ranked rows. The
`isGrounded` check (a keyword hit must contain a term the user typed) and the
reference list's lexical rule are string tests: they stop "All About
DocBlocks" for the word *about*, but they also drop a genuine semantic match
and cannot rank anything.

The launch reference list made this more expensive. Its entries ride every
step's prompt for the whole run, so one bad entry costs attention many times.

## Decision

Add an optional **relevance model**: a small cross-encoder that reads the
query and a passage together and scores the pair on its own. It re-judges the
top of the fused order inside `SearchService.searchProject`, for three
surfaces — per-turn injection and the reference list (`filter`), and the
model's `search` tool (`reorder`).

Its shape follows from what it must never do:

- **Never hold a turn.** A cold model answers `cold` and warms in the
  background; results pass through untouched. Budgets per surface (250 / 700
  / 400 ms) bound the scoring, with a deadline between batches.
- **Never drop on an unmeasured score.** Thresholds come from the retrieval
  bench and map the model's activated scores onto fixed relevance anchors
  (drop 0.1, keep 0.3, strong 0.6), so `strong` keeps meaning what the tier
  already means. A model with no thresholds may reorder, never drop.
- **Never be steerable.** It is a classifier, not a chat model, so retrieved
  text cannot talk it into anything. It runs in its own worker, and an
  import-graph test keeps its stack away from provider and chat code.
- **Never reach the network at search time.** Every file is pinned by sha256
  at an exact revision, downloaded only on opt-in and only when the security
  policy allows app network, and loaded with `local_files_only`. The model
  must separate a canned answer from a canned non-answer at load, and a pair
  encoding that never marks the passage segment is refused — a mis-wired
  cross-encoder returns plausible, wrong numbers.

A candidate a calibrated model scored is **judged**: kept or dropped on that
score alone, exempt from the rank floor, grounding, and the lexical rule.
Everything else goes through those rules exactly as before. Off or cold is
behaviorally identical to having no model.

It is named "relevance model" in code and "Relevance check" in the UI, never
"rerank": the knowledge reader's int8 cosine stage already owns that word.

## Alternatives considered

- **Ask the chat model to rank.** Slower by orders of magnitude, contends with
  the local engine for the one GPU, can be prompt-injected by the very text
  it judges, and is not deterministic.
- **Raise the floors.** Rank 0 is rank 0 whatever the bar; a higher floor
  only moves which rank survives.
- **Cosine similarity from the embedder.** Already present as the vector arm,
  already floored at its source, and a bi-encoder's similarity is a poor
  judge of "does this passage answer that".
- **Store the relevance model in `RetrievalPolicy`.** Policy resolves as a
  whole (step, gezel, install); a per-step policy would silently drop the
  model setting. It lives beside `faceRecognition` as `config.relevanceModel`.

## Consequences

- Default **off** until the outcome A/B shows it earns its download. The
  English model is calibrated from the bench (drop 1e-5, keep 3e-5, strong
  0.95 — [record](../../evals/src/retrieval-bench/RELEVANCE-CALIBRATION-2026-09-26.md));
  the multilingual one is not, so it only reorders.
- Keyword hits are judged on their whole indexed chunk, read for the scored
  window only, so search result shapes stay unchanged.
- `retrieval.context-injected` carries the model's score per kept hit and a
  summary (status, scored, hidden, ms); the decision trace gains
  `relevance-model` as a rejection reason.

## Regression surface

- [search/relevance-stage.test.ts](../../packages/service/src/search/relevance-stage.test.ts):
  cold passes through, uncalibrated never drops, filter versus reorder
  cutoffs, per-turn identity while cold, judged hits skipping grounding, the
  reference list's selection method.
- [relevance/relevance-core.test.ts](../../packages/service/src/relevance/relevance-core.test.ts):
  batching, deadlines, the self-check, the segment check, the graph pin.
- [relevance/containment.test.ts](../../packages/service/src/relevance/containment.test.ts):
  no provider or chat import.
- The retrieval bench (`evals/src/retrieval-bench/`) is the calibration and
  acceptance record.
