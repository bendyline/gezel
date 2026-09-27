# Retrieval-bench labels

How the retrieval bench's relevance labels are made, and the rules for
changing them. The labels decide every number the bench reports, so they are
frozen before a scored run and changed only through this log.

## How grades are assigned

Every query belongs to a fictional entity family (`corpus/families.ts`) or is
generic step prose. Every document has a role in its family. A query's grades
come from one rule per query class (`GRADES_BY_CLASS` in `corpus/queries.ts`):

| Class | Grade 2 | Grade 1 | Expectation |
|---|---|---|---|
| title, paraphrase, launch, direct | golden, counterpart | background, near-miss, narrow | answer |
| multi-corpus | counterpart | golden, background | answer |
| near-miss-only | — | golden, narrow, counterpart | abstain or grade 1 |
| absent | — | — | abstain |
| step-prose | — | — | abstain |

Decoys (lexical, look-alike, boilerplate) are grade 0 and listed separately so
the distractor rates can count them.

**Every document is judged for every query.** Other families' documents and all
filler are grade 0 by construction: families are distinct fictional entities
in distinct domains, and filler's only proper noun is a generated name that a
test proves never appears in any family's text
(`corpus/corpus.test.ts`). So there is no "unjudged" document on the
synthetic tier and no pooled adjudication is needed there.

## Splits

- **dev**: families 1–8. Families 1–4 carry the four real incident decoys we
  have already tuned against: "All About DocBlocks" matching on `about`,
  QuEChERS for quiche, "Top Deck (drink)" / "Priority review" from PowerPoint
  step prose, and "Coronation quiche" as a narrow neighbour. Treat dev results
  as regression checks, not as evidence that a lever generalizes.
- **test**: families 9–12, with the same decoy categories but new examples.
  Score the test split once per lever decision. Do not tune against it.

The test families were written by the same author as the dev families. Before
a lever decision rests on the test split, a person should read families 9–12
and confirm the grades. Record that review below.

## Freezing

`labelsHash` in every report fingerprints the query ids, expectations,
labels, and decoys. Results with different hashes are not comparable.

## Change log

| Date | Change | Reason | New hash |
|---|---|---|---|
| 2026-09-26 | Initial labels: 12 families × 7 classes + 6 step-prose queries (90). Six near-miss-only queries rewritten before the first run because a narrow document answered them. | — | (first run) |
