Publication review supplement: the advisory judgments in the original report below are Codex's. The independent [Sonnet 5.5 summary](sonnet-review-summary.md) supplies the publication's rubric-specific quality measurements; [all Sonnet reviews](judging-sonnet-5-5.json) and [trial evidence](scorecard-details.json) retain the details. Fixed scores are unchanged. Individual local evidence links open the evidence companion.

# Final evaluation report — Saluki / native 0.1.57

**Evidence closed 11 November 2026. The report is complete; the requested three-trial campaign is incomplete.**

Saluki runs and executes diverse tasks on this 12 GB GPU machine using substantial CPU offload. It recorded **98 passes among 125 eligible trials (78.4%)**, with an **8.09/10 mean fixed composite**. Core tasks were the strongest group. Productivity and developer outcomes were uneven, and complex workflows showed expensive repair loops and gaps between a passing gate and a correct deliverable. These results do not establish dependable unattended execution or full GPU residency.

The original native 0.1.57 installation was verified across **62 files**, and the model weight SHA-256 was checked. No further model download or tuning change was made. [Installation verification](scorecard-details.json).

## What finished, and what did not

The plan was 43 suite entries × 3 trials = 129 cells across core, productivity, developer and complex-work. There are 41 distinct scenarios because plan-and-estimate and conflict-synthesis appear in two suites.

| Disposition | Cells | Included in pass rate? |
|---|---:|---|
| Runner pass | 98 | Yes |
| Eligible runner task failure | 27 | Yes |
| Runner infrastructure exclusion | 1 | No |
| Interrupted, no runner score | 2 | No |
| Never attempted | 1 | No |
| **Planned** | **129** | **125 eligible** |

The original campaign stopped after 85 terminal trials: 71 passes, 13 eligible failures and one sandbox-unavailable exclusion on R2 gate-script. Its stopped journal and fixed rows remain sealed. The separate R2 fanout attempt ended on 6 November without a result. The user reported a possible battery outage; that cause was not confirmed. Its four accurate reports and one sequential task do not demonstrate successful fanout. [Original stopped assessment](scorecard-details.json); [R2 interruption](scorecard-details.json).

The recovered R3 scorecard produced **41/43 terminal results**, then stopped during gate-script. Its last native event was **11 November 02:25:34 UTC**. A host-level process inspection at approximately 14:27 UTC found no campaign launcher, eval process or llama server. No final result, facts, score, metrics or wrapper exit record exists for that attempt. Its inventory report is accurate (10 items, 583 units, value 7385.60), but its task remains paused and the saved custom gate retains illegal top-level returns. This is an **unscored interruption**, not an invented model failure. R3 fanout was never started. Ten surviving source/report/task/template files were copied and hash-verified. [R3 interruption evidence](scorecard-details.json); [Partial-work postmortem](scorecard-details.json).

All **128 attempted cells** now have final advisory reviews/dispositions, with no provisional entries. **41/43 suite entries have three eligible trials; gate-script and fanout each have only one.** Runner status files retain their original stopped/stale-running values; administrative dispositions live separately. No one-shot launcher was rerun, no capability failure retried, and no fixed score synthesized.

## Fixed scorecard

| Suite | Pass / eligible | Pass rate | Mean fixed score | Planned |
|---|---:|---:|---:|---:|
| Core | 30/33 | 90.9% | 8.85/10 | 33 |
| Productivity | 28/39 | 71.8% | 7.97/10 | 39 |
| Developer | 22/30 | 73.3% | 7.82/10 | 30 |
| Complex work | 18/23 | 78.3% | 7.58/10 | 27 |
| **Total** | **98/125** | **78.4%** | **8.09/10** | **129** |

These are descriptive aggregates over eligible trials. Pass rate is based on the runner's success field, not a composite-score threshold. The frozen rubric weights completion 40%, output quality 25%, efficiency 20% and behavior 15%; performance is reported separately. Per-trial composites were already rounded by the runner before averaging.

| Suite | Original passes / eligible | Original mean | Continuation R3 passes / eligible | R3 mean |
|---|---:|---:|---:|---:|
| Core | 19/22 | 8.52 | 11/11 | 9.50 |
| Productivity | 20/26 | 8.18 | 8/13 | 7.55 |
| Developer | 19/20 | 8.85 | 3/10 | 5.76 |
| Complex work | 13/16 | 7.69 | 5/7 | 7.33 |
| **Total** | **71/84** | **8.33** | **27/41** | **7.60** |

The original and continuation are **separate frozen baselines**. The sole comparison-identity change is `GEZEL_MXC_EXEC=<home>/.gezel-dev/engines/mxc/1.0.0/wxc-exec.exe`, using the existing Microsoft-signed executable with SHA-256 `8a6d1db4dd1846981127d9014741be18b094d07be967765dff6754bda1d40259`. The recovery verified the remaining frozen components matched. The original 85 trials and continuation fixed rows have not been merged or overwritten. The interruption attempts remain outside both numeric score sets. [Identity boundary](scorecard-details.json).

The developer drop from **19/20 original passes to 3/10 in R3** is material. Core improved from 19/22 to 11/11. These movements are descriptive: different repetitions, environment boundary, long-run speed variation and small samples prevent attributing them to the native release or the launcher repair.

[Full 43-entry, three-column scorecard](scorecard-details.json) includes every fixed score, exclusion and missing trial, with postmortem links. [Machine-readable scorecard](scorecard-details.json) retains cell IDs and baseline identity.

## Does it fit in 12 GB?

**It fits as a hybrid GPU/CPU workload on this machine. Full GPU residency was not demonstrated.**

| Measurement | Observed evidence |
|---|---|
| GPU | NVIDIA GeForce RTX 5070 Ti Laptop, 12,227 MiB |
| Actual task context | 65,536 tokens, one slot, f16 KV |
| Dense FFN placement | 39 of 64 layers on GPU; 25 on CPU (`--n-cpu-ffn 25`) |
| Peak sampled GPU memory | 10,654 MiB / 12,227 MiB (about 10.40 / 11.94 GiB) |
| Peak sampled process RSS | 17,260 MiB (16.86 GiB) |
| Peak sampled whole-system RAM | 31,721 / 31,865 MiB (99.5%) |
| Explicit CUDA OOM / context overflow | None found in reviewed evidence |
| Shared GPU memory / paging | Not measured |

The offload plan reserves room for context/runtime memory; the model weights alone are 7,898,369,152 bytes. “39 layers on GPU” refers specifically to dense FFN placement, not a claim that all other tensors in those layers have the same placement. The sampled GPU peak includes the campaign's image-generation work; petshop uses separate SDXL weights. RSS is the harness's process metric, and whole-system RAM includes other applications. These maxima may occur in different trials and are not additive. Memory sampling can miss brief peaks.

CPU work is explicit planned offload. High system memory usage leaves little headroom, but does not prove paging, shared-GPU-memory spill, or a cause of the speed drops. The observed native endpoint/nonzero-exit episodes are a reliability concern even though no explicit CUDA OOM was logged.

## Speed and operational reliability

| Terminal-trial group | Trials | Median decode tokens/s | Median prefill tokens/s | Summed trial hours |
|---|---:|---:|---:|---:|
| Original | 85 | 8.46 | 381.48 | 62.69 |
| R3 continuation | 41 | 8.17 | 327.68 | 25.96 |
| Descriptive total | 126 | 8.35 | 369.47 | 88.64 |

These are unweighted medians of per-trial engine-derived rates, not a combined token-weighted benchmark. Decode ranged **2.57–9.41 tokens/s**; prefill ranged **118.45–644.34 tokens/s**. Median terminal-trial duration was **27.78 minutes**. Summed trial time excludes preflight, pauses between campaigns and incomplete attempts; it is not calendar wall time.

R3's first 16 trials had median decode **8.585 tokens/s**; the next 23 had **2.79 tokens/s**. The last two scored trials recovered to **8.42 and 8.36 tokens/s** without an operator tuning change. Their task durations were still approximately 151 and 94 minutes because of the amount of work and repair overhead. The cause of the slower phase remains unconfirmed. Preflight rates/settings are not substituted for actual task allocation.

There were **eight recovered endpoint/nonzero-exit episodes**: five in the original campaign, two in completed R3 trials, and one early in the final interrupted gate-script attempt. Each had subsequent native activity; they are separate from the two unexplained final process disappearances. A cleanup reason labelled memory-pressure is not by itself proof of GPU OOM. [Original native incident audit](scorecard-details.json); [Continuation checkpoint](scorecard-details.json); [Final interruption evidence](scorecard-details.json).

## Task quality: fixed passes and advisory judgment

Inline judging is separate from the deterministic rubric: **52 attempts have numeric scores on their declared axes, 59 are notApplicable because no axes were declared, and 17 are noArtifact**. Each produced declared artifact was reviewed within the 20 KiB cap. Different scenario axes are not pooled into an overall quality mean. A fixed 10 does not imply a polished or fully correct result; a fixed failure can include useful work. [Advisory ledger](scorecard-details.json).

- **Core:** R3 data-wrangle produced the exact 56-record result; symptom debugging and runbook anomaly handling also passed. The tank game passed its fixed gate at 10 but advisory review scored 4 after a final-life hit triggered an undefined-array access that would stop animation. This separates demonstrated basic interaction from edge-case correctness. [Data result](scorecard-details.json); [tank review](scorecard-details.json).
- **Productivity:** meeting follow-up, decks and document workflows produced useful outputs, with unsupported detail or arithmetic/formatting caveats in some artifacts. Constrained communications failed all three repetitions; the R3 text was only 92 words against a 140-word minimum. The spreadsheet attempt left 156 calculation cells blank. Wikipedia's mock tool bridge failed during startup, leaving required tools absent; the resulting brief nevertheless claimed unread source-card provenance. The frozen model/stall failure classification remains unchanged, with the framework contribution recorded alongside it. [Comms](scorecard-details.json); [spreadsheet](scorecard-details.json); [research brief](scorecard-details.json).
- **Developer:** R3 had real red-to-green TDD evidence (failing 80-versus-68 assertion, one-character fix, four passing tests), while several review/refactor tasks stalled without the requested deliverable. Codemod made seven genuine renames and ran three real tests, but its residual-scan claim was inaccurate and the required review was missing. Security review identified real issues, yet a repair was blocked by grounding treatment of an identifier. [TDD](scorecard-details.json); [codemod](scorecard-details.json); [security](scorecard-details.json).
- **Complex work:** parameterized regional reports contained correct distinct totals, and linear authoring produced a correct 29-record transformation. Export-generalize earned a fixed pass while Q2 clean.json remained a byte-for-byte copy of raw input, retaining 0 and −14 lead times; its gate proved workflow completion rather than reliable cleaning. The invoice attempt produced three correct invoices totalling 5415, but books were not updated and a framework-appended Sources section made the all-PASS review incompatible with a line-verdict gate. [Parameters](scorecard-details.json); [linear authoring](scorecard-details.json); [export audit](scorecard-details.json); [invoice audit](scorecard-details.json).

Custom-gate and fanout results deserve particular caution. Original gate-script passed without a successful custom-gate run. Original fanout version 1.2 genuinely spawned four children that completed their reports, but the grader passed on a different root invocation and the working parent remained at finish; two reports also added unsupported detail. That is evidence of child-task execution with orchestration and grading caveats. Interrupted fanout R2 produced accurate reports sequentially without children. Both entries have too little eligible coverage to claim three-trial reliability.

## Historical and cross-task comparisons

The last three available earlier scored trials were collected for each scenario, across models, with explicit environment labels. The historical Gemma examples below used **native 0.1.54**, whereas Saluki used 0.1.57; they are contextual observations, not a model ranking or controlled native comparison. The complete comparison index also covers interrupted gate-script and fanout. [Historical index](scorecard-details.json).

| Scenario | Earlier Gemma4 12B Q4 | Saluki R1 | Saluki R2 | Saluki R3 |
|---|---:|---:|---:|---:|
| tictactoe | [P 10.0](scorecard-details.json) | P 8.8 | P 8.8 | P 10.0 |
| data-wrangle | [F 3.4](scorecard-details.json) | F 3.0 | F 4.3 | P 10.0 |
| fix-squisq-bugs | [P 8.5](scorecard-details.json) | P 9.5 | P 10.0 | F 3.5 |
| craftbook-bug-fix-tdd | [F 5.5](scorecard-details.json) | P 8.5 | P 8.5 | P 8.5 |

Data-wrangle's recovery contrasts with the developer regressions; TDD remains stable while code review and large-PR review stall in R3. These unrelated scenarios argue against explaining every miss as a universal inability to load, use tools or write correct code. They also argue against treating one successful workflow as proof of broad competence. No new tuning was applied, so none of these comparisons establishes a tuning improvement.

## Follow-up experiments, not applied

1. **Make provenance compatible with structured outputs.** At the workspace/artifact write boundary and its grounding checks, retain source metadata outside strict verdict payloads and validate arithmetic/identifiers according to output type. Test invoice review, security review and unrelated numeric reporting. Measure false rejections without permitting unsupported claims.
2. **Validate saved scripts and make repair state explicit.** In `packages/service/src/fs/craftbook-store.ts` and `packages/script-runtime/src/compile.ts`, return syntax diagnostics before installation and expose the difference between an installed recipe and a task's captured version. Test custom gates and parameterized workflows; preserve task history rather than resetting it.
3. **Measure the hardware cause of throughput instability.** Repeat a fixed, diverse subset with power, clocks, dedicated/shared GPU memory and pagefile telemetry. Hold prompt, model, native binary and sampling constant. Only then A/B context allocation as a separately labelled experiment; do not retroactively change this 65,536-token baseline.
4. **Validate behavior beyond existence/completion.** Add general edge-case checks for generated interactive programs and semantic checks that distinguish a cleaned dataset from a copied input. Validate across unrelated games and data transformations, keeping all current fixed scores intact.

The immediate evidence supports improving tool contracts, repair feedback, semantic validation and observability before drawing a model ceiling conclusion. These are hypotheses for a future authorized run; no source, prompt, gate, sampling or model changes were made during reporting.

## Evidence integrity and deliverables

Original seal verification matched all seven sealed root files and all 85 original trial score/facts pairs. Reporting also hashed and rechecked the existing terminal results, scores, facts and postmortems plus campaign records. The new interrupted review is advisory only. The scorecard has all 129 planned-cell dispositions and 128 final attempt reviews. [Validation record](scorecard-details.json).

- [Model scorecard — every scenario and trial](scorecard-details.json)
- [Structured results and baseline identity](scorecard-details.json)
- [All inline advisory judgments](scorecard-details.json)
- [Historical comparisons](scorecard-details.json)

The recurring monitor was deleted after the final evidence review because no evaluation process remains. Full three-eligible-trial coverage has not been achieved.

