# Knowledge catalog effectiveness pilot — 2026-10-04

## Executive conclusion

The catalogs are useful, but the benefit is model- and task-dependent.

- The clearest win was Qwen 3.5 4B on exoplanets: the no-catalog arm failed after 34 tool calls with no valid research source, while the catalog arm passed 13/14 gates with two knowledge hits in 12 calls.
- Qwen 3.8 27B produced a strong food report in both arms, but the original control verdict was a grader false positive: it cited Wikipedia-looking URLs without ever calling a Wikipedia tool. Under the corrected provenance rule, the control fails and the catalog arm remains a valid pass because it recorded two knowledge hits.
- Qwen 3.5 4B's food treatment was grounded but still failed because it omitted the four-entry Sources list and an important calibration caveat. A catalog does not by itself guarantee citation formatting.
- Gemma 31B was grounded more reliably with the catalog, but both arms failed. The treatment spent 28m40s and 30 calls on an 18-minute repair stall without rewriting the artifact. This is primarily a runtime/model-loop problem, not a knowledge-availability problem.
- Gemma E2B could not produce a file in either arm. Gemma E4B improved from 8/14 observed signals without a catalog to 10/14 with five catalog hits, but still failed. These models are below the reliable action/tool-use floor for this workflow as currently tuned.

This is a pilot, not a statistically powered benchmark: one observed trial per selected cell, plus one cross-topic replication. It is enough to expose framework and evaluator defects and to justify a repeated-run matrix next.

## What was built

The `knowledge-effectiveness` suite contains six prompt-identical paired scenarios:

| Topic | Control | Catalog treatment | Output |
|---|---|---|---|
| Carbohydrates in food | Catalog scope explicitly off | `wikipedia-food-drink@2026.4.5` | 1,100–2,300 word research report |
| Antibiotic resistance | Catalog scope explicitly off | `wikipedia-medicine@2026.4.5` | 1,100–2,300 word research report |
| Exoplanet detection | Catalog scope explicitly off | `wikipedia-astronomy@2026.4.5` | 1,100–2,300 word research report |

Each pair uses the same prompt, Researcher role, report path, time budget, and deterministic rubric. The treatment installs and project-scopes one exact catalog version; the control uses `knowledgeCatalogs.mode=off`. Catalog use is observed rather than assumed.

The gate checks length, ordered sections, topic-specific factual coverage, a calibrated limitation, at least four source entries, at least two inline citations, and observed research evidence. Passing requires at least 85% of signals plus all core signals. One completed report revision is allowed.

Wikipedia is the only external research path intended for the controls. A successful `wikipedia_search` or `wikipedia_read` call is required to prove Wikipedia use. Generic `web_search`, `fetch_url`, and browser tools are rejected as out-of-scope research evidence and recorded diagnostically.

## Selected results

“Corrected fail” means the saved raw run said pass under the original evaluator, but re-scoring its captured tool history under the fixed provenance rule removes the required researched-source signal. The report artifact and trace are unchanged.

| Model | Topic / arm | Verdict | Quality | Research evidence | Calls | Duration | Interpretation |
|---|---|---:|---:|---|---:|---:|---|
| Gemma 31B | Food / control | Fail | 8/14, 346 words | No Wikipedia call | 20 | 23m04s | Revision shortened the report; local-search loop |
| Gemma 31B | Food / catalog | Fail | 8/14, 552 words | Successful catalog search + `knowledge://` sources | 30 | 28m40s | Grounded, but 18-minute repair stall and zero rewrites |
| Qwen 3.8 27B | Food / control | Corrected fail | 12/14 after correction, 1,483 words | No Wikipedia call; raw URLs only | 7 | 9m58s | Good prose, unverified provenance |
| Qwen 3.8 27B | Food / catalog | Pass | 13/14, 2,001 words | 2 knowledge hits, 886 injected tokens | 16 | 15m39s | Strong grounded report; slower and more calls |
| Qwen 3.5 4B | Food / control | Corrected fail | 12/14 after correction, 1,659 words | Local `search`, no Wikipedia call | 28 | 11m37s | Good-looking sources were not researched |
| Qwen 3.5 4B | Food / catalog | Fail | 12/14, 1,104 words | 2 knowledge hits, 713 injected tokens | 5 | 4m12s | Efficient and grounded, but no valid Sources list or calibration caveat |
| Gemma E2B | Food / control | Fail | No artifact | No valid research output | 9 | 17m01s | Emitted prose instead of an action; duration includes first download |
| Gemma E2B | Food / catalog | Fail | No artifact | 2 knowledge hits reached context | 12 | 7m22s | Could not apply a file edit after five attempts |
| Gemma E4B | Food / control | Fail | Latest 8/14, 1,253 words | No valid research source | 44 | 14m30s | Older four-feedback pilot trace; repeated local search |
| Gemma E4B | Food / catalog | Fail | Latest 10/14, 959 words | 5 knowledge hits, 1,869 injected tokens | 21 | 9m20s | Better coverage and grounding, still below length/action floor |
| Qwen 3.5 4B | Astronomy / control | Fail | 12/14, 1,881 words | No Wikipedia call | 34 | 4m06s | Search loop; missing selection bias and researched source |
| Qwen 3.5 4B | Astronomy / catalog | Pass | 13/14, 1,832 words | 2 knowledge hits, 720 injected tokens | 12 | 4m31s | Clear cross-topic catalog win |

No observed run invoked an out-of-scope generic web tool.

The medicine pair is implemented and deterministically gate-tested, but was not executed in this pilot. Runtime sampling covered every requested model on food plus the astronomy Qwen 4B cross-topic pair; medicine is the first recommended follow-up after the source-aware recovery fix.

## What the A/B says

### Catalogs improve grounding

Every treatment arm that produced a report had concrete catalog evidence. The strongest causal comparison is Qwen 3.5 4B on astronomy: the treatment converted a provenance failure into a pass while reducing calls from 34 to 12. Gemma E4B also gained two quality signals and five knowledge hits, although it remained below the task-completion floor.

### Catalogs do not automatically improve execution

On food, Qwen 3.5 4B's treatment was faster and used far fewer calls, but failed report-format requirements that the control artifact happened to satisfy. Gemma 31B found catalog material yet entered the same repair-loop family as the control. Knowledge access and workflow reliability need to be measured separately.

### Catalog setup has visible cost

Verified install/extraction added roughly two minutes in the final Gemma 31B treatment. Qwen 27B treatment duration was 57% higher than control (15m39s versus 9m58s), with 16 versus 7 calls. Some of this is setup and some is additional grounded drafting. Future reporting should separate catalog install, first retrieval, first artifact, and repair time explicitly.

### The smallest Gemma models are an action floor, not a catalog verdict

Gemma E2B failed to create an artifact in either arm. Gemma E4B used catalog context and improved content coverage but still failed to complete. These results should not be read as “catalogs ineffective”; they show that retrieval cannot compensate for models that cannot reliably choose and execute file tools.

## Bugs and improvements found

### 1. Evaluator provenance false positive — fixed

The first grader treated any `wikipedia.org` string in the report as proof of Wikipedia research. Qwen controls therefore passed after inventing or reproducing plausible-looking URLs without a `wikipedia_search` or `wikipedia_read` call. The evaluator now requires an observed successful Wikipedia tool call.

Catalog attribution was tightened at the same time. Automatic knowledge hits count directly; manual catalog search counts only when both a successful `search` call and a `knowledge://` citation are present. A citation-shaped URI alone is insufficient.

### 2. Generic web search is correctly hidden, but the debug roster is misleading

The production allowlist strips `web_search` when no keyed provider is configured (and when the provider is Wikipedia), while retaining `wikipedia_search` for local model tiers. The focused core tests pass. Daemon debug logs still print the bridge's full registered MCP roster, including `web_search`, before per-session filtering; this can look as though the model was offered the tool when it was not. No trial called it.

Improvement: log both “registered bridge tools” and the final model-facing allowlist with distinct labels, especially in eval recordings.

### 3. The factual-write recovery message routes models toward the wrong search

Rejected factual writes currently say: “call `search` now for the subject (also: `read_document`).” In a no-catalog project, models repeatedly call local/project `search`, receive little or no useful evidence, and never select the explicitly named Wikipedia tools from the task prompt.

Improvement: make the recovery message source-aware. With no active catalog and Wikipedia available, name `wikipedia_search` first. With a catalog active, name `search` with `sources: ["knowledge"]`. Do not suggest `read_document` unless a relevant document exists.

### 4. Repair turns can over-retrieve indefinitely

Gemma 31B catalog made 26 repair calls over 18 minutes with zero rewrites. Qwen 4B astronomy control made 34 calls. The evaluator's one-revision budget does not bound a single model turn, and runtime plateau nudges can prolong it.

Improvement: canonicalize retrieval calls by query/source/result signature and abort or force a mutation-only turn after three equivalent empty or non-novel results. Artifact progress—not token generation or another equivalent tool call—should reset the repair budget.

### 5. Retrieved chunks need citation-ready source cards

Qwen 4B food used the catalog but omitted the required Sources list. Gemma 31B reused `[1]` for five distinct `knowledge://` entries. The retrieval payload is useful for claims but not easy for small models to turn into coherent provenance.

Improvement: supply compact, numbered source cards with a stable title, catalog URI, optional canonical URL, and ready-to-copy Markdown citation. Preserve those identifiers across retrieval and factual-write validation.

### 6. Catalog installation should be cached and timed separately

Archives are checksum-pinned, but each isolated treatment home pays verified extraction/index setup. This is correct for isolation but obscures inference comparisons.

Improvement: add explicit `catalogInstallMs`, `firstKnowledgeHitMs`, and `catalogReadyAt` facts. Optionally use an immutable verified extracted-cache keyed by archive SHA for evals, then clone/link it into each isolated home.

### 7. Model-specific action tuning is needed

- Gemma E2B needs a much smaller action surface and a direct write-first grammar; otherwise exclude it from long research workflows.
- Gemma E4B benefits from catalog context but needs tighter write/repair enforcement.
- Gemma 31B needs an aggressive retrieval-repeat brake and likely lower verbosity/turn budget during repair.
- Qwen 3.5 4B needs explicit provenance formatting, not more retrieval.
- Qwen 3.8 27B is capable, but catalog setup and extra drafting materially increase latency.

## Recommended next experiment

Run three warm-cache repetitions for each model on food and astronomy, then one medicine pair per model after the source-aware factual-recovery fix. Report:

- valid pass rate (not artifact-only quality);
- factual coverage score;
- observed source channel and source count;
- catalog install time, first-source time, first-artifact time, and total time;
- retrieval calls, distinct result sets, rewrites, and factual-write rejections;
- unsupported-claim count from the factual guard.

The primary success criterion for the next iteration should be a higher valid pass rate with fewer non-novel retrieval calls. A catalog treatment that merely increases citations or tokens without improving grounded task completion should not count as a win.

## Reproduction notes

The two newly authored model entries used the sibling Gilde checkout:

```bash
GEZEL_GILDE_DATA_DIR=/home/mike/gh/gilde/data \
GEZEL_EVAL_KNOWLEDGE_ARCHIVE_DIR=/tmp/gezel-eval-knowledge \
pnpm eval:run -- knowledge-food-carbohydrates-catalog \
  --model qwen3.5-4b-q4 --timeout 2700000 --write-reports
```

Control scenarios do not need `GEZEL_EVAL_KNOWLEDGE_ARCHIVE_DIR`. Catalog scenarios fail setup if the exact archive is absent, fails installer verification, or does not mount with the pinned publisher, identity, and version.
