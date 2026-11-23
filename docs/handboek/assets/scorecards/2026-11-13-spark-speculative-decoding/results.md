# Speculative decoding A/B: results

903 trials read, 0 excluded for running the wrong speculation mode.

| Arm | Trials | Passed | Pass % | Wall-clock stops | Speed-sensitive stops | Judged | Judge mean | Median gen t/s | Draft acceptance | Median trial min | Total h |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma4-12b-q4.mtp | 129 | 106 | 82.2 | 0 | 0 | 57 | 4.75 | 76.5 | 66.0 | 2.7 | 13.5 |
| gemma4-12b-q4.none | 129 | 103 | 79.8 | 0 | 0 | 57 | 4.72 | 28.7 | - | 4.6 | 20.4 |
| muse-glimmer-30b-q4.dflash | 129 | 121 | 93.8 | 1 | 1 | 57 | 5.64 | 34.1 | 59.2 | 6.8 | 33.9 |
| muse-glimmer-30b-q4.none | 129 | 113 | 87.6 | 1 | 3 | 56 | 5.63 | 11.8 | - | 15.6 | 47.9 |
| qwen3.8-27b-q4.dflash | 129 | 123 | 95.3 | 0 | 0 | 57 | 6.59 | 33.0 | 59.4 | 4.3 | 24.2 |
| qwen3.8-27b-q4.mtp | 129 | 123 | 95.3 | 0 | 0 | 57 | 6.50 | 29.1 | 60.4 | 5.1 | 31.1 |
| qwen3.8-27b-q4.none | 129 | 120 | 93.0 | 1 | 4 | 56 | 6.51 | 12.1 | - | 8.5 | 48.8 |

## Paired by scenario (A minus B, 95% bootstrap CI over scenarios)

| A | B | Scenarios | Pass-rate diff (pts) | CI | Judged scenarios | Judge diff | CI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.8-27b-q4.mtp | qwen3.8-27b-q4.none | 43 | 2.3 | [-3.1, 7.8] | 19 | -0.03 | [-0.25, 0.19] |
| qwen3.8-27b-q4.dflash | qwen3.8-27b-q4.none | 43 | 2.3 | [-3.1, 8.5] | 19 | 0.06 | [-0.19, 0.32] |
| qwen3.8-27b-q4.dflash | qwen3.8-27b-q4.mtp | 43 | 0.0 | [-3.1, 3.1] | 19 | 0.09 | [-0.11, 0.27] |
| gemma4-12b-q4.mtp | gemma4-12b-q4.none | 43 | 2.3 | [-3.9, 8.5] | 19 | 0.03 | [-0.10, 0.16] |
| muse-glimmer-30b-q4.dflash | muse-glimmer-30b-q4.none | 43 | 6.2 | [1.6, 11.6] | 19 | 0.02 | [-0.09, 0.13] |

## Sensitivity: pass-rate diff with speed-sensitive stops left out

Leaving out only failures favors the arm that had them, so read this as a bound, not an estimate.

| A | B | Pass-rate diff (pts) | CI |
| --- | --- | --- | --- |
| qwen3.8-27b-q4.mtp | qwen3.8-27b-q4.none | -0.8 | [-4.7, 3.1] |
| qwen3.8-27b-q4.dflash | qwen3.8-27b-q4.none | -0.8 | [-6.2, 4.7] |
| qwen3.8-27b-q4.dflash | qwen3.8-27b-q4.mtp | 0.0 | [-3.1, 3.1] |
| gemma4-12b-q4.mtp | gemma4-12b-q4.none | 2.3 | [-3.9, 8.5] |
| muse-glimmer-30b-q4.dflash | muse-glimmer-30b-q4.none | 5.0 | [0.4, 10.5] |

Speed-sensitive stops (hard ceiling, or a time-triggered stop that cut off a running turn):

- r1 qwen3.8-27b-q4.none developer/craftbook-deep-security-review: turn 476s old; craftbook-deep-security-review stale no-write repair loop: security-review/REPORT.md had u
- r2 muse-glimmer-30b-q4.dflash complex-work/craftbook-export-generalize: hard ceiling; hit hard ceiling (4800000ms + 80m progress extensions) — last hard progress 15s before the
- r2 muse-glimmer-30b-q4.none complex-work/craftbook-edit-midtask: hard ceiling; hit hard ceiling (2700000ms + 45m progress extensions) — last hard progress 67s before the
- r2 muse-glimmer-30b-q4.none developer/craftbook-codemod-sweep: turn 246s old; craftbook-codemod-sweep stale no-write repair loop: tasks/1/sites.md had unchanged content
- r2 qwen3.8-27b-q4.none developer/craftbook-codemod-sweep: turn 452s old; craftbook-codemod-sweep stale no-write repair loop: tasks/1/sites.md had unchanged content
- r3 muse-glimmer-30b-q4.none productivity/craftbook-powerpoint-deck: turn 242s old; craftbook-powerpoint-deck stale no-write repair loop: powerpoint/eval/deck.md had unchange
- r3 qwen3.8-27b-q4.none developer/craftbook-codemod-sweep: turn 245s old; craftbook-codemod-sweep stale no-write repair loop: tasks/1/sites.md had unchanged content
- r3 qwen3.8-27b-q4.none productivity/craftbook-spreadsheet-model: hard ceiling; hit hard ceiling (1800000ms + 30m progress extensions) — last hard progress 241s before th

## Scenarios whose pass count moved by 2 or more

- qwen3.8-27b-q4.mtp vs qwen3.8-27b-q4.none: developer/craftbook-codemod-sweep 3/3 vs 1/3
- qwen3.8-27b-q4.dflash vs qwen3.8-27b-q4.none: complex-work/craftbook-author-gate-script 3/3 vs 1/3; complex-work/craftbook-export-generalize 1/3 vs 3/3
- gemma4-12b-q4.mtp vs gemma4-12b-q4.none: complex-work/craftbook-export-generalize 2/3 vs 0/3; productivity/craftbook-ab-test-readout 0/3 vs 2/3
- muse-glimmer-30b-q4.dflash vs muse-glimmer-30b-q4.none: complex-work/craftbook-route-multi 3/3 vs 1/3; productivity/craftbook-powerpoint-deck 3/3 vs 1/3

## Failure modes by arm

- gemma4-12b-q4.mtp: {"chat-stalled":4,"model-stuck":19}
- gemma4-12b-q4.none: {"chat-stalled":3,"model-stuck":23}
- muse-glimmer-30b-q4.dflash: {"model-stuck":7,"timeout":1}
- muse-glimmer-30b-q4.none: {"model-stuck":12,"chat-stalled":3,"timeout":1}
- qwen3.8-27b-q4.dflash: {"model-stuck":6}
- qwen3.8-27b-q4.mtp: {"model-stuck":6}
- qwen3.8-27b-q4.none: {"model-stuck":8,"timeout":1}
