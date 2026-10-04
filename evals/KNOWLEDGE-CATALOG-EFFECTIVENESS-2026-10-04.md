# Knowledge catalog effectiveness rerun — 2026-10-04

## Executive conclusion

Knowledge catalogs are useful, but they are not a universal pass-rate boost.
Their clearest value is grounded-source availability when Wikipedia retrieval
is weak or when a model needs a second research channel. Whether that value
turns into a better deliverable depends heavily on the model's action policy.

The repeated small-model matrix completed 42 planned trials: three repetitions
per arm on food and astronomy, plus one medicine pair, for Gemma E2B, Gemma
E4B, and Qwen 3.5 4B. Controls passed 11/21 (52%); catalog treatments passed
9/21 (43%). The pooled result is not a catalog win. It decomposes into a small
Gemma E4B improvement, no change for E2B, and a regression for Qwen 4B.

The medium-model evidence is more favorable:

- Gemma 31B failed the final food control at 7/14 after 31.4 minutes, despite
  using Wikipedia. The matching catalog arm passed 12/14 after 37.3 minutes
  with six catalog sources and Wikipedia.
- Tuned Qwen 27B passed the same food task in both arms. The catalog arm was
  faster (12.3 versus 15.2 minutes) but retrieved more result sets (14 versus
  10). Both scored 13/14.

Wikipedia prompting is materially better. Among the 21 small-model control
trials, 16 (76%) made a successful Wikipedia call. Both final medium controls
also used Wikipedia. No scenario exposed or used generic web search.

## Experiment design

The `knowledge-effectiveness` suite contains prompt-identical pairs:

| Topic | Control | Catalog treatment | Deliverable |
|---|---|---|---|
| Carbohydrates in food | Knowledge scope off | `wikipedia-food-drink@2026.4.5` | 1,100–2,300 word report |
| Antibiotic resistance | Knowledge scope off | `wikipedia-medicine@2026.4.5` | 1,100–2,300 word report |
| Exoplanet detection | Knowledge scope off | `wikipedia-astronomy@2026.4.5` | 1,100–2,300 word report |

Each pair uses the same prompt, Researcher role, path, time budget, and
deterministic 14-signal rubric. Passing requires at least 12/14, including the
core structure, citation, and observed-research signals. One completed report
revision is allowed.

Wikipedia is the controls' only external research source. Provenance is
observational: a Wikipedia URL in prose does not count without a successful
`wikipedia_search` or `wikipedia_read` call. Catalog use requires an automatic
knowledge hit, or a successful knowledge-scoped search plus a `knowledge://`
source in the report. Generic `web_search`, browser, and fetch tools do not
count and were not offered.

## Repeated small-model matrix

| Model | Control pass rate | Catalog pass rate | Catalog actually used | Interpretation |
|---|---:|---:|---:|---|
| Gemma E2B | 1/7 | 1/7 | 2/7 | Action/tool-use floor; retrieval rarely became a deliverable |
| Gemma E4B | 3/7 | 4/7 | 2/7 | Small positive pass signal, but most treatment runs fell back to Wikipedia |
| Qwen 3.5 4B | 7/7 | 4/7 | 6/7 | Strong Wikipedia baseline; catalog access added calls and scenario variance |
| **Total** | **11/21** | **9/21** | **10/21** | No pooled catalog uplift |

By topic, catalog treatment moved food from 5/9 to 6/9, astronomy from 5/9 to
3/9, and medicine from 1/3 to 0/3. The medicine task was the hardest and has
only one repetition per arm, so its difference should not be over-read.

The important distinction is availability versus adoption. Only 10/21 catalog
trials produced observable catalog evidence. Gemma E4B passed two astronomy
treatments and one food treatment using Wikipedia alone. Those are valid task
passes, but not evidence that the catalog caused the result.

### Per-cell outcomes

| Model | Food control / catalog | Astronomy control / catalog | Medicine control / catalog |
|---|---:|---:|---:|
| Gemma E2B | 1/3 / 1/3 | 0/3 / 0/3 | 0/1 / 0/1 |
| Gemma E4B | 1/3 / 2/3 | 2/3 / 2/3 | 0/1 / 0/1 |
| Qwen 3.5 4B | 3/3 / 3/3 | 3/3 / 1/3 | 1/1 / 0/1 |

Catalog treatment was therefore helpful on Gemma E4B food, neutral in several
cells, and harmful on Qwen's astronomy and medicine samples. Inspection points
to workflow variance rather than bad source bytes alone: treatment runs often
made substantially more research calls, then missed format, caveat, or repair
requirements.

## Medium-model results

| Model/profile | Task / arm | Verdict | Score | Evidence | Retrieval sets | Duration |
|---|---|---:|---:|---|---:|---:|
| Gemma 31B | Food / control | Fail | 7/14, 591 words | Wikipedia | 13 tool calls before stall | 31.4m |
| Gemma 31B | Food / catalog | Pass | 12/14, 1,408 words | 6 catalog sources + Wikipedia | 16 | 37.3m |
| Qwen 27B, low effort | Food / control | Pass | 13/14, 1,989 words | Wikipedia | 10 | 15.2m |
| Qwen 27B, low effort | Food / catalog | Pass | 13/14, 1,701 words | 6 catalog sources + Wikipedia | 14 | 12.3m |

Gemma 31B is the strongest catalog-effect result: access converted a grounded
but incomplete Wikipedia report into a passing report. It was not efficient.
The treatment made five factual-write rejections and took nearly 41K output
tokens before converging.

Qwen 27B shows a different tradeoff. Catalog access did not improve its 13/14
quality score, but the run finished 19% faster despite four additional result
sets. The catalog install itself took 31.7 seconds. This suggests the retrieved
context shortened drafting/reasoning even though it did not reduce tool use.

The originally recommended three-repetition medium matrix was not completed.
Medium trials repeatedly occupy 12–40 minutes, and Gemma's failure mode is a
single long action loop rather than noisy scoring. The final matched pairs plus
the Qwen tuning A/B were more informative than spending several additional
hours replicating the same bounded stall.

## Model-specific action tuning

### Qwen 3.8 27B: promote low general reasoning effort

The only promoted model-profile change is general `reasoning_effort: low` for
Qwen 27B. Deep, coding, and precise profiles remain unchanged.

| A/B task | Existing medium | Candidate low | Decision signal |
|---|---:|---:|---|
| Food control | Pass 13/14, 1,267s, 16 retrieval sets | Pass 13/14, 912s, 10 sets | Same quality, 28% faster |
| Astronomy catalog | Fail at 1,253s hard ceiling | Pass 13/14 at 1,306s | Candidate completed |
| Tool-routing regression | Pass in 69s | Pass in 52s | No routing regression |

The candidate won 3/3 versus 2/3 and preserved quality. The Gilde authoring
entry was advanced to `1.0.5`, with low effort in the base and
`thinking-general` profiles. Manifest generation is still pending: three
attempts to refresh immutable Hugging Face metadata timed out, so no generated
Gilde data file was hand-edited.

### Qwen 3.5 4B: retain the current profile

Four action candidates and one stricter grounding limit were tested separately:

- `prompt.factual-research-first` moved 5/6 to 6/6 but cost more calls and time;
- a hard retrieval budget was 4/6 versus 4/6 and stranded recoverable turns;
- a non-fatal retrieval-to-write gate was 5/6 versus 5/6;
- sequential-tool enforcement was dynamically inert;
- a two-strike grounding limit made recovery worse.

None cleared the promotion bar. The shared framework fixes are retained; the
Qwen 4B manifest is unchanged.

### Gemma family

- E2B should not be routed to autonomous long-form research. It can sometimes
  pass, but most failures occur before a usable artifact exists.
- E4B benefits occasionally from catalog context but remains variable. Use
  checkpointed, shorter deliverables rather than a model-only tuning override.
- Gemma 31B can produce strong grounded work, but it spends minutes emitting a
  complete write call before the factual guard can reject it. Prompt tuning
  alone cannot reliably fix that action cost.

## Framework fixes implemented

### Source-aware research routing

Initial factual-writing instructions and recovery errors now name the usable
source explicitly:

- without a catalog: call `wikipedia_search` first;
- with a catalog: call `search({ query: "<subject>", sources: ["knowledge"] })`;
- do not suggest generic project search or `read_document` as a substitute.

The final Qwen catalog run live-validated the fallback. It ignored the first
two warnings and attempted three zero-evidence writes; the failure tracker
ended that turn, and the next continuation immediately called knowledge search
and Wikipedia before producing a 13/14 report.

### Durable, bounded factual-write recovery

Grounding refusal counts are now target-specific, survive turn boundaries, and
are reconstructed from persisted tool-call history. A successful write clears
the target. Plain grounding failures are recognized by the shared failure
tracker even when they do not begin with `ERROR:`; three ignored grounding
write failures end the current loop so a clean continuation can research.

Recovery text now says the next tool call *must* be the source lookup and says
not to save again first. This strongly improves Qwen behavior. Gemma 31B still
sometimes ignores it and performs a full rejected rewrite, demonstrating the
limit of prompt-only control.

### Retrieval-loop controls

Retrieval calls are fingerprinted by returned result set, not only by argument
text. Three equivalent results produce a mutation warning; a fourth aborts the
loop. Artifact/deliverable movement, rather than token streaming or another
search, controls the knowledge-scenario hard ceiling.

### Citation-ready retrieval and real provenance

Knowledge and Wikipedia results now carry compact source cards with stable
titles, URIs/URLs, and ready-to-copy citations. The evaluator accepts only
observed successful source calls. Catalog citations without a matching search
no longer count, and Wikipedia-looking prose URLs no longer create a false
pass.

### Harness timing, setup, and telemetry

- Catalog install, ready time, first source, first knowledge hit, first
  artifact, retrieval sets, mutations, rewrites, and grounding rejections are
  recorded separately.
- Knowledge installation and optional embedder prewarm are bounded.
- The debug log distinguishes registered bridge tools from the final
  model-facing allowlist.
- The scorer waits for committed turns before reading provenance.
- Single-run CLI flags can override reasoning budget and effort for clean A/Bs.

### Stale retry-loop nudge bug

The final Gemma trace exposed a harness race: a retry-loop “edit now” nudge was
queued while a valid rewrite was already streaming. It landed after the write
and caused a redundant overwrite. Pre-trigger retry nudges now defer whenever
any target turn is active; the bounded terminal watchdog still handles truly
stuck sessions. The final Qwen run exercised the fix and logged repeated
deferrals instead of queueing a stale edit.

## Remaining recommendations

1. **Enforce a temporary research-only tool surface after a grounding
   rejection.** Wording is enough for Qwen after bounded recovery, but Gemma
   can ignore it and spend minutes serializing another full report. On the
   next inference request, hide write tools until one successful required
   lookup occurs. A/B this first; do not lower the fail-open limit globally.

2. **Improve catalog retrieval ranking for broad research queries.** The food
   catalog's first broad result set included weak matches such as cod,
   placentophagy, and a research-center history. Query expansion or a
   topic-title boost should be calibrated against the new effectiveness suite.

3. **Treat catalog adoption as a first-class outcome.** Report pass rate,
   catalog-use rate, and Wikipedia-use rate separately. A treatment pass that
   never touches the catalog is not a catalog success.

4. **Add an immutable verified extraction cache keyed by archive SHA.** The
   bounded installer is reliable, but isolated homes still pay 3–32 seconds in
   the final medium runs and occasionally more during embedder startup.

5. **Tighten the Researcher role's source-count language.** “Eight to twelve
   substantive files” encourages 12–20 retrieval calls on source-based tasks.
   Say “files or sources,” and cap research to the smallest set that covers the
   requested claims unless the user asks for exhaustive review.

6. **Keep long research off E2B and checkpoint E4B.** Retrieval cannot make up
   for a model that cannot reliably move from evidence to an artifact.

## Validation

Focused validation after the final fixes:

- eval runner/scenario/install/failure tests: 245/245 passed;
- service evidence-ledger tests: 17/17 passed;
- core factual-writing/failure/repeat tests: 92/92 passed;
- eval and service TypeScript checks passed;
- service production build passed.

An attempted broad test invocation accidentally ran package-wide suites under
the restricted sandbox and surfaced unrelated subprocess/fixture failures
(including `EPERM` spawns and a pre-existing GEZK 0.6/0.7 build mismatch).
The correctly targeted suites above are green.

## Reproduction

```bash
GEZEL_GILDE_DATA_DIR=/home/mike/gh/gilde/data \
GEZEL_EVAL_KNOWLEDGE_ARCHIVE_DIR=/tmp/gezel-eval-knowledge \
pnpm eval:run -- knowledge-food-carbohydrates-catalog \
  --model qwen3.8-27b-q4 \
  --reasoning-budget 4096 \
  --reasoning-effort low \
  --timeout 20m \
  --runs-dir evals/runs/tune-qwen3.8-27b-q4/final-framework/candidate-low
```

Control scenarios do not require the archive directory. Catalog scenarios fail
setup if the exact archive is missing, fails verification, or does not mount
with the pinned publisher, identity, and version.
