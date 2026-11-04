# Final M5 Max dual-engine scorecard — native 0.1.54

**Publication revision, November 3:** MLX first-token prefill rates have now been recovered from all 258 original MLX recordings. The [original report](original-report.md) and trial archive remain unchanged; the additions below are partial observations, separate from aggregate request timings.

**Complete: 516/516 planned trials, three repetitions for every treatment, and zero pending artifact reviews.** Qwen3.8 27B Q4 on llama.cpp recorded the most passes (104/129) and highest mean fixed score (8.26/10). Gemma4 12B Q4 on llama.cpp had the shortest median trial duration (3.89 minutes), with 86/128 eligible passes and one preserved infrastructure exclusion. MLX used substantially less sampled process RSS for both models.

These are comparisons of the installed model/engine configurations on this device. Their quantization formats and speculative decoding differ. Passing the frozen gates does not establish polished or fully correct work: the independent artifact reviews and failure investigations below expose material gaps in some passing outputs.

Execution: **2026-10-28T00:10:08.465Z → 2026-11-02T21:37:22.911Z**, UTC. Cumulative recorded trial time: **134.97 hours** (excludes between-trial setup and recovery gaps). Final supervisor state is `trials-complete`; the driver and inference processes exited. Read-only process inspection at 22:26 UTC found no campaign runner or local inference process. No pending execution needs restarting.

Primary records: [campaign.json](scorecard-details.json), [final-analysis.json](analysis.json), [judging.md](judging.md), [codex-inline-judge.json](judging.json), [final-failure-evidence.md](failure-evidence.md). The original runner's [report.md](runner-report.md) and [trials.csv](trials.csv) remain unchanged. This report is the reconciled comparison, including telemetry caveats and advisory findings.

## Scope, counting and scoring

The 43 suite/scenario entries are core 11, productivity 13, developer 10 and complex-work 9. There are 41 distinct scenario IDs; `plan-and-estimate` and `conflict-synthesis` intentionally occur in both core and productivity. Each suite membership keeps its own three repetitions. Four targets × 43 entries × three repetitions = **516 unique planned and recorded cells**, grouped into **172 treatments**, each containing exactly repetitions 1, 2 and 3. All 516 run directories are distinct, with result, facts, fixed score, host record and postmortem. No trial was replaced or retried.

There are **349 passes, 165 model-classified failures and two infrastructure-classified exclusions**. The eligible aggregate denominator is 514. All 516 count toward execution completion and all 516 remain in performance summaries. Exclusions are displayed explicitly; their original fixed scores and failed outcomes remain in the evidence. “Model” is the frozen accounting class, not a conclusion that the underlying cause is model capability.

The fixed `eval-run-fixed-v1` composite is the saved deterministic result: completion 40%, output quality 25%, process efficiency 20% and behavior 15%. Efficiency reflects the frozen budget/tool-use rules; throughput and memory are reported separately. No score was recomputed to accommodate later findings. The artifact judge is a separate 0–10 advisory assessment and never changes a fixed score or pass.

Each treatment has only three repetitions. Counts expose repeatability within this campaign; they do not justify precise population estimates or claims of statistical significance. Overall means give equal weight to each recorded eligible trial, so suites contribute according to their scenario counts. Hardware load, caching and chronology can affect timings even with rotating target order.

## Overall comparison

| Target (129 recorded each) | Passes / eligible | Excluded | Pass rate | Mean fixed /10 | Median all trials, min | Median passing trials, min |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen · MLX | 92/128 | 1 | 71.9% | 7.88 | 11.51 | 5.36 |
| Qwen · llama.cpp | 104/129 | 0 | 80.6% | 8.26 | 7.98 | 5.93 |
| Gemma · MLX | 67/129 | 0 | 51.9% | 7.19 | 8.36 | 3.89 |
| Gemma · llama.cpp | 86/128 | 1 | 67.2% | 7.85 | 3.89 | 2.37 |

Qwen on llama.cpp leads the recorded pass count in core, developer and complex-work. Gemma on llama.cpp leads productivity. Gemma on llama.cpp is strong on core (32/33) and productivity (33/39), but developer and complex-work remain substantially less reliable. Qwen MLX is close to Qwen llama.cpp on core and developer; its complex-work completion rate is lower. The successful simple probes—schema migration, symptom debugging, operations runbooks, records intake, meeting follow-up, spreadsheet modeling and interface contracts—show useful local execution under this frozen stack.

A shorter failed run is not automatically an advantage. Comparing only matching suite/scenario/repetition pairs where both engines passed: Qwen has 86 pairs with a median llama.cpp/MLX duration ratio of **0.988**; Gemma has 61 pairs with a ratio of **0.544** (about 46% shorter on llama.cpp). These paired observations still combine the engines' different installed formats, speculation and runtime behavior.

## Results by suite

| Suite | Target | Passes / eligible | Recorded | Excluded | Mean fixed /10 | Median duration, min |
| --- | --- | --- | --- | --- | --- | --- |
| core | Qwen · MLX | 31/33 | 33 | 0 | 9.25 | 2.19 |
| core | Qwen · llama.cpp | 33/33 | 33 | 0 | 9.56 | 3.26 |
| core | Gemma · MLX | 22/33 | 33 | 0 | 7.98 | 4.07 |
| core | Gemma · llama.cpp | 32/33 | 33 | 0 | 9.51 | 1.20 |
| productivity | Qwen · MLX | 29/39 | 39 | 0 | 8.12 | 6.89 |
| productivity | Qwen · llama.cpp | 32/39 | 39 | 0 | 8.45 | 6.68 |
| productivity | Gemma · MLX | 27/39 | 39 | 0 | 7.97 | 8.76 |
| productivity | Gemma · llama.cpp | 33/39 | 39 | 0 | 8.58 | 3.32 |
| developer | Qwen · MLX | 19/30 | 30 | 0 | 7.65 | 19.19 |
| developer | Qwen · llama.cpp | 20/30 | 30 | 0 | 7.74 | 16.38 |
| developer | Gemma · MLX | 12/30 | 30 | 0 | 6.91 | 11.62 |
| developer | Gemma · llama.cpp | 12/30 | 30 | 0 | 6.69 | 7.19 |
| complex-work | Qwen · MLX | 13/26 | 27 | 1 | 6.05 | 30.16 |
| complex-work | Qwen · llama.cpp | 19/27 | 27 | 0 | 6.97 | 26.57 |
| complex-work | Gemma · MLX | 6/27 | 27 | 0 | 5.42 | 15.16 |
| complex-work | Gemma · llama.cpp | 9/26 | 27 | 1 | 5.98 | 13.64 |

The repeated failure concentrations are more actionable than a single overall rank: theme round-trip, refactor-module and bug-fix-TDD each pass **0/12**; codemod-sweep, gate-script authoring and fanout authoring each pass **1/12**. Artifact existence often precedes correct task execution by a large margin. The final fanout trials illustrate this: all four store reports can exist without a reusable recipe or any child tasks.

## In-trial performance and coverage

Latency is measured from trial start. First-token latency includes daemon boot and queueing; it is not the first turn's engine-only TTFT. First action is the first observed tool call. First artifact is the first observed file/artifact write, which can be an intermediate file rather than the final deliverable. Missing observations remain **unknown**.

Decode rates use `metrics.derived.genTokensPerSec`, never the low-token preflight or whole-trial tokens/wall-time fallback. For llama.cpp, each trial rate is generated tokens divided by logged decode time; for MLX, each trial rate is the median of active-decode heartbeat rates. Tables take medians across trials, so these are different measurement estimators. The original structured MLX metrics lack aggregate prefill rates and exact prefill durations. Rounded first-token rate observations have since been recovered from the recordings; these partial provider-turn observations appear separately below. Engine-log token totals describe observed inference work and can include repeated/cache-related work; they are not unique user text or provider billing.

RSS is the sampled process-tree total (daemon plus descendants), reported in the collector's MB convention. Tables show the median of trial peaks and, separately, the largest observed peak. Shared mappings can affect RSS accounting. System RAM includes the entire host and other applications. These quantities are not interchangeable with model weights or GPU allocation. **macOS GPU utilization and dedicated GPU memory are unknown**, not zero; any zero GPU placeholders in raw reports must not be read as measurements.

| Target | First token, s | First action, s | First write, s (n) | Decode t/s (n) | Aggregate prefill t/s (n) |
| --- | --- | --- | --- | --- | --- |
| Qwen · MLX | 27.00 | 32.08 | 109.60 (121/129) | 28.00 (127/129) | unknown (0/129) |
| Qwen · llama.cpp | 31.48 | 38.71 | 129.29 (124/129) | 28.45 (129/129) | 396.66 (129/129) |
| Gemma · MLX | 17.50 | 32.60 | 57.21 (125/129) | 36.00 (129/129) | unknown (0/129) |
| Gemma · llama.cpp | 15.30 | 21.14 | 38.45 (124/129) | 71.76 (129/129) | 986.82 (129/129) |

| Target | Input tokens | Output tokens | RSS peak median / max, MB | System RAM peak median / max, MB | Sum trial hours |
| --- | --- | --- | --- | --- | --- |
| Qwen · MLX | 10,852,821 | 2,667,734 | 18,271 / 27,622 | 85,483 / 109,084 | 46.06 |
| Qwen · llama.cpp | 15,001,551 | 1,967,968 | 44,327 / 57,027 | 97,019 / 128,312 | 38.63 |
| Gemma · MLX | 15,351,921 | 2,181,928 | 10,975 / 19,215 | 68,586 / 131,028 | 29.01 |
| Gemma · llama.cpp | 17,342,384 | 2,016,283 | 25,416 / 33,829 | 76,306 / 105,916 | 21.27 |

Coverage across all 516 trials: duration, first token, first action, input/output token totals, process RSS and system RAM **516/516**; first artifact **494/516**; decode rate **514/516**; aggregate prefill **258/516** (every llama.cpp trial); recovered observed prefill **258/258 MLX trials** (2,175 partial observations); GPU utilization **0/516 available**. The two unavailable decode rates are Qwen MLX constrained-comms repetitions 1 and 3. Missing first-write observations include selection/authoring probes and the missing code-review artifact; absence of this timing does not always mean no final file exists. The completion audit lists each unknown cell. Total logged usage is **58,548,677 input and 8,833,913 output tokens**.

### Recovered MLX observed prefill

Median of observed rounded first-token prefill rates within each trial, then median across trials. Partial provider-turn coverage, not duration-weighted aggregate throughput or pure prefill time. All attempts are represented, including failures and the original infrastructure exclusion.

| Model | Suite | Trials | Observations | Observed prefill tok/s, median of trial medians |
| --- | --- | ---: | ---: | ---: |
| qwen3.8-27b-q4 | all | 129 | 793 | 547.00 |
| qwen3.8-27b-q4 | core | 33 | 84 | 564.00 |
| qwen3.8-27b-q4 | productivity | 39 | 213 | 574.00 |
| qwen3.8-27b-q4 | developer | 30 | 252 | 512.00 |
| qwen3.8-27b-q4 | complex-work | 27 | 244 | 495.00 |
| gemma4-12b-q4 | all | 129 | 1382 | 1084.00 |
| gemma4-12b-q4 | core | 33 | 194 | 1146.00 |
| gemma4-12b-q4 | productivity | 39 | 415 | 1146.00 |
| gemma4-12b-q4 | developer | 30 | 360 | 1052.50 |
| gemma4-12b-q4 | complex-work | 27 | 413 | 712.00 |


Exact MLX prefill durations and complete internal-request coverage remain unknown. These rates must not be directly ranked against llama.cpp aggregate prefill throughput. [Recovery method](mlx-prefill-recovery.md), [individual observations and source hashes](mlx-prefill-recovery.json), and [trial CSV](mlx-prefill-recovery.csv).

### Performance by target and suite

| Suite | Target | Decode t/s | Aggregate prefill t/s | RSS median peak, MB | System median peak, MB | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| core | Qwen · MLX | 33.00 | unknown | 18023 | 90170 | 797,041 | 208,657 |
| core | Qwen · llama.cpp | 32.09 | 422.30 | 40546 | 94032 | 1,069,773 | 151,614 |
| core | Gemma · MLX | 37.00 | unknown | 10685 | 73128 | 1,888,019 | 260,752 |
| core | Gemma · llama.cpp | 78.51 | 999.81 | 19403 | 74046 | 1,224,458 | 132,063 |
| productivity | Qwen · MLX | 29.00 | unknown | 18176 | 85483 | 3,265,635 | 678,704 |
| productivity | Qwen · llama.cpp | 29.53 | 406.81 | 43366 | 94510 | 3,007,152 | 508,812 |
| productivity | Gemma · MLX | 36.00 | unknown | 10888 | 68752 | 5,087,879 | 753,379 |
| productivity | Gemma · llama.cpp | 75.49 | 1039.96 | 25239 | 75976 | 3,993,335 | 592,620 |
| developer | Qwen · MLX | 25.00 | unknown | 18273 | 83417 | 3,707,702 | 716,839 |
| developer | Qwen · llama.cpp | 27.18 | 395.62 | 44292 | 92916 | 4,163,359 | 682,774 |
| developer | Gemma · MLX | 37.50 | unknown | 11180 | 66653 | 5,997,799 | 578,876 |
| developer | Gemma · llama.cpp | 64.20 | 873.75 | 26218 | 73264 | 8,192,565 | 630,065 |
| complex-work | Qwen · MLX | 21.00 | unknown | 19093 | 85934 | 3,082,443 | 1,063,534 |
| complex-work | Qwen · llama.cpp | 23.82 | 354.57 | 49449 | 105168 | 6,761,267 | 624,768 |
| complex-work | Gemma · MLX | 36.00 | unknown | 11284 | 68776 | 2,378,224 | 588,921 |
| complex-work | Gemma · llama.cpp | 59.35 | 923.57 | 27947 | 83499 | 3,932,026 | 661,535 |

| Suite | Target | First token, s | First action, s | First write, s | First-write coverage | Decode coverage | Aggregate prefill coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| core | Qwen · MLX | 22.87 | 28.26 | 75.24 | 33/33 | 33/33 | 0/33 |
| core | Qwen · llama.cpp | 21.09 | 29.33 | 72.44 | 33/33 | 33/33 | 33/33 |
| core | Gemma · MLX | 14.17 | 27.65 | 60.89 | 33/33 | 33/33 | 0/33 |
| core | Gemma · llama.cpp | 11.13 | 17.03 | 37.98 | 33/33 | 33/33 | 33/33 |
| productivity | Qwen · MLX | 25.93 | 31.07 | 78.20 | 39/39 | 37/39 | 0/39 |
| productivity | Qwen · llama.cpp | 31.26 | 38.70 | 90.97 | 39/39 | 39/39 | 39/39 |
| productivity | Gemma · MLX | 17.59 | 32.86 | 46.60 | 39/39 | 39/39 | 0/39 |
| productivity | Gemma · llama.cpp | 15.50 | 23.46 | 30.19 | 39/39 | 39/39 | 39/39 |
| developer | Qwen · MLX | 25.80 | 37.51 | 195.52 | 28/30 | 30/30 | 0/30 |
| developer | Qwen · llama.cpp | 29.92 | 38.88 | 134.41 | 28/30 | 30/30 | 30/30 |
| developer | Gemma · MLX | 18.71 | 25.61 | 62.84 | 29/30 | 30/30 | 0/30 |
| developer | Gemma · llama.cpp | 16.59 | 20.79 | 38.12 | 28/30 | 30/30 | 30/30 |
| complex-work | Qwen · MLX | 31.65 | 49.74 | 966.49 | 21/27 | 27/27 | 0/27 |
| complex-work | Qwen · llama.cpp | 47.08 | 55.55 | 757.47 | 24/27 | 27/27 | 27/27 |
| complex-work | Gemma · MLX | 20.83 | 41.29 | 213.92 | 24/27 | 27/27 | 0/27 |
| complex-work | Gemma · llama.cpp | 18.73 | 25.33 | 110.17 | 24/27 | 27/27 | 27/27 |

## Advisory artifact quality

All **228 applicable trial slots** are reconciled: **215 numeric reviews**, **12 judgeSpecMismatch** (every A/B readout) and **one noArtifact** (Gemma llama.cpp code-review repetition 3). The remaining **288 trials are notApplicable** and remain ungraded. Numeric reviews include **80 trials that failed their deterministic gate**. No external judge or subagent was invoked.

Reviews used each packet's exact scenario prompt and axis descriptions, integer 0–10 scores, the frozen rubric (5 for merely delivering the brief; 9–10 reserved for polished work), a specific justification of at most 400 characters and a review timestamp. The anchors use the default HTML axes. These are source-based reviews of the first **20 KiB** of the declared artifact, not a claim of full visual or end-to-end testing. Two petshop packets were capped: Qwen llama.cpp repetition 2 and Qwen MLX repetition 3. All packet bytes were reconciled against their source artifact; review hashes are saved in final-analysis.json.

A/B readout declares mock-service safety/mapping/signals/containment axes that do not describe its statistical report. Each mismatch has an explicit saved justification; no substitute numerical grade was invented. Four early find-vs-create packets remain preserved without scores after its scope was correctly recognized as non-judgeable.

The table below averages the declared axes within a scenario, then across the target's reviewed repetitions. These scenario rubrics measure different things, so there is deliberately **no pooled overall advisory rank**. Every entry has n=3 except Gemma llama.cpp code-review (n=2); the absent third report has no grade. Exact per-axis scores, justifications and artifact paths are in judging.md and codex-inline-judge.json.

| Suite / scenario | Qwen · MLX /10 | Qwen · llama.cpp /10 | Gemma · MLX /10 | Gemma · llama.cpp /10 |
| --- | --- | --- | --- | --- |
| core/tictactoe | 6.08 | 5.92 | 4.08 | 4.83 |
| core/petshop | 4.42 | 5.25 | 3.67 | 4.50 |
| core/tankcombat | 5.33 | 4.67 | 2.50 | 3.42 |
| productivity/meeting-followup | 7.17 | 7.25 | 5.00 | 6.58 |
| productivity/craftbook-spreadsheet-model | 5.33 | 6.67 | 4.50 | 4.83 |
| productivity/docblocks-theme-roundtrip | 5.89 | 7.00 | 3.11 | 4.33 |
| productivity/craftbook-powerpoint-deck | 7.25 | 7.17 | 7.17 | 7.00 |
| productivity/wikipedia-research-brief | 3.25 | 6.58 | 3.58 | 3.33 |
| productivity/craftbook-week-plan | 2.83 | 1.75 | 0.67 | 0.92 |
| productivity/craftbook-annotated-bibliography | 6.25 | 6.50 | 5.58 | 6.08 |
| productivity/craftbook-research-to-document | 7.00 | 6.56 | 6.67 | 6.89 |
| developer/craftbook-code-review | 7.50 | 7.17 | 5.50 | 5.75 (n=2) |
| developer/craftbook-api-contract-review | 6.50 | 6.17 | 3.17 | 4.00 |
| developer/craftbook-deep-security-review | 7.22 | 7.33 | 3.89 | 4.33 |
| developer/craftbook-codemod-sweep | 7.00 | 6.67 | 3.78 | 4.56 |
| developer/craftbook-refactor-module | 4.11 | 4.78 | 1.78 | 1.56 |
| developer/craftbook-bug-fix-tdd | 4.33 | 2.22 | 3.11 | 3.89 |
| complex-work/craftbook-invoice-run | 5.87 | 6.40 | 4.93 | 5.00 |

The largest gaps between fixed acceptance and advisory quality are practical: tankcombat passes all 12 gates while several saved games have broken firing, scoring or collision-reset behavior; week-plan passes 5/12 despite poor grounding; invoices can look finished while bookkeeping or payee details are wrong. Meeting follow-up and document deliverables generally have stronger reviewed content. A strong score on a theme blocker report still does not mean the requested theme conversion happened.

## Concrete failure diagnoses and implications

The frozen failure modes are 153 `model-stuck`, nine `chat-stalled`, four `timeout` and one `success-check-false`. These labels explain termination, not all causes. The detailed evidence register contains every failed trial and the 23 previously reported incidents. The following clusters distinguish observations from proposed future work; no fix was applied to this campaign.

**Tool access and repair authority.** Theme round-trip fails 12/12 with required DocBlocks tools unavailable. Qwen MLX research encountered registered Wikipedia tools removed by immediate-write/file-repair restrictions. Gemma MLX tic-tac-toe repetition 3 had a real `NodeList.some` defect; isolated candidate replays passed behavior probes, but the overwrite guard rejected the shorter repair and the recovery surface omitted the patch tool its feedback requested. These are tool/repair integration findings, not reasons to increase model size. See [final-failure-evidence.md](failure-evidence.md) and the affected trial postmortems.

**Completion and verdict gates can accept incomplete work.** Author-linear repetition 2 accepted a manually completed task before any gated step ran; a later report remained below the unused recipe gate's size floor. API-contract-review accepted `UNMET` because the gate recognized only literal `FAIL`. Invoice verdict normalization collapsed line boundaries and hid an otherwise matching FAIL. Fanout repetition 1 selected an earlier completed root despite four children under a later invocation; only one child completed, so the result still cannot be counted as successful. These findings call for execution receipts, structured criterion results and explicit invocation identity. Evidence: [invoice-verdict-normalization-r3-replay.json](scorecard-details.json) and the incident register.

**Grounding and cross-file consistency.** Week-plan's gate could accept calendar retrieval that happened after the final report, leaving the plan ungrounded. A passed invoice run left the ledger and billable entries unchanged; other invoices invented fees, addresses or the wrong payee. A/B repetition 2 repaired stats after writing its readout, producing an internally stale report; repetition 3 passed with p=0.000513 rather than the independently checked pooled-test p=0.007785. The frozen A/B gate checks the significance flag but not the p-value or confidence interval. The same task also contains an exact-schema/required-interval conflict and an unsuitable advisory rubric. These are report dependency and contract defects; the 8/12 fixed passes are preserved, not endorsed as fully correct statistics.

**Authoring must validate executable contracts.** Two author-params trials left `workPath` undefined and stopped the campaign; their infrastructure exclusions are preserved below. Qwen MLX author-linear repetition 3 saved the invalid JavaScript pattern `(?i)\bPASS\b`; repeatedly editing a correct report cannot fix a gate that does not compile. Qwen llama.cpp gate-script repetition 3 supplied a checks array to `gateResult(boolean, detail)`; controlled calls to the frozen SDK show a failed-check array is truthy and approves. That generated gate never ran in the trial, so this is a latent contract defect, not an observed erroneous approval. Evidence: [author-linear-invalid-gate-pattern-r3-replay.json](scorecard-details.json), [gate-result-array-contract-r3-replay.json](scorecard-details.json).

**Timeouts and feedback must account for active work.** Qwen llama.cpp gate-script repetition 1 waited 1,030 seconds for inference admission and had a 126,038-token prefill take 571 seconds; the watchdog ended it while inference was active. Qwen MLX petshop repetition 3 invoked genuine image generation, but the HTML repair limit terminated the trial while SDXL sampling was still active; decode continued during shutdown and no PNG was captured. These observations do not license unbounded waiting. A future bounded policy should distinguish queued, prefill, decoding and pending-tool work from repeated ineffective repairs. See [r1-qwen-llamacpp-complex-work-craftbook-author-gate-script](scorecard-details.json) and [r3-qwen-mlx-core-petshop](scorecard-details.json).

**Artifact/type and note contracts need consistent enforcement.** Gemma MLX PowerPoint repetition 3 copied a 335-byte JSON artifact to a `.pptx` destination after failing to save a real converted deck; the gate correctly rejected it, while the copy API allowed the misleading type. Gemma llama.cpp code-review repetition 3 supplied both short `note` and detailed `content` aliases; `text ?? note ?? content` kept the short text, causing six missing-Scope rejections and no report. Canonical arguments and the same binary checks across write and copy paths would address reusable interface failure modes.

**Fanout delivery is distinct from reusable workflow execution.** The last Qwen llama.cpp run created a linear recipe with no spawn step and no children; its report gate anchored `^` without multiline matching, rejecting an otherwise present list. The last Gemma MLX run wrote direct reports and a workspace JSON recipe that was never registered. The last Gemma llama.cpp run had five rejected template writes and completed only the read step of an ad hoc task. Each had all four store reports, yet the requested reusable fanout was absent. Their recorded scores are 5.1, 5.4 and 5.4, respectively. See [r3-qwen-llamacpp-complex-work-craftbook-author-fanout](scorecard-details.json), [r3-gemma-mlx-complex-work-craftbook-author-fanout](scorecard-details.json) and [r3-gemma-llamacpp-complex-work-craftbook-author-fanout](scorecard-details.json). The full repeated matrix below prevents a single late failure from being mistaken for the whole campaign.

## Preserved infrastructure exclusions and safe recoveries

Both exclusions are failed author-params trials with generated unresolved gate parameters. The diagnosis points to isolated recipe state, but the frozen classifier recorded infrastructure/gate-unevaluable. That original classification, fixed score and denominator exclusion remain intact. Neither trial was rerun. After each stop, ownership/orphan checks and the full identity comparison passed; the stopped state was archived and only the reviewed stop marker acknowledged before the same supervisor continued with the next pending cell.

| Cell | Fixed /10 (excluded) | Evidence |
| --- | --- | --- |
| r1-gemma-llamacpp-complex-work-craftbook-author-params | 5.5 | [postmortem](scorecard-details.json) |
| r3-qwen-mlx-complex-work-craftbook-author-params | 4.6 | [postmortem](scorecard-details.json) |

Recovery records: [October 29 recovery](scorecard-details.json) and [November 2 recovery](scorecard-details.json). Final [final-identity.json](scorecard-details.json) reports no identity changes, matching definition/cells and 516 unique records. Earlier campaigns and their monitors were not used in these aggregates.

## Frozen platform and engine differences

Apple M5 Max, 128 GB unified RAM, darwin 27.0.0 arm64. Native release **0.1.54** archives passed SHA256SUMS verification before execution; the final supervision audit rechecked all 24 native files and all 516 per-trial host records with no mismatch. llama.cpp is **0.7.0, build 11669, revision 620d2225cc436ab0b001e3200e590e3b286ef9ab, Metal**. MLX packages are **mlx 0.32.2, mlx-lm 0.31.3, mlx-vlm 0.7.1, transformers 5.14.1 and torch 2.13.0**.

| Installed configuration | Quantization and speculation |
| --- | --- |
| Qwen3.8 27B Q4 · MLX | 4-bit affine, group 64; installed MTP drafter. Some observed turns fall back when the grammar contract is incompatible, so not every turn is assisted. |
| Qwen3.8 27B Q4 · llama.cpp | `Qwen3.8-27B-UD-Q4_K_M.gguf`, F16 projection; MTP drafting, 262,144 context, f16 KV, one parallel slot in observed launches. |
| Gemma4 12B Q4 · MLX | MXFP4, group 32; fp16 tied embedding/multimodal pass-through; no MTP draft in observed launches. |
| Gemma4 12B Q4 · llama.cpp | `gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` with external `mtp-gemma-4-12B-it-Q4_0.gguf`. |

The shared “Q4” names do not mean byte-identical weights. Speculative decoding gains cannot be isolated from these data. Petshop additionally uses the installed `sdxl-lightning-4step` image model and pinned native image engine. Normal `generalist=auto`, strict count, required runtime assertions, performance collection, prompts, gates and timeouts were retained. One local inference trial ran at a time.

Model sources stayed read-only under `<home>/.gezel-dev`; llama.cpp used the unchanged `GEZEL_EVAL_MODEL_ROOTS={"llama-cpp":["<home>/.gezel-eval-cache/engines/llama-cpp/models"]}` overlay. The frozen model identity compares large weight files by size/mtime and small metadata by content hash; this is not a claim that every large weight was rehashed at completion.

| Identity | Frozen value |
| --- | --- |
| Source HEAD | 22fec99111a5ad9796af83a4a1a222236be91006 |
| source SHA256 | 10a41de112c12aa33f12715ea0e1f30666cce2a8bf657064944820ed9f92b2e4 |
| service SHA256 | 8ebac526c31a924d22604d904150506abb8968890a36292b5141f5758e18cdc8 |
| runtime SHA256 | 1d9709b06a0083335573d6f350d7d3fb892f8bba21e72348c8f8c27e3e3af661 |
| gilde SHA256 | 86479933383e9ff888d11a871ffaca09ad295b56150ec58a6e243787227f9995 |
| Gilde version | 0.3.1 |

Full native and model evidence: [native-provenance.json](native-provenance.json), [campaign.json](scorecard-details.json), [final-identity.json](scorecard-details.json) and each trial's host/daemon records. All 29 successful anchor trials have positive runtime assertion counts, zero runtime failures and matching runtime log evidence. The other seven anchor trials remain failures; limited frozen assertions do not cover every gameplay behavior identified in advisory review.

## Per-scenario repeated results

Each cell shows **passes / eligible · mean fixed score**. Three trials were recorded for every cell; † marks an infrastructure exclusion, reducing its eligible denominator to two. Scores include eligible failures. This table preserves suite membership and shows all 172 treatments.

### core

| Scenario | Qwen · MLX | Qwen · llama.cpp | Gemma · MLX | Gemma · llama.cpp |
| --- | --- | --- | --- | --- |
| tictactoe | 3/3 · 9.83 | 3/3 · 9.20 | 2/3 · 8.50 | 3/3 · 10.00 |
| petshop | 1/3 · 3.97 | 3/3 · 8.67 | 0/3 · 1.70 | 2/3 · 5.73 |
| tankcombat | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 |
| schema-migration | 3/3 · 9.33 | 3/3 · 9.50 | 3/3 · 9.17 | 3/3 · 9.67 |
| failing-tests-spec | 3/3 · 10.00 | 3/3 · 10.00 | 0/3 · 6.10 | 3/3 · 10.00 |
| symptom-debug | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 |
| data-wrangle | 3/3 · 9.67 | 3/3 · 9.50 | 1/3 · 5.93 | 3/3 · 10.00 |
| incident-postmortem | 3/3 · 9.67 | 3/3 · 9.67 | 2/3 · 8.70 | 3/3 · 10.00 |
| ops-runbook-anomaly | 3/3 · 10.00 | 3/3 · 9.50 | 3/3 · 9.33 | 3/3 · 9.50 |
| plan-and-estimate | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 |
| conflict-synthesis | 3/3 · 9.33 | 3/3 · 9.17 | 2/3 · 8.37 | 3/3 · 9.67 |

### productivity

| Scenario | Qwen · MLX | Qwen · llama.cpp | Gemma · MLX | Gemma · llama.cpp |
| --- | --- | --- | --- | --- |
| constrained-comms | 2/3 · 8.67 | 2/3 · 8.67 | 3/3 · 10.00 | 3/3 · 10.00 |
| records-intake | 3/3 · 10.00 | 3/3 · 9.83 | 3/3 · 10.00 | 3/3 · 10.00 |
| plan-and-estimate | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 |
| meeting-followup | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 9.83 | 3/3 · 10.00 |
| craftbook-spreadsheet-model | 3/3 · 8.67 | 3/3 · 9.50 | 3/3 · 8.83 | 3/3 · 9.33 |
| conflict-synthesis | 2/3 · 8.00 | 2/3 · 8.10 | 3/3 · 9.67 | 3/3 · 9.33 |
| docblocks-theme-roundtrip | 0/3 · 5.57 | 0/3 · 5.73 | 0/3 · 5.90 | 0/3 · 5.80 |
| craftbook-powerpoint-deck | 3/3 · 8.50 | 3/3 · 8.67 | 1/3 · 5.67 | 3/3 · 8.50 |
| wikipedia-research-brief | 0/3 · 6.33 | 3/3 · 10.00 | 0/3 · 5.17 | 3/3 · 9.50 |
| craftbook-week-plan | 1/3 · 3.53 | 1/3 · 3.37 | 0/3 · 4.03 | 3/3 · 8.50 |
| craftbook-ab-test-readout | 3/3 · 8.33 | 3/3 · 8.00 | 2/3 · 7.23 | 0/3 · 2.57 |
| craftbook-annotated-bibliography | 3/3 · 9.50 | 3/3 · 9.50 | 3/3 · 8.83 | 3/3 · 9.50 |
| craftbook-research-to-document | 3/3 · 8.50 | 3/3 · 8.50 | 3/3 · 8.50 | 3/3 · 8.50 |

### developer

| Scenario | Qwen · MLX | Qwen · llama.cpp | Gemma · MLX | Gemma · llama.cpp |
| --- | --- | --- | --- | --- |
| fix-squisq-bugs | 2/3 · 8.40 | 3/3 · 9.33 | 3/3 · 9.50 | 3/3 · 9.67 |
| dev-craftbook-routing | 2/3 · 6.83 | 2/3 · 7.37 | 0/3 · 5.33 | 1/3 · 5.93 |
| interface-contract | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 | 3/3 · 10.00 |
| craftbook-code-review | 3/3 · 9.83 | 3/3 · 9.67 | 3/3 · 10.00 | 2/3 · 7.17 |
| craftbook-api-contract-review | 3/3 · 8.67 | 3/3 · 9.00 | 3/3 · 9.00 | 3/3 · 8.83 |
| craftbook-deep-security-review | 2/3 · 7.83 | 3/3 · 9.17 | 0/3 · 6.07 | 0/3 · 6.13 |
| large-pr-review | 3/3 · 8.50 | 3/3 · 8.50 | 0/3 · 3.13 | 0/3 · 3.13 |
| craftbook-codemod-sweep | 1/3 · 5.87 | 0/3 · 5.17 | 0/3 · 5.53 | 0/3 · 5.53 |
| craftbook-refactor-module | 0/3 · 5.60 | 0/3 · 5.10 | 0/3 · 5.10 | 0/3 · 5.07 |
| craftbook-bug-fix-tdd | 0/3 · 4.97 | 0/3 · 4.13 | 0/3 · 5.43 | 0/3 · 5.47 |

### complex-work

| Scenario | Qwen · MLX | Qwen · llama.cpp | Gemma · MLX | Gemma · llama.cpp |
| --- | --- | --- | --- | --- |
| craftbook-find-vs-create | 2/3 · 7.37 | 2/3 · 6.70 | 2/3 · 7.70 | 1/3 · 6.27 |
| craftbook-edit-midtask | 3/3 · 8.50 | 3/3 · 8.33 | 2/3 · 7.37 | 2/3 · 7.27 |
| craftbook-invoice-run | 2/3 · 7.50 | 2/3 · 7.50 | 1/3 · 6.50 | 3/3 · 9.00 |
| craftbook-author-linear | 2/3 · 6.80 | 2/3 · 6.47 | 0/3 · 4.03 | 1/3 · 6.03 |
| craftbook-route-multi | 1/3 · 6.00 | 3/3 · 8.50 | 1/3 · 6.67 | 1/3 · 6.17 |
| craftbook-export-generalize | 1/3 · 4.27 | 3/3 · 7.87 | 0/3 · 3.47 | 1/3 · 4.93 |
| craftbook-author-params | 1/2† · 6.20 | 3/3 · 8.50 | 0/3 · 4.73 | 0/2† · 4.60 |
| craftbook-author-gate-script | 0/3 · 3.37 | 1/3 · 4.80 | 0/3 · 4.63 | 0/3 · 4.70 |
| craftbook-author-fanout | 1/3 · 4.47 | 0/3 · 4.10 | 0/3 · 3.67 | 0/3 · 4.37 |

## Next experiments, outside this frozen campaign

These are proposed changes, not validated fixes or authorization to alter this baseline. Prioritize reusable correctness and orchestration changes before sampling changes. The logs do not justify a particular new temperature or token limit for either family.

| Priority | Concrete change to evaluate | Evidence and validation |
| --- | --- | --- |
| 1 | Require complete structured criterion results and step/gate execution receipts before terminal task completion; reject contradictory aliases instead of silently choosing one. | Manual completion bypass, PASS+UNMET, normalized FAIL and note/content collision. Exercise review, invoice and authored workflows with an unrelated document task. |
| 1 | Validate regex compilation, parameter resolution and SDK argument types at authoring; make gateResult reject non-boolean input. | Invalid inline regex flag, undefined workPath and truthy check array. Validate both failing and passing controls before a diverse authoring sweep. |
| 1 | Reconcile prerequisite tools with repair surfaces; keep bounded access to required search, image, document and patch operations. | Missing DocBlocks/Wikipedia tools and repair feedback/tool disagreement. Check research, image and code repair together. |
| 2 | Track dependency hashes/provenance from retrieval and stats to the final document, and validate bookkeeping transitions. | Calendar read after report, stale A/B narrative and unchanged invoice ledger. Check both consistency and actual numeric values. |
| 2 | Use bounded watchdog states for admission queue, active prefill/decode and pending tools; preserve a maximum trial budget. | Observed verifier starvation and image termination during sampling. Measure completion and resource use across image and gate-script tasks. |
| 2 | Validate artifact type on copy and enforce explicit fanout invocation/root/child receipts. | JSON renamed as PPTX, wrong root selection and reports without child execution. Check binary export plus an unrelated batch workflow. |

Implementation owners to inspect in a future unfrozen branch: [packages/mcp/src/server.ts](scorecard-details.json) (tool aliases, copies, authoring and terminal status), [packages/mcp/src/normalize.ts](scorecard-details.json) (Markdown boundaries), [packages/service/src/tasks/gate-eval.ts](scorecard-details.json) and [packages/service/src/tasks/runner.ts](scorecard-details.json) (gates/receipts), [packages/sdk/src/checks.ts](scorecard-details.json) (gateResult), [packages/service/src/chat/session-tool-surface.ts](scorecard-details.json) and [packages/service/src/tasks/gate-escalation.ts](scorecard-details.json) (repair authority), [evals/src/craftbooks/authoring/author-fanout.ts](scorecard-details.json) (root/child acceptance), and the frozen Gilde craftbook/test specifications named in trial evidence. Reconcile A/B prompt/schema/acceptance/judge contracts together before interpreting another sweep. Do not add scenario-specific strings, expected selectors or output recipes to model profiles.

The comparison to prior evidence here uses repetitions 1–3 of this same frozen build. No older paused campaign or different native build contributes scores or timings. Any future modified-stack experiment requires separate provenance and broad regression evidence before claiming improvement.

## Completion audit and reproducibility

[final-analysis.py](scorecard-details.json) reconciles all planned cell IDs, repetitions, run directories, row/result/facts/fixed-score agreement, judging applicability, exact axis sets, integer score ranges, justification limits, source packet bytes, review hashes and anchor runtime evidence. [final-analysis.json](analysis.json) contains exact aggregate data, all treatment rows, axis means, exclusions and matched successful timing pairs. [final-failure-evidence.md](failure-evidence.md) links all 167 failed trials and preserves the previously reported incident details. [completion-audit.json](completion-audit.json) records final hashes and completion checks.

No source, dependency, catalog, model, prompt, timeout, gate, recorded outcome or fixed score was changed to obtain completion. All failed and partial evidence remains available. No results were committed or published. The heartbeat lifecycle and final completion checks are recorded in completion-audit.json.


Publication note: this is a portable copy of the completed campaign report. Individual trial evidence links open scorecard-details.json, which embeds all postmortems and retains original archive references. Statements about publication status describe the original completion checkpoint.
