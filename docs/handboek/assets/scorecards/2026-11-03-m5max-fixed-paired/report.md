# Condensed paired MLX versus llama.cpp comparison

Completed at the user’s request after 73 recorded trials, rather than running the original 516. The comparison uses 72 matched trials: 18 engine pairs per model, one repetition, across core and productivity. Developer and complex-work were not run. This outcome-visible chronological subset is exploratory.

**Practical equivalence within ±5 percentage points is not established.** Both models passed 16/18 on MLX and 18/18 on llama.cpp: an observed MLX-minus-llama.cpp difference of −11.11 pp. The conservative paired 95% interval is [−38.09, +20.66] pp for each; the cluster interval is [−26.32, 0.00] pp. These data also do not establish that the underlying gap exceeds 5 pp.

[Scope amendment](scope-amendment.md) · [Paired analysis](paired-analysis.md) · [Advisory judgments](judging.md) · [Machine-readable scorecard](analysis.json) · [Performance CSV](performance.csv) · [Performance audit](performance.json) · [MLX prefill recovery](mlx-prefill-recovery.md)

## Fixed outcomes and scores

Counts use the frozen gates and fixed rubric. The fixed composite is not an artifact quality score. Its completion/quality/efficiency/behavior components remain unchanged; runtime throughput and memory are separate.

| Model | Engine | Suite | Passes | Fixed mean /10 | Completion | Quality | Efficiency | Behavior |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Gemma 4 12B Q4 | mlx | all | 16/18 | 9.22 | 9.06 | 9.60 | 8.89 | 9.44 |
| Gemma 4 12B Q4 | mlx | core | 9/11 | 8.76 | 8.45 | 9.35 | 8.41 | 9.09 |
| Gemma 4 12B Q4 | mlx | productivity | 7/7 | 9.93 | 10.00 | 10.00 | 9.64 | 10.00 |
| Gemma 4 12B Q4 | llama-cpp | all | 18/18 | 9.75 | 10.00 | 10.00 | 9.17 | 9.44 |
| Gemma 4 12B Q4 | llama-cpp | core | 11/11 | 9.64 | 10.00 | 10.00 | 8.86 | 9.09 |
| Gemma 4 12B Q4 | llama-cpp | productivity | 7/7 | 9.93 | 10.00 | 10.00 | 9.64 | 10.00 |
| Qwen 3.8 27B Q4 | mlx | all | 16/18 | 9.12 | 9.22 | 9.40 | 8.33 | 9.44 |
| Qwen 3.8 27B Q4 | mlx | core | 10/11 | 9.11 | 9.36 | 9.09 | 8.64 | 9.09 |
| Qwen 3.8 27B Q4 | mlx | productivity | 6/7 | 9.14 | 9.00 | 9.89 | 7.86 | 10.00 |
| Qwen 3.8 27B Q4 | llama-cpp | all | 18/18 | 9.71 | 10.00 | 9.72 | 8.89 | 10.00 |
| Qwen 3.8 27B Q4 | llama-cpp | core | 11/11 | 9.75 | 10.00 | 9.55 | 9.32 | 10.00 |
| Qwen 3.8 27B Q4 | llama-cpp | productivity | 7/7 | 9.64 | 10.00 | 10.00 | 8.21 | 10.00 |

## Performance

Medians across the same included trials; maxima are shown separately for memory. No low-token admission rates or whole-trial token/time fallback are used as decode throughput.

| Model | Engine | Suite | Trial s | First token s | First tool s | First artifact s | Decode tok/s (n) | Aggregate prefill tok/s (n) | Observed MLX prefill tok/s (n) | Peak RSS GiB, median/max | Host used GiB, median/max |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Gemma 4 12B Q4 | mlx | all | 152.5 | 14.4 | 22.4 | 36.2 | 59.00 (18) | unknown (0) | 1332.2 (18) | 10.02/18.06 | 91.69/95.46 |
| Gemma 4 12B Q4 | mlx | core | 153.5 | 14.0 | 22.3 | 42.6 | 63.00 (11) | unknown (0) | 1341.5 (11) | 10.07/18.06 | 91.68/95.46 |
| Gemma 4 12B Q4 | mlx | productivity | 151.5 | 15.8 | 23.1 | 35.2 | 57.00 (7) | unknown (0) | 1222.0 (7) | 9.96/10.81 | 91.84/92.92 |
| Gemma 4 12B Q4 | llama-cpp | all | 103.8 | 10.5 | 16.1 | 30.4 | 84.12 (18) | 1101.7 (18) | unknown (0) | 18.81/28.44 | 92.30/107.55 |
| Gemma 4 12B Q4 | llama-cpp | core | 85.3 | 10.2 | 15.8 | 35.2 | 81.72 (11) | 1101.5 (11) | unknown (0) | 18.84/28.44 | 93.74/107.55 |
| Gemma 4 12B Q4 | llama-cpp | productivity | 122.2 | 13.3 | 16.8 | 25.8 | 85.05 (7) | 1101.8 (7) | unknown (0) | 18.78/24.56 | 90.66/103.65 |
| Qwen 3.8 27B Q4 | mlx | all | 126.0 | 21.3 | 25.6 | 77.0 | 34.00 (17) | unknown (0) | 604.8 (18) | 17.26/20.02 | 107.30/109.45 |
| Qwen 3.8 27B Q4 | mlx | core | 118.4 | 21.0 | 28.7 | 101.0 | 34.00 (11) | unknown (0) | 574.0 (11) | 17.21/20.02 | 107.05/109.02 |
| Qwen 3.8 27B Q4 | mlx | productivity | 133.7 | 21.5 | 22.6 | 55.6 | 34.00 (6) | unknown (0) | 743.0 (7) | 17.29/17.58 | 108.12/109.45 |
| Qwen 3.8 27B Q4 | llama-cpp | all | 156.8 | 19.1 | 27.3 | 71.0 | 35.66 (18) | 449.0 (18) | unknown (0) | 38.75/51.01 | 112.29/127.94 |
| Qwen 3.8 27B Q4 | llama-cpp | core | 114.1 | 18.6 | 26.7 | 68.1 | 35.85 (11) | 449.2 (11) | unknown (0) | 38.95/51.01 | 112.56/127.94 |
| Qwen 3.8 27B Q4 | llama-cpp | productivity | 172.2 | 27.2 | 27.9 | 84.9 | 33.73 (7) | 440.6 (7) | unknown (0) | 38.56/44.83 | 112.02/122.30 |

Gemma’s median recorded decode rate is 59.00 tok/s on MLX versus 84.12 on llama.cpp (70.1% as fast; approximately 30% lower), so this run does not reproduce a twofold decode gap. Qwen is 34.00 versus 35.66 tok/s (95.4%). These are descriptive integration comparisons, not isolated engine benchmarks or proof that a particular fix caused the change.

| Model | Paired metric, MLX / llama.cpp | Pairs | Median ratio |
|---|---|---:|---:|
| Gemma 4 12B Q4 | decodeTokensPerSecond | 18 | 0.684 |
| Gemma 4 12B Q4 | durationSeconds | 18 | 1.266 |
| Qwen 3.8 27B Q4 | decodeTokensPerSecond | 17 | 0.900 |
| Qwen 3.8 27B Q4 | durationSeconds | 18 | 1.071 |

MLX throughput is the median of active five-second pulse rates within each trial; llama.cpp throughput is decoded tokens divided by summed decode duration across requests. The cross-trial table then takes the median of those trial estimates. Short MLX requests can finish before any rate pulse; Qwen’s constrained-comms trial has unknown decode throughput, not its misleading 438.86 total-token/wall-time fallback. MLX observed prefill rates were recovered from 126 rounded first-token event descriptions across all 37 MLX records (121 observations in the 36 included trials). The separate MLX column is a median of within-trial medians: Qwen 604.75 tok/s and Gemma 1332.25 tok/s. These partial provider-turn samples are not comparable as a duration-weighted aggregate to the llama.cpp column. Exact MLX prefill durations, coverage of every internal request, and macOS GPU utilization remain unknown. See mlx-prefill-recovery.json for source hashes and individual observations.

RSS is sampled for the daemon process subtree, not isolated model allocation. System memory is whole-host used RAM, including other processes and unified-memory/cache effects; it must not be attributed entirely to the model or added to RSS. First-event latencies are measured from trial start and include startup/routing; they are not pure request TTFT.

## Token accounting and coverage

| Model | Engine | Reported input sum | Reported output sum | Completed speculative-request gen sum |
|---|---|---:|---:|---:|
| Gemma 4 12B Q4 | mlx | 929005 | 93878 | 104299 |
| Gemma 4 12B Q4 | llama-cpp | 575496 | 72752 | not applicable |
| Qwen 3.8 27B Q4 | mlx | 649355 | 159988 | 167322 |
| Qwen 3.8 27B Q4 | llama-cpp | 478990 | 94866 | not applicable |

Reported engine-log token counts are preserved as evidence, not treated as exact cross-engine totals. MLX uses pulse peaks/cache lines and misses tokens between the last pulse and completion. For example, constrained-comms records 6 output tokens while six completed speculative-request summaries report 599. Completed-request gen sums in performance-audit.json expose this loss, but cancelled/unlogged requests and prompt/cache accounting prevent claiming complete corrected totals. Raw provider API counts are included separately and may cover a different subset of turns.

All 73 trials have duration, first-token/tool/artifact, usage records, process RSS and system-memory records. Decode is available for 72/73; aggregate prefill for 36/73 (llama.cpp), plus recovered observed prefill for 37/73 (MLX), giving some prefill-rate evidence for all 73; GPU utilization for 0/73. Availability of a usage record does not establish accurate or comparable token totals.

## Advisory quality

All 25 produced declared artifacts were reviewed, including artifacts from failed trials and the excluded PowerPoint trial. There are no pending reviews, missing declared artifacts, or incompatible specifications; 48 trials have no declared judge rubric and remain ungraded. Reviews are source-based, capped at 20 KiB, and do not constitute a rendered visual review. Different rubrics are kept separate.

| Scenario / rubric | Model | Engine | Advisory mean /10 | Exact axes |
|---|---|---|---:|---|
| craftbook-spreadsheet-model | Gemma 4 12B Q4 | mlx | 4.50 | workflow fidelity: 5; usefulness: 4 |
| craftbook-spreadsheet-model | Gemma 4 12B Q4 | llama-cpp | 4.50 | workflow fidelity: 5; usefulness: 4 |
| craftbook-spreadsheet-model | Qwen 3.8 27B Q4 | mlx | 4.50 | workflow fidelity: 6; usefulness: 3 |
| craftbook-spreadsheet-model | Qwen 3.8 27B Q4 | llama-cpp | 5.50 | workflow fidelity: 6; usefulness: 5 |
| docblocks-theme-roundtrip | Gemma 4 12B Q4 | mlx | 5.67 | grounding: 6; candor: 6; usefulness: 5 |
| docblocks-theme-roundtrip | Gemma 4 12B Q4 | llama-cpp | 4.00 | grounding: 5; candor: 5; usefulness: 2 |
| docblocks-theme-roundtrip | Qwen 3.8 27B Q4 | mlx | 4.67 | grounding: 2; candor: 6; usefulness: 6 |
| docblocks-theme-roundtrip | Qwen 3.8 27B Q4 | llama-cpp | 4.00 | grounding: 4; candor: 4; usefulness: 4 |
| meeting-followup | Gemma 4 12B Q4 | mlx | 5.25 | decisionClarity: 5; grounding: 6; actionability: 4; brevity: 6 |
| meeting-followup | Gemma 4 12B Q4 | llama-cpp | 6.50 | decisionClarity: 6; grounding: 7; actionability: 6; brevity: 7 |
| meeting-followup | Qwen 3.8 27B Q4 | mlx | 6.75 | decisionClarity: 7; grounding: 6; actionability: 7; brevity: 7 |
| meeting-followup | Qwen 3.8 27B Q4 | llama-cpp | 6.75 | decisionClarity: 7; grounding: 6; actionability: 7; brevity: 7 |
| petshop | Gemma 4 12B Q4 | mlx | 4.00 | visualQuality: 5; functionalCompleteness: 4; codeQuality: 4; polish: 3 |
| petshop | Gemma 4 12B Q4 | llama-cpp | 4.75 | visualQuality: 6; functionalCompleteness: 4; codeQuality: 5; polish: 4 |
| petshop | Qwen 3.8 27B Q4 | mlx | 5.50 | visualQuality: 6; functionalCompleteness: 5; codeQuality: 6; polish: 5 |
| petshop | Qwen 3.8 27B Q4 | llama-cpp | 5.00 | visualQuality: 6; functionalCompleteness: 5; codeQuality: 5; polish: 4 |
| tankcombat | Gemma 4 12B Q4 | mlx | 3.25 | visualQuality: 4; functionalCompleteness: 4; codeQuality: 3; polish: 2 |
| tankcombat | Gemma 4 12B Q4 | llama-cpp | 4.25 | visualQuality: 5; functionalCompleteness: 5; codeQuality: 4; polish: 3 |
| tankcombat | Qwen 3.8 27B Q4 | mlx | 6.25 | visualQuality: 7; functionalCompleteness: 6; codeQuality: 5; polish: 7 |
| tankcombat | Qwen 3.8 27B Q4 | llama-cpp | 4.00 | visualQuality: 5; functionalCompleteness: 4; codeQuality: 4; polish: 3 |
| tictactoe | Gemma 4 12B Q4 | mlx | 4.50 | visualQuality: 5; functionalCompleteness: 5; codeQuality: 5; polish: 3 |
| tictactoe | Gemma 4 12B Q4 | llama-cpp | 4.50 | visualQuality: 5; functionalCompleteness: 5; codeQuality: 5; polish: 3 |
| tictactoe | Qwen 3.8 27B Q4 | mlx | 6.50 | visualQuality: 6; functionalCompleteness: 7; codeQuality: 7; polish: 6 |
| tictactoe | Qwen 3.8 27B Q4 | llama-cpp | 5.25 | visualQuality: 5; functionalCompleteness: 6; codeQuality: 6; polish: 4 |

The unpaired Gemma MLX PowerPoint review is retained in judging.md with source-acquisition 6, outline-parity 7, grounding 4, convertibility 6. Its seven-slide source follows the outline, but adds an unsupported automation-success narrative and loses the “median” qualifier. It is not included in the model/engine comparison. Several spreadsheet briefs meet deterministic gates while missing real model mechanics or containing arithmetic errors; fixed gate success and advisory usefulness answer different questions.

## Discordant failures

- **Qwen MLX, core petshop:** no required raster logo; it wrote SVG instead, made no image-generation call among 68 tools and exhausted four repairs. Saved HTML passed static checks, but runtime image assertions still failed. This is an image-tool/workflow failure, not evidence of a slower decoder causing failure.
- **Gemma MLX, core data-wrangle:** 60 output rows instead of 56 unique valid customers; four email duplicates remained, including an older Alice record. Malformed script filenames and no actual validation execution preceded direct JSON rewrites; four repairs did not resolve the duplicate condition.
- **Gemma MLX, core conflict-synthesis:** Marcus was correctly identified elsewhere but absent from the required Consolidated plan. The gate required section-local placement, and four repair turns failed to insert it there. This is a placement/repair issue; it is not an incorrect choice of authoritative owner.
- **Qwen MLX, productivity conflict-synthesis:** the final launch date, budget and DRI are correct. The gate rejects the report’s Compiled: 2026-11-03 metadata as an unsupported launch date and the source-supported phrase “led by Iris” as an unsupported DRI. The ownership regex matches every “led by” clause but only allows Marcus/Priya, even though org.md names Iris as campaign lead. This is a concrete gate false-positive. The original failure and 5.5 fixed score remain unchanged.

All four retain their recorded failure classes and scores. [Per-failure evidence](scorecard-details.json) includes exact facts, outputs and source paths; JSON diagnostics are also embedded in final-scorecard.json. No post-hoc score repair or exclusions were used to improve the observed gap.

A reusable next repair should scope conflict checks to claim roles, distinguish document metadata from launch dates, and accept source-backed non-DRI owners while still rejecting invented launch claims (evals/src/scenarios/conflict-synthesis.ts). For task handling, expose/run deterministic data validation before completion and make image role/tool availability explicit in packages/service/src/chat/role-tool-filter.ts. Evaluate each change on unrelated grounded-document, data-cleaning and media tasks; do not add scenario answers to model prompts or tune the anchors. No source or catalog tuning was performed during this run.

## Provenance, exclusions and historical context

Apple M5 Max, 128 GiB unified memory, Darwin 27.0.0. Native release 0.1.55; llama.cpp 0.8.0 build 11960, revision 8642541b255bfb5dc39cd351a178be09013a55d6, Metal. All 36 llama.cpp host records match; all MLX host records identify MLX, whose package versions are pinned by native-provenance.json and the external runtime guard (MLX 0.32.2, mlx-lm 0.31.3, mlx-vlm 0.7.1). Generalist remains auto.

Gilde remains 0.3.5. Gemma MLX used the verified assistant drafter candidate staged by convention; this is not an installed catalog release. Qwen used its own installed MLX drafter. Both MLX models logged assisted speculative requests, while llama.cpp used its separate MTP implementation (Qwen embedded head; Gemma external MTP GGUF). Engine-specific quantizations and drafter implementations are not byte-identical, so this measures the complete configured integrations.

The final Gemma MLX PowerPoint trial recorded a deterministic pass, but the post-trial identity check detected changes to bin/ab-strategy.ts, strategy/books.ts, strategy/engine-metrics.ts, strategy/summary.ts and types.ts in the eval fixture fingerprint. The observed identity differs only in fixtures; service/build/native/catalog identity groups matched. The driver stopped cleanly at its review boundary, preserved comparisonIssue and launched no next trial. The flag is retained despite the changes appearing unrelated to this scenario; the row is excluded and has no llama.cpp counterpart.

The original campaign journal still records 73/516 and its stop; it is not relabeled as a finished 516-trial study. The shortened reporting task is complete. There are 443 unrun cells, 111 unavailable original pairs per model, and no repetitions 2/3. The complete comparison has 72 unique included treatments, one repetition each, over 18 suite entries / 16 distinct scenarios per model. All original setup files retain their frozen hashes.

Historical native-0.1.54 results are comparison context only and are never pooled with this run. The three prior repetitions of the four discordant treatments are listed below; source/harness/build changes and reduced replication prevent causal attribution.

| Model | Suite / scenario | Engine | Historical passes / trials (0.1.54) | Fixed scores |
|---|---|---|---:|---|
| Qwen 3.8 27B Q4 | core / petshop | mlx | 1/3 | 2.2, 7.5, 2.2 |
| Qwen 3.8 27B Q4 | core / petshop | llama-cpp | 3/3 | 9.5, 7, 9.5 |
| Gemma 4 12B Q4 | core / data-wrangle | mlx | 1/3 | 4.1, 3.7, 10 |
| Gemma 4 12B Q4 | core / data-wrangle | llama-cpp | 3/3 | 10, 10, 10 |
| Gemma 4 12B Q4 | core / conflict-synthesis | mlx | 2/3 | 10, 5.6, 9.5 |
| Gemma 4 12B Q4 | core / conflict-synthesis | llama-cpp | 3/3 | 9, 10, 10 |
| Qwen 3.8 27B Q4 | productivity / conflict-synthesis | mlx | 2/3 | 5.5, 9, 9.5 |
| Qwen 3.8 27B Q4 | productivity / conflict-synthesis | llama-cpp | 2/3 | 9.5, 9.5, 5.3 |

As an unrelated check, all four current meeting-followup treatments passed and were judged. Their historical same-scenario results remain separately recorded in final-scorecard.json; this does not remove the observed data-cleaning/image/section-placement problems or prove broad regression freedom.

No further inference, commits or publication were performed for this closeout. The original analysis plan, raw trials, earlier reviews and older campaigns are preserved.


Publication note: portable copy of the completed, user-curtailed report. Archive-only links open scorecard-details.json, which embeds trial facts, postmortems and review specifications. Publication-status statements describe the original closeout.
