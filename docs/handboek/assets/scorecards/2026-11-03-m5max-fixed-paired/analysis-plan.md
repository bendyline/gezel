# Predeclared paired MLX / llama.cpp analysis

User selected an equivalence margin of ±5 percentage points on 2026-11-02 (America/Los_Angeles), before any new trial results. MLX minus llama.cpp is the signed difference. This campaign evaluates the integrated engines with their catalog quantizations; it cannot isolate engine code from quantization or speculation.

## Frozen design

Qwen3.8 27B Q4 and Gemma4 12B Q4, both engines, core/productivity/developer/complex-work, three repetitions per suite/scenario/target: expected 516 trials, 129 matched pairs per model. Rotate engine/model order using the existing campaign runner. Pair on model, suite, scenario and repetition. Keep generalist=auto, count-strict, required browser assertions, standard gates, authored timeouts and performance collection. No tuning during the campaign and no rerunning until a favorable p-value appears. Analysis code and scope are recorded before inference.

Use the current clean Gezel revision and rebuilt runtime. Installed Gilde 0.3.5 is unchanged. The campaign source overlay supplies each MLX target its own drafter: Qwen's installed drafter and the previously verified Gemma assistant candidate. Gemma's drafter is not yet part of the installed catalog; this is explicitly a validation of the fixed configuration. llama.cpp keeps its catalog MTP settings. Retain quantization and speculation differences in all reports.

## Primary pass-rate comparison

For each model, report paired sample size, both-pass/both-fail/MLX-only-pass/llama-only-pass counts, pass rates and their signed difference. Produce an exact conditional two-sided McNemar p-value from discordant pairs. Apply Holm correction across the two models. Treat this p-value as a nominal matched-trial analysis: repeated scenarios are not independent evidence about new tasks. A p-value above 0.05 does not prove equivalence.

Report a conservative 95% interval for the pass-rate difference: exact Clopper–Pearson 97.5% two-sided bounds for each directional discordant probability, then [lower(MLX-only)−upper(llama-only), upper(MLX-only)−lower(llama-only)]. Bonferroni coverage is conservative under the independent matched-trial model and gives nonzero uncertainty even with no discordances. Also report a 95% percentile cluster-bootstrap interval (50,000 replicates, seed 20261103), resampling distinct scenario IDs with all their suite appearances and repetitions intact, and computing the pair-weighted difference in each replicate. This cluster interval is approximate and examines sensitivity to task composition. A constant set of cluster differences does not establish zero uncertainty about unseen tasks; flag it explicitly.

Call the fixed-benchmark evidence compatible with practical equivalence only after all planned trials are resolved, the conservative paired interval lies strictly inside [−0.05,+0.05], and the cluster sensitivity interval does too. If cluster resampling is degenerate, limit any equivalence statement to the fixed benchmark and explicitly say generalization remains unestablished. Otherwise report a detected difference or inconclusive evidence; never replace those with “same performance.” This fixed sample can be too small to establish ±5 pp despite a small observed gap. The campaign has no adaptive expansion or early success stopping.

## Missing and excluded trials

Preserve every model failure in the denominator. Exclude only the runner's existing infrastructure/operator/grader ineligibility or comparison issue, with exact evidence and reasons. The primary paired analysis requires both eligible outcomes. List incomplete and excluded pairs separately. Do not infer failure from a missing result. Report worst-case bounds assigning unresolved/excluded pair outcomes both ways; any exclusion makes the headline conditional on evaluable pairs, with no unconditional equivalence claim. No silent retries, changed gates, failure reclassification or mixing older builds.

## Secondary results and quality

Suite comparisons are descriptive. Report fixed scores separately from blinded inline advisory quality, with exact scenario axes and 20 KiB artifact caps. Grade declared artifacts even on failed gates; missing outputs have no invented score. Require full judging reconciliation before final publication/reporting.

For each model/engine/suite report duration, first-token/tool/artifact latencies, actual in-trial decode/prefill rates, token usage, peak process RSS and system memory, including coverage and successful-only sensitivity. Missing telemetry is unknown; macOS GPU utilization is unavailable. Low-token admission probes are not performance estimates. Read logs for discordant outcomes and distinguish model errors from gate/harness/integration failures. Compare prior evidence only in labeled historical sections.

References: [Clopper–Pearson exact intervals](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats._result_classes.BinomTestResult.proportion_ci.html), [NIST McNemar test](https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/mcnemar.htm), [SciPy bootstrap documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html). Final conclusions are specific to this fixed task distribution and these model builds.


Publication note: portable copy of the completed, user-curtailed report. Archive-only links open scorecard-details.json, which embeds trial facts, postmortems and review specifications. Publication-status statements describe the original closeout.
