# Final paired analysis of the condensed run

The user curtailed the 516-trial plan after results existed. We close out 73 records, using 72 eligible matched trials (18 pairs per model, 16 distinct scenarios, one repetition). The one identity-flagged PowerPoint row stays excluded and unpaired. This is an exploratory chronological subset, not completion of the preregistered design.

Difference = MLX minus llama.cpp; user-selected equivalence margin ±5 percentage points.

| Model | MLX passes | llama.cpp passes | Difference pp | Conservative 95% interval pp | Scenario-cluster 95% interval pp | McNemar nominal / Holm | Verdict |
|---|---:|---:|---:|---|---|---|---|
| Gemma 4 12B Q4 | 16/18 | 18/18 | -11.11 | [-38.09, 20.66] | [-26.32, 0.00] | 0.50 / 1.00 | Inconclusive |
| Qwen 3.8 27B Q4 | 16/18 | 18/18 | -11.11 | [-38.09, 20.66] | [-26.32, 0.00] | 0.50 / 1.00 | Inconclusive |

Each model has 16 both-pass pairs, no both-fail pairs, no MLX-only passes and two llama.cpp-only passes. Neither interval lies inside ±5 pp. Non-significance does not establish equivalence, and the wide interval does not establish a true gap exceeding the margin.

## Assumptions and limits

- Outcome-visible chronological prefix; no random scenario sampling and no completed preregistered design.
- Difference is MLX minus llama.cpp; original user-selected margin remains +/-0.05.
- Conservative paired interval uses Bonferroni-combined 97.5% Clopper-Pearson intervals for each discordance direction. Its nominal coverage assumes independent paired observations; suite overlap violates strict independence.
- 50,000-replicate percentile bootstrap resamples distinct scenario IDs, retaining suite overlap; seed 20261103. Only 16 observed scenario clusters per model, so uncertainty about unseen tasks remains substantial.
- Exact nominal McNemar assumes exchangeable discordance directions under the null and independent discordant pairs. Holm corrects the two model p-values; neither p-value establishes equivalence.
- Both intervals would have to lie strictly within +/-5 pp; neither does. No claim that engines are equivalent or that the true gap exceeds 5 pp.
- Worst-case sensitivity assigns every unavailable original pair a difference of either -1 or +1. It is not a confidence interval.

## Missing evidence and sensitivity

Each original model plan contained 129 pairs. Only 18 are evaluable; 111 are unavailable. No missing outcome is counted as a model failure. Gemma’s PowerPoint pair contains one excluded identity-flagged pass and one unrun counterpart; all other unavailable cells were not run. Full reasons and pair identities are in [the JSON analysis](paired-analysis.json).

Assigning every unavailable original pair its most unfavorable or favorable possible engine difference gives [−87.60, +84.50] pp for both models. These bounds show how little this prefix can establish about the original full benchmark; they are not confidence intervals.

Within the 72-trial matched subset there are no exclusions. The Qwen productivity conflict-synthesis false-positive is retained as a failure, with its diagnosis in the final scorecard. No scores were changed and no additional trials were selected to obtain a favorable result.

[Final scorecard](report.md) · [Scope amendment](scope-amendment.md) · [Original analysis plan](analysis-plan.md) · [Judgments](judging.md)


Publication note: portable copy of the completed, user-curtailed report. Archive-only links open scorecard-details.json, which embeds trial facts, postmortems and review specifications. Publication-status statements describe the original closeout.
