Publication review supplement: the advisory judgments in the original report below are Codex's. The independent [Sonnet 5.5 summary](sonnet-review-summary.md) supplies the publication's rubric-specific quality measurements; [all Sonnet reviews](judging-sonnet-5-5.json) and [trial evidence](scorecard-details.json) retain the details. Fixed scores are unchanged. Individual local evidence links open the evidence companion.

# Saluki 27B IQ2 Mix — model scorecard

**Final evidence report · native 0.1.57 · 11 November 2026. Execution ended before full coverage.**

Model: `underdog-saluki-27b-iq2-mix`; llama.cpp CUDA; RTX 5070 Ti Laptop, 12,227 MiB GPU memory and 31,865 MiB system RAM.

**Runs on this machine with hybrid GPU/CPU placement.** Actual tasks allocate 65,536 context tokens, one slot, f16 KV; 39/64 dense FFN layers on GPU and 25 on CPU. Observed peak GPU usage 10,654 MiB; process RSS 17,260 MiB; whole-system RAM 31,721 MiB. Median per-trial decode 8.35 tokens/s, with a sustained slower phase. This is not evidence of full GPU residency or reliable unattended completion.

## Coverage and fixed results

| Suite | Pass / eligible | Pass rate | Mean fixed score | Planned |
|---|---:|---:|---:|---:|
| Core | 30/33 | 90.9% | 8.85/10 | 33 |
| Productivity | 28/39 | 71.8% | 7.97/10 | 39 |
| Developer | 22/30 | 73.3% | 7.82/10 | 30 |
| Complex work | 18/23 | 78.3% | 7.58/10 | 27 |
| **Total** | **98/125** | **78.4%** | **8.09/10** | **129** |

126 runner-terminal trials comprise 98 passes, 27 eligible failures and one infrastructure exclusion. Two additional attempts were interrupted without scores, and one planned cell was never attempted. All 128 attempted cells have final advisory dispositions; 41 of 43 suite entries have three eligible trials. Gate-script and fanout each have only one. The four uncovered/excluded cells all belong to complex work.

Combined figures are a descriptive rollup across two preserved comparison baselines. They are not one uninterrupted controlled baseline.

| Suite | Original passes / eligible | Original mean | Continuation R3 passes / eligible | R3 mean |
|---|---:|---:|---:|---:|
| Core | 19/22 | 8.52 | 11/11 | 9.50 |
| Productivity | 20/26 | 8.18 | 8/13 | 7.55 |
| Developer | 19/20 | 8.85 | 3/10 | 5.76 |
| Complex work | 13/16 | 7.69 | 5/7 | 7.33 |
| **Total** | **71/84** | **8.33** | **27/41** | **7.60** |

The continuation adds only the explicit `GEZEL_MXC_EXEC` environment setting to the frozen comparison identity. Original scores are unchanged. Mean fixed axes across 125 eligible trials: completion 8.22, output quality 8.47, efficiency 6.10, behavior 9.72. Speed/memory are separate from the fixed rubric.

## Every suite entry

**P** = fixed pass, **F** = eligible fixed failure, **X** = infrastructure-excluded score, **I** = interrupted/unscored, **U** = unattempted. Numbers are fixed composites /10. R1 and R2 use the original baseline except interrupted R2 fanout; R3 uses the continuation. Score links open trial postmortems.

“Latest advisory” gives the last attempted trial's exact-axes mean, **N/A** for produced artifacts without declared axes, or **noArtifact**. It never changes the fixed score. Different scenarios declare different axes, so advisory means are not interchangeable.

### Core

| Scenario | R1 | R2 | R3 | Pass / eligible | Mean fixed | Latest advisory |
|---|---:|---:|---:|---:|---:|---|
| tictactoe | [P 8.8](scorecard-details.json) | [P 8.8](scorecard-details.json) | [P 10.0](scorecard-details.json) | 3/3 | 9.20 | 6.0/10 |
| petshop | [P 7.5](scorecard-details.json) | [P 7.0](scorecard-details.json) | [P 7.0](scorecard-details.json) | 3/3 | 7.17 | 5.5/10 |
| tankcombat | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | 3/3 | 10.00 | 4.0/10 |
| schema-migration | [P 9.5](scorecard-details.json) | [P 9.5](scorecard-details.json) | [P 9.5](scorecard-details.json) | 3/3 | 9.50 | N/A |
| failing-tests-spec | [P 9.5](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | 3/3 | 9.83 | N/A |
| symptom-debug | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | 3/3 | 10.00 | N/A |
| data-wrangle | [F 3.0](scorecard-details.json) | [F 4.3](scorecard-details.json) | [P 10.0](scorecard-details.json) | 1/3 | 5.77 | N/A |
| incident-postmortem | [F 3.5](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | 2/3 | 7.83 | N/A |
| ops-runbook-anomaly | [P 9.5](scorecard-details.json) | [P 9.5](scorecard-details.json) | [P 9.5](scorecard-details.json) | 3/3 | 9.50 | N/A |
| plan-and-estimate | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | 3/3 | 10.00 | N/A |
| conflict-synthesis | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | 3/3 | 8.50 | N/A |

### Productivity

| Scenario | R1 | R2 | R3 | Pass / eligible | Mean fixed | Latest advisory |
|---|---:|---:|---:|---:|---:|---|
| constrained-comms | [F 6.0](scorecard-details.json) | [F 6.0](scorecard-details.json) | [F 6.0](scorecard-details.json) | 0/3 | 6.00 | N/A |
| records-intake | [F 2.0](scorecard-details.json) | [P 8.5](scorecard-details.json) | [F 3.3](scorecard-details.json) | 1/3 | 4.60 | noArtifact |
| plan-and-estimate | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | 3/3 | 10.00 | N/A |
| meeting-followup | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | 3/3 | 10.00 | 7.5/10 |
| craftbook-spreadsheet-model | [F 4.5](scorecard-details.json) | [P 8.0](scorecard-details.json) | [F 4.9](scorecard-details.json) | 1/3 | 5.80 | 4.5/10 |
| conflict-synthesis | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 9.0](scorecard-details.json) | 3/3 | 9.67 | N/A |
| docblocks-theme-roundtrip | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | 3/3 | 10.00 | 5.0/10 |
| craftbook-powerpoint-deck | [F 4.6](scorecard-details.json) | [P 8.5](scorecard-details.json) | [P 8.0](scorecard-details.json) | 2/3 | 7.03 | 7.5/10 |
| wikipedia-research-brief | [F 3.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | [F 6.3](scorecard-details.json) | 1/3 | 6.43 | 3.0/10 |
| craftbook-week-plan | [P 9.0](scorecard-details.json) | [P 9.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | 3/3 | 9.00 | 6.3/10 |
| craftbook-ab-test-readout | [P 9.0](scorecard-details.json) | [P 8.0](scorecard-details.json) | [F 4.7](scorecard-details.json) | 2/3 | 7.23 | noArtifact |
| craftbook-annotated-bibliography | [P 9.5](scorecard-details.json) | [P 9.5](scorecard-details.json) | [P 9.0](scorecard-details.json) | 3/3 | 9.33 | 7.3/10 |
| craftbook-research-to-document | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | 3/3 | 8.50 | 7.3/10 |

### Developer

| Scenario | R1 | R2 | R3 | Pass / eligible | Mean fixed | Latest advisory |
|---|---:|---:|---:|---:|---:|---|
| fix-squisq-bugs | [P 9.5](scorecard-details.json) | [P 10.0](scorecard-details.json) | [F 3.5](scorecard-details.json) | 2/3 | 7.67 | noArtifact |
| dev-craftbook-routing | [P 8.8](scorecard-details.json) | [P 8.8](scorecard-details.json) | [P 8.8](scorecard-details.json) | 3/3 | 8.80 | N/A |
| interface-contract | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | [P 10.0](scorecard-details.json) | 3/3 | 10.00 | N/A |
| craftbook-code-review | [P 9.5](scorecard-details.json) | [P 10.0](scorecard-details.json) | [F 3.0](scorecard-details.json) | 2/3 | 7.50 | noArtifact |
| craftbook-api-contract-review | [P 9.0](scorecard-details.json) | [P 9.0](scorecard-details.json) | [F 4.5](scorecard-details.json) | 2/3 | 7.50 | noArtifact |
| craftbook-deep-security-review | [F 5.3](scorecard-details.json) | [P 9.0](scorecard-details.json) | [F 6.0](scorecard-details.json) | 1/3 | 6.77 | 5.3/10 |
| large-pr-review | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [F 3.5](scorecard-details.json) | 2/3 | 6.83 | noArtifact |
| craftbook-codemod-sweep | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [F 5.8](scorecard-details.json) | 2/3 | 7.60 | 6.3/10 |
| craftbook-refactor-module | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [F 4.0](scorecard-details.json) | 2/3 | 7.00 | noArtifact |
| craftbook-bug-fix-tdd | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | 3/3 | 8.50 | 8.0/10 |

### Complex work

| Scenario | R1 | R2 | R3 | Pass / eligible | Mean fixed | Latest advisory |
|---|---:|---:|---:|---:|---:|---|
| craftbook-find-vs-create | [P 8.8](scorecard-details.json) | [P 8.8](scorecard-details.json) | [P 8.8](scorecard-details.json) | 3/3 | 8.80 | N/A |
| craftbook-edit-midtask | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [F 3.5](scorecard-details.json) | 2/3 | 6.83 | noArtifact |
| craftbook-invoice-run | [F 5.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [F 5.5](scorecard-details.json) | 1/3 | 6.50 | 6.6/10 |
| craftbook-author-linear | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | 3/3 | 8.50 | N/A |
| craftbook-route-multi | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | 3/3 | 8.50 | N/A |
| craftbook-export-generalize | [F 2.4](scorecard-details.json) | [F 4.8](scorecard-details.json) | [P 8.0](scorecard-details.json) | 1/3 | 5.07 | N/A |
| craftbook-author-params | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | [P 8.5](scorecard-details.json) | 3/3 | 8.50 | N/A |
| craftbook-author-gate-script | [P 8.1](scorecard-details.json) | [X 5.2](scorecard-details.json) | [I](scorecard-details.json) | 1/1 | 8.10 | N/A |
| craftbook-author-fanout | [P 8.1](scorecard-details.json) | [I](scorecard-details.json) | U | 1/1 | 8.10 | N/A |

## How to use this scorecard

Fixed passing gates can miss substantive defects: the R3 tank game has a reproducible final-life crash, and export-generalize passes while its cleaned Q2 file still contains invalid source values. Conversely, an invoice review with correct invoices was blocked by framework-added Sources lines. Treat the scores as model × Gezel × evaluator observations, with advisory review alongside them.

52 attempts received numeric advisory scores, 59 produced artifacts with no declared axes, and 17 had no declared artifact. No synthetic score was assigned to the two interrupted trials or the unattempted cell.

[Full report](scorecard-details.json) · [Machine-readable scorecard](scorecard-details.json) · [All advisory reviews](scorecard-details.json) · [Historical comparisons](scorecard-details.json) · [Evidence validation](scorecard-details.json)

