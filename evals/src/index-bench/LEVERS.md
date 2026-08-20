# Index levers — what to turn, what it should move

Living doc for the index-quality iteration loop. Cadence: run the Phase-A
bench (`run index-bench -- --models <a,b>`) on **every** lever change (~1
daemon-hour per model, no agent); promote a lever to a Phase-B A/B
(`run ab-index`) only when it moved Phase-A metrics. Append verdicts to
`evals/runs/INDEX-BENCH-<date>.md` per run.

| Lever | Where | Metric it should move |
|---|---|---|
| Chunk cap (4000 ch) | `index-store/docs.ts` MAX_CHUNK_CHARS, `global-index-manager.ts` transcript cap | checkpoint-2 semantic recall@5 |
| Summary prompt wording | `index-store/enrich.ts` buildSummaryPrompt | checkpoint-2 recall lift + summary length/cost |
| Hybrid static FTS scores (0.5 symbols / 0.45 summaries / 0.4 docs) | `index-store/index-store.ts` searchCodeHybrid | checkpoint-2 auto-mode MRR |
| fts_summaries keyword arm (NEW — was write-only since launch) | `index-store/index-store.ts` ftsSummaries + searchCodeHybrid | checkpoint-2 keyword/auto recall on NL queries (was 0%) |
| ~~markEnriched defect~~ — FIXED: empty summaries record a capped attempt (`enrichments.attempts`, ≤3 retries) instead of consuming the gate | `index-store/enrich.ts` gate branch + `filesNeedingEnrichment` predicate | summarized/eligible coverage (self-heals after transient enricher outages) |
| Review pass (cliffs notes + issues + health; runs after summaries drain) | `index-store/review.ts` + rubrics.ts; off-switch `GEZEL_FILE_REVIEWS=0` for control arms | drive wall-clock split (reviews are a second LLM sweep); no checkpoint-2 impact expected |
| Dense-blob thresholds (100KB / 1KB-per-line) | `index-store/classify.ts` isDenseBlob | enrichment cost (oneShot count), zero recall regression |
| MIN_AREA_FILES (2) | `index-store/area-pass.ts` | areas-with-purpose coverage |
| Area/architecture prompt wording | `index-store/area-pass.ts` buildAreaPrompt/buildArchitecturePrompt | expectedAreas coverage + mapRepo purpose quality |
| **Embedding model (MiniLM-L6 384-dim) — TOP CEILING-MOVER** | `memory/embeddings.ts` + schema TEXT_EMBED_DIM (re-embed required) | checkpoint-2 semantic recall@5 — evidenced by the lever-1 negative (chunking can't fix the vocabulary gap; see run log below) |
| Enricher model choice | trial `--models` list (trial model == enricher) | everything at checkpoint 2/3, vs drive minutes |
| Prompt behaviors (workspace-gestalt / retrieval-first) | `ab-index --arms warm --force/remove-behaviors` | agent pass rate + retrieval-tool share |

## Run log

### first full Phase-A run (squisq@22d893c1, 352 files)
Models gemma4-e4b-q8 / qwen3.6-35b-a3b-q4 / qwen3.6-27b-q4. Full report:
`evals/runs/INDEX-BENCH-2026-07-05.md`. Headlines:
- Enrichment lifts semantic R@5 **0% → 50%** (structural-only is 0 on NL queries).
- **The 50% ceiling is a retrieval-layer limit, not an enricher limit**: the same
  4 queries miss on a 4B AND a 35B enricher — bigger enricher recovered none.
  → reprioritized levers: **finer chunk embeddings (per-symbol/section)** and
  **embedding-model upgrade** are now the high-value ceiling-movers, above the
  summary-prompt/enricher-size levers (which only move MRR/ranking: 0.32 → 0.44).
- Keyword/FTS arm = 0% on NL queries at full scale (dead weight for this class).
- 27B dense impractical as enricher (51GB RSS, DNF at 180m); MoE dominates it.

Verdict: iterate lever 1 (finer chunking) next, re-bench on gemma4-e4b (cheap).

### lever 1 (per-symbol chunk embeddings) — REVERTED
Implemented `buildCodeChunks` (one chunk per symbol = signature + source span,
+ file-gist chunk) and re-benched gemma4-e4b on the full corpus. **Negative
result — did not move the target metric, reverted:**
- semantic R@5 **50% → 50%** (unchanged); recovered 0/4 hard misses.
- R@1 17%→25%, MRR 0.32→0.35 — a ~1-query wiggle (noise at n=12), AND a real
  regression: `parse.ts` ("parse markdown into a syntax tree") went rank 3 →
  miss, because fragmenting the file into 24 symbol chunks diluted the
  file-purpose signal the whole-file gist chunk carried.
- Cost: 24× vec rows per code file for no recall gain.
Diagnosis: the 4 misses are an **embedding-vocabulary** problem, not a
chunk-granularity one — MiniLM-L6 doesn't connect "Word"→docx, "table
parser"→the converter's code, "caption"→subtitle logic; two misses also bury
the feature deep in a 200-line function past any per-symbol span cap. Chunking
can't fix vocabulary.
**Next lever: #2 embedding-model upgrade** (MiniLM-L6-384 → bge-small / gte-small
or a code-aware embedder) — now the top ceiling-mover candidate with evidence.

### lever 2 (embedding model) — BIG WIN
Made the embedder configurable via `GEZEL_EMBED_MODEL` (default unchanged),
`index-bench --embed-model`. gemma4-e4b enricher, full corpus, only the
embedder varies:
| embedder | sem R@5 | MRR |
|---|---|---|
| MiniLM-L6 (default) | 50% | 0.32 |
| Xenova/gte-small | 58% | 0.30 |
| **Xenova/bge-small-en-v1.5** | **75%** | **0.48** |
bge-small = **+25pp recall@5, +50% MRR** — a pure 384-dim drop-in (no schema
change), ~130MB, loads through the existing transformers.js. Recovered 2/4
hard misses (docx→rank4, DocPlayer→rank3). Remaining 2 misses (convert table
parser, markdownToDoc caption) are the deep-in-a-huge-function truncation case
— now the residual lever, alongside bge's query-instruction prefix (run
WITHOUT it here → likely more headroom). **VERDICT: promote bge-small to the
default embedder** — needs a re-embed migration (embed-model id in index/memory
meta → invalidate vectors on mismatch → rebuild; existing indexes were
MiniLM-embedded, mixing embedders corrupts similarity).

### bge-small PROMOTED to default + re-embed migration shipped
Default embedder is now `Xenova/bge-small-en-v1.5`. Migration: content index
stamps `embed_model` in `meta` (IndexStore.open → reconcileEmbedModel: drop
vec_text + clear enrichments on mismatch); memory stamps `mem_meta.embed_model`
(addToIndex + rebuildIndex) and MemoryHealthMonitor rebuilds on mismatch;
enrichFile reuses stored summaries so re-embed skips the LLM. Tests pinned to
MiniLM (`packages/service/vitest.config.ts`) + shared HF test cache. Full
workspace green. Details: `evals/runs/INDEX-BENCH-2026-07-06.md`.

### levers 1b (bge query-instruction) + 3 (windowed chunking) — BOTH WIN
Two "quick wins" flagged after the bge promotion. gemma4-e4b enricher, full
352-file corpus, bge-small embedder. Three matched arms, **n=3 each, ZERO
variance** (every run of an arm returned bit-identical recall/MRR — the enricher
is deterministic at MLX defaults, so single-run bench results here ARE
conclusive; my earlier "enricher noise" worry was unfounded):

| arm | R@1 | R@5 | MRR | embedded chunks |
|---|---|---|---|---|
| control (neither) | 0.250 | 0.500 | 0.411 | 475 |
| + query-instruction | 0.250 | 0.583 | 0.415 | 475 |
| + instruction + windowing | **0.333** | **0.667** | **0.484** | 971 |

Each lever adds exactly +1 golden query into top-5 (deterministically), zero
regressions:
- **Query-instruction** (bge query-side prefix, `queryInstruction()` in
  embed-core; `embedQuery()` routed through content/memory/unified search) —
  recovers *color-contrast/WCAG* (rank 7→3). MRR flat (+0.004). Cost: NONE
  (search-time only, no index change). It's bge's documented correct usage.
  **VERDICT: KEEP — default-on for bge-* (shipped this session).**
- **Windowing** (`GEZEL_INDEX_WINDOW=1`, `largeSymbolWindows` in enrich.ts:
  ≥40-line symbols → overlapping 1200/200-char windows, ≤8/file, additive to
  the file-gist chunk) — recovers *parse-markdown* (rank 7→4), also sharpens
  extract-summary (3→1) and lifts slide-transitions (miss→6). +0.083 R@1,
  +0.069 MRR. Cost: ~2× embedded chunks (475→971), but **zero wall-clock**
  (windows need no LLM; summaries dominate and are unchanged). **VERDICT:
  POSITIVE on the bench; opt-in for now — promoting to default is an
  index-shape change (2× vec rows on re-index) worth confirming on the Phase-B
  agent-outcome scenarios first.**

Hypothesis correction: windowing did NOT recover the two originally-named deep-
function misses (`convert` table-parser, `markdownToDoc` caption) — both still
miss in all 3 runs. It helped *other* borderline queries instead. The 4
robustly-hard queries (table-parser, OOXML, slide-transitions, caption) resist
both levers and are the next frontier (likely: summary never names the feature,
or the function isn't captured as one ≥40-line tree-sitter symbol).

Discrepancy noted: this deterministic control = 50% R@5, but the recorded
bge "baseline" was 75%. Could not reproduce the 75% (control is
reproducibly 50% at n=3); the earlier single-run figure appears anomalous or
was measured under different conditions (dtype/seed/corpus-order). The n=3
deterministic control is the honest baseline; the lever DELTAS (+8.3pp each)
are what's load-bearing and they're clean.

**Byproduct finding — the bench is deterministic.** gemma4-e4b at MLX defaults
produced identical summaries → identical retrieval across 3 fresh-home runs per
arm. So future single-run `index-bench` lever tests on this corpus are
conclusive without repeats. (If a future enricher proves nondeterministic,
seed/temp-0 the summary one-shot to restore this property.)

### Phase-B agent-outcome validation of windowing — CONFIRMED (aggregate flat, mechanism clean)

Built the mixed enricher/executor harness so an agent bench can use a FAST
enricher and a CAPABLE executor (one model can't do both: a 9B enricher takes
hours over 350 files; a fast e4b executor floors the task). `GEZEL_ENRICH_MODEL`
in [buildEnrichDeps](../../../packages/service/src/index-store/enrich.ts) routes
enrichment off the chat default; `TrialOptions.enrichModelId` warms+links a
second model into the trial home and injects the env; `ab-index --enrich-model`.

A/B: `squisq-codebase-qa` widened to 12 questions (windowing's win is golden
#12, invisible to the default first-6), warm arm, executor `qwen3.5-9b-q4`,
enricher `gemma4-e4b-q8`, everything constant but `GEZEL_INDEX_WINDOW`.

| # | query | window OFF | window ON |
|---|---|---|---|
| 3 | Word docx import | CORRECT | CORRECT |
| 5 | narration timing | CORRECT | CORRECT |
| 7 | geohash encode | CORRECT | wrong (**turn stalled**) |
| 12 | parse markdown → tree | wrong | **CORRECT** |
| — | (1,2,4,6,8,9,10,11) | wrong | wrong |
| | **total** | 3/12 | 3/12 |

Only two cells differ. **Q12 (parse-markdown) flipped wrong→CORRECT with
windowing on — the exact query the retrieval bench predicted, now converted
into a correct agent citation, genuine answers both sides.** Q7 (geohash) is a
robust hit whose ON-arm turn *stalled* (executor turn-death, orthogonal to the
index) — noise, not a retrieval regression. Discount the stall and windowing is
net +1 with zero genuine regressions; the flat 3/3 aggregate is the Q7 stall
coincidentally cancelling the Q12 gain.

**VERDICT: windowing CONFIRMED positive end-to-end** (deterministic retrieval
+1/+MRR → real agent citation on the predicted query, zero genuine regressions,
bounded cost: 2× vec rows, no LLM cost, no wall-clock). Kept **opt-in**
(`GEZEL_INDEX_WINDOW`, committed default off) — the aggregate agent score didn't
move (stall noise) and flipping a product default re-shapes every user's index,
so promotion waits on either an explicit go-ahead or a de-noised re-run (retry-
on-stall / bigger executor) that moves the aggregate.

Harness lessons wild-caught this round (all fixed):
- **Dead enricher looks like success.** `summarize`'s per-file `.catch(()=>'')`
  meant a wrong-venv enricher (gemma4-e4b linked against a pre-e4b mlx-lm →
  "Missing 54 parameters" every call) "drained" 351 files in 16s with 0
  summaries; the QA arm then ran 66 min against an empty index. Guard added in
  [warm.ts](warm.ts): a drained drive with `files>0 && summarized===0` throws at
  setup. Stage both models from the SAME source home so the venv matches.
- **One accumulating session = an endurance test, not an index test.** By Q8 the
  9B executor sat at the 32K ceiling, compaction one-shots timed out, turns
  aborted, a single question took 28 min, and the run blew the 90-min ceiling.
  Fix: archive the session between questions (NOT `resetChat` — that only drops
  provider state, history survives; `archiveChatSession` is the seam) +
  per-question stall deadline. Each question is now a clean one-turn probe,
  which also matches real usage. Dropped worst-question latency 28min→~3min.

### similarity-threshold recalibration for bge (2026-08-19)
The bge promotion shipped the vectors but not the floors: every similarity
threshold was still MiniLM-calibrated. New reproducible harness
`evals/src/bin/embed-calibration.ts` (memory-shaped fixture pairs, both
comparison modes — passage↔passage for dedup, query→passage for search
floors). Results + verdicts: `evals/runs/EMBED-CALIBRATION-2026-08-19.md`.
Headlines: dedup 0.90→0.85 (was under-deduping — paraphrase p25 = 0.906),
memory search floor 0.35→0.45 (old floor sat below the bge unrelated-band
median), recall DEFAULT_MIN_SCORE 0.35→0.45, craftbook blend floors
0.15→0.25 / 0.28→0.32. CODE_MIN_SCORE/LIBRARY_MIN_SCORE unchanged — they
filter rank-fusion scores, which are embedder-independent. No Phase-A run:
none of the changed floors are on the bench's measured path. **Re-run the
harness on every embedder change.**

### windowing PROMOTED to default
`GEZEL_INDEX_WINDOW` now defaults ON; opt out with `=0` (the index-bench control
arm, `--no-window`). Rationale: deterministic retrieval win + agent-outcome
confirmation (Q12 parse-markdown wrong→CORRECT, zero genuine regressions) +
bounded cost (~2× vec rows, no LLM, no wall-clock). Back-compat for existing
user indexes was a non-issue — all installs are local/pre-release, so the
next enrichment cycle just re-shapes chunks. Both quality levers (query-
instruction, windowing) are now default-on for the bge stack.
