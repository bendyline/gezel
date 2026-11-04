# October 27 MLX prefill recovery

Recovered 2,175 rounded first-token prefill observations from all 258 MLX trials (129 per model). The original archive, fixed scores, exclusions, judgments and raw metrics are unchanged. No additional inference was run.

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

- Internal tool-loop requests, cancelled turns and event-stream gaps may be absent. Coverage of every request is not asserted.
- Only exact recorded duplicates can be detected; reconnect replay without stable event IDs cannot be identified.
- Time to first token includes other work and cannot substitute for prefill duration. Rounded rates and trial token totals cannot reconstruct exact durations.
- These observations must not be treated as the same estimator as llama.cpp aggregate prompt tokens divided by prompt-evaluation seconds.

The historical report marked MLX prefill unknown because its structured metrics had no rate. The recordings nevertheless retained first-token diagnostic text. This publication revision uses the same parser and method as the November 3 recovery. Only provider engine_phase generating events in the exact first-token format are read; generated model text is never treated as telemetry.

Each observation retains its recording line, receive timestamp, session ID and rate. [Recovery data](mlx-prefill-recovery.json) includes recording and original-metrics SHA-256 hashes; [trial summaries](mlx-prefill-recovery.csv) are also available. The [original report](original-report.md) and [completion audit](completion-audit.json) preserve the earlier checkpoint. The [updated report](report.md) and [scorecard](scorecard.json) add the recovered evidence separately.
