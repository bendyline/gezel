# Knowledge calibration — real catalogs, 2026-09-30

The values in `packages/service/src/knowledge/vector-floors.ts`
(`KNOWLEDGE_VECTOR_FLOORS`) and `KNOWLEDGE_FILTER_MIN_RELEVANCE` in
`packages/core/src/search-ranking.ts` come from this record. It is the
real-catalog run the [2026-09-26 relevance calibration](RELEVANCE-CALIBRATION-2026-09-26.md)
asked for before turning the check on by default.

## Why

The v1.26273.82 release audit found a Handboek excerpt attached to almost
every chat turn: "What is 17 times 23?" received the 1.26247 release notes.
The Handboek had just become a built-in catalog, so every install had one.
The cause was general to knowledge catalogs, not to the Handboek:

- Knowledge relevance was rank-anchored (`11/(11+rank)`), so the top hit was
  always 1.0 and the injection floor (0.32) rejected nothing.
- The knowledge vector arm had no cosine floor, so the nearest chunk always
  came back.
- Knowledge hits carried no `arm`, so `isGrounded` exempted them.
- The relevance model was off by default. When on, its keep cut (raw 3e-5)
  was chosen for recall on the synthetic bench, and the linear mapping
  squeezed every raw score from 3e-5 to about 0.05 into relevance 0.30–0.32.

## Setup

- Catalogs: `bendyline/handboek` 1.1.2 (bge-small-en-v1.5@1, the daemon's
  own embedder) and `bendyline/wikipedia-food-drink` 2026.4.3
  (multilingual-e5-small@2).
- Relevance model `ms-marco-minilm-l6@1` with the shipped thresholds
  (drop 1e-5, keep 3e-5, strong 0.95).
- 65 labelled queries in
  [knowledge-calibration/queries.ts](knowledge-calibration/queries.ts):
  20 Gezel questions (Handboek answers), 20 food questions (Wikipedia
  answers), 25 off-topic prompts that should inject nothing, and 5 task
  requests with a same-named craftbook page (`either`, not scored).
- Windows 11, daemon booted from the working tree with the mock chat
  provider (retrieval never prompts the chat model), Default project.
- Tool: `pnpm --filter @bendyline/gezel-evals run knowledge-calibration -- --home <home> --mode collect|validate`.
  `collect` needs the daemon started with `GEZEL_KNOWLEDGE_VECTOR_FLOORS=off`.

## Cosine floors (`collect`, search surface, floors off)

Answer similarity against the highest similarity any off-topic prompt reached:

| Catalog | Answers (min / median) | Off-topic max | Chosen floor |
|---|---|---|---|
| Handboek (bge-small) | 0.687 / 0.780 | 0.624 | **0.65** |
| Wikipedia Food & Drink (e5-small) | 0.869 / 0.894 | 0.875 | **0.865** |

- Handboek: every floor from 0.63 to 0.68 clears all 18 answers found and no
  off-topic prompt. 0.65 sits in the middle.
- Wikipedia: the e5 scale is compressed and the two distributions overlap.
  0.865 keeps all 22 answers and still admits 2 of 25 off-topic prompts
  ("Virivore" for virus versus bacterium, "Thermal death time" for a
  temperature conversion). 0.87 admits 1 and loses an answer.
- bge-small's genuine matches sit at 0.57 in the project library but 0.69 in
  the Handboek, so floors are keyed by catalog first and embedder second.
  `bge-small-en-v1.5@1` keeps the project index's measured 0.55 as the default
  for folder-built catalogs; `multilingual-e5-small@2` takes 0.865 for every
  Wikipedia shelf, which share one build.

5 of 23 Handboek answer documents never reached the candidate list at all
(for example `security-model` for a question about file permissions): a
retrieval ceiling that no floor or bar can fix.

## Knowledge relevance bar (`collect`, model scores mapped in logit space)

| Keep | Off-topic injected (of 25) | On-topic answered (of 40) | Answers kept (of 40 found) |
|---|---|---|---|
| 0.30 (the general keep) | 23 | 34 | 40 |
| 0.45 | 4 | 35 | 40 |
| **0.50** | **2** | **35** | **40** |
| 0.54 | 1 | 35 | 40 |
| 0.55 | 0 | 35 | 40 |
| 0.56 | 0 | 35 | 39 |

0.55 is clean on this set, but its lowest answer clears by 0.001, which is
fitting to 65 queries. 0.50 is chosen. Of the two off-topic prompts it
admits, one is defensible ("How do I say thank you in Japanese?" → "Customs
and etiquette in Japanese dining").

## End to end (`validate`, per-turn surface, balanced mode)

| Build | Relevance model | Off-topic injected | On-topic answered | Kept relevant | `either` injected |
|---|---|---|---|---|---|
| v1.26273.82 | off | 25/25 | 32/40 | 32/42 | 5/5 |
| v1.26273.82 | on | 23/25 | 29/40 | 30/42 | 4/5 |
| this change | off | **2/25** | 33/40 | 33/43 | 0/5 |
| this change | on | **1/25** | 30/40 | 31/41 | 1/5 |

With the model off, requiring vector evidence above the floor is what does
the work. Before it, the first cut of this change (floors plus the grounding
check) still injected 22 of 25: an encyclopedia always has a title that
shares a word with the request ("Olive Oil Times" for "17 times 23",
"Email / Inbox" for "draft an email", "Puppy chow" for a puppy's name). So an
unjudged catalog hit must be `vector`; keyword-only catalog hits still reach
the `search` tool.

"On-topic answered" counts the labelled answer only. Most model-on misses
injected a relevant neighbour instead ("Bread › Leavening › Sourdough" for
the sourdough question, "The Meester" section for the Meester question).
Balanced mode fits one knowledge chunk in its 250-token knowledge share, so
whichever ranks first wins.

## Caveats

- 65 queries on two catalogs, one machine, labelled by one person; answers
  are the documents the labeller picked, which undercounts good neighbours.
- The e5 floor has almost no margin. A new Wikipedia build or another e5
  catalog should be re-measured with `collect` before trusting 0.865.
- Every other bge-small catalog gets 0.55, which was measured on project
  content, not on a catalog.
- The relevance model's thresholds themselves were not re-fit here; only the
  knowledge bar on top of them.
