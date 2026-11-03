---
title: November 3 M5 Max condensed engine comparison
runs:
  - 2026-11-03-m5max-fixed-paired
---

This follow-up compared Qwen 3.8 27B Q4 and Gemma 4 12B Q4 on MLX and
llama.cpp after fixes, using native 0.1.55 on an Apple M5 Max with 128 GB
of unified memory. The user shortened the original 516-trial plan for time.
The comparison contains **72 matched trials: 18 pairs per model, one
repetition**, across core and productivity. Developer and complex-work were
not run. This chronological subset was selected after outcomes were visible,
so the findings are exploratory.

Both models passed **16/18 on MLX and 18/18 on llama.cpp**. Practical
equivalence within the user-selected **±5 percentage points is not
established**. The observed difference is −11.11 pp; the conservative paired
95% interval is [−38.09, +20.66] pp and the scenario-cluster bootstrap interval
is [−26.32, 0.00] pp for each model. These data also do not establish that the
underlying gap exceeds 5 pp. The paired analysis documents assumptions,
unavailable original pairs, sensitivity and nominal/adjusted tests.

Median recorded decode was **34.00 tok/s on MLX versus 35.66 on llama.cpp
for Qwen**, and **59.00 versus 84.12 for Gemma**. Gemma's roughly 30% lower
MLX rate here does not reproduce the earlier twofold gap. These are complete
integration measurements with different estimators, quantizations and
speculative decoding, not an isolated engine benchmark or causal test of a fix.
Gemma MLX used a staged assistant drafter candidate; Gilde remained 0.3.5.

MLX prefill was recovered from first-token diagnostics: **121 rounded rate
observations in the 36 included MLX trials**. The medians of trial medians
are **604.75 tok/s for Qwen and 1332.25 for Gemma**. Tables mark these rates
as **observed**: they cover partial provider turns and are not equivalent to
llama.cpp's duration-weighted aggregate. Exact MLX prefill times remain unknown.
The download preserves all 126 observations across all 37 recorded MLX trials,
their source hashes and coverage limits.

All four recorded failures remain unchanged. The diagnoses identify an
image-tool workflow failure, unresolved duplicate data, a section-placement
failure, and a conflict-synthesis gate false-positive. The last unpaired
Gemma MLX PowerPoint trial passed its gate but encountered a fixture-identity
flag; it is excluded from the matched comparison and retained in downloads.
There are **25 artifact reviews**, including that excluded trial's review;
24 enter the displayed rubric means. The other 48 trials have no applicable
rubric. Fixed scores and advisory quality remain separate.

Download the [report](../../assets/scorecards/2026-11-03-m5max-fixed-paired/report.md),
[paired analysis](../../assets/scorecards/2026-11-03-m5max-fixed-paired/paired-analysis.md),
[performance CSV](../../assets/scorecards/2026-11-03-m5max-fixed-paired/performance.csv),
[performance data](../../assets/scorecards/2026-11-03-m5max-fixed-paired/performance.json),
[MLX prefill observations](../../assets/scorecards/2026-11-03-m5max-fixed-paired/mlx-prefill-recovery.json),
and [judge data](../../assets/scorecards/2026-11-03-m5max-fixed-paired/judging.json).
The [download index](../../assets/scorecards/2026-11-03-m5max-fixed-paired/README.md)
also links all 73 trial records, postmortems, provenance, verification and the
scope amendment. The earlier native-0.1.54 round remains a separate record.
